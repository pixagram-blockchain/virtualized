/** @flow */

import type {CellMeasureCache} from './types';

export const DEFAULT_HEIGHT = 30;
export const DEFAULT_WIDTH = 100;

// Enables more intelligent mapping of a given column and row index to an item ID.
// This prevents a cell cache from being invalidated when its parent collection is modified.
type KeyMapper = (rowIndex: number, columnIndex: number) => any;

type CellMeasurerCacheParams = {
  defaultHeight?: number,
  defaultWidth?: number,
  fixedHeight?: boolean,
  fixedWidth?: boolean,
  minHeight?: number,
  minWidth?: number,
  keyMapper?: KeyMapper,
};

type IndexParam = {
  index: number,
};

// Hard upper bound for flat TypedArray storage (rows * columns).
// Beyond this we fall back to Map-based storage to avoid pathological
// allocations for extremely sparse or extremely large index spaces.
const MAX_TYPED_CELLS = 1 << 22; // ~4.2M cells
const MIN_ROW_CAPACITY = 32;

const EMPTY_F64 = new Float64Array(0);
const EMPTY_U32 = new Uint32Array(0);
const EMPTY_U8 = new Uint8Array(0);

/**
 * Caches measurements for a given cell.
 *
 * Internally this implementation uses one of two storage strategies:
 *
 * 1. TypedArray storage (fast path, used with the default keyMapper):
 *    cell sizes live in flat Float64Arrays indexed by
 *    `rowIndex * columnCapacity + columnIndex`, with a Uint8Array bitmap
 *    tracking which cells have been measured. Derived row heights and
 *    column widths are maintained incrementally in O(1) per `set()`
 *    (instead of O(rowCount)/O(columnCount) as before), with a rescan
 *    only in the rare case that the previous maximum shrinks.
 *
 * 2. Map storage (compatibility path): used when a custom `keyMapper` is
 *    provided, when this class is subclassed (so overridden getters keep
 *    participating in derived-size computation), or when indices fall
 *    outside the bounds TypedArrays can reasonably handle. This path
 *    preserves the exact observable behavior of the original
 *    object-based implementation, including how often `keyMapper` is
 *    invoked, but uses Maps for faster lookups and deletes.
 */
export default class CellMeasurerCache implements CellMeasureCache {
  _defaultHeight: number;
  _defaultWidth: number;
  _minHeight: number;
  _minWidth: number;
  _keyMapper: KeyMapper;
  _hasFixedHeight: boolean;
  _hasFixedWidth: boolean;
  _columnCount = 0;
  _rowCount = 0;

  // --- TypedArray storage (default keyMapper fast path) ---
  _useTypedStorage: boolean;
  _rowCapacity = 0;
  _colCapacity = 0;
  // Interleaved cell payload: [width, height] pairs at slot << 1.
  // One array instead of two keeps a set/get pair on one cache line.
  _cellData: Float64Array = EMPTY_F64;
  // Presence bitset: slot i is measured when bit (i & 31) of word (i >>> 5)
  // is set.
  _cellFlagBits: Uint32Array = EMPTY_U32;
  // Per-column aggregates for derived :columnWidth (only when !fixedWidth)
  _colMax: Float64Array = EMPTY_F64;
  _colMeasured: Uint32Array = EMPTY_U32;
  _colDerived: Float64Array = EMPTY_F64;
  _colDerivedSet: Uint8Array = EMPTY_U8;
  // Per-row aggregates for derived :rowHeight (only when !fixedHeight)
  _rowMax: Float64Array = EMPTY_F64;
  _rowMeasured: Uint32Array = EMPTY_U32;
  _rowDerived: Float64Array = EMPTY_F64;
  _rowDerivedSet: Uint8Array = EMPTY_U8;

  // --- Map storage (custom keyMapper / subclass / overflow path) ---
  _cellHeightCache: Map<any, number> = new Map();
  _cellWidthCache: Map<any, number> = new Map();
  _columnWidthCache: Map<any, number> = new Map();
  _rowHeightCache: Map<any, number> = new Map();

  constructor(params: CellMeasurerCacheParams = {}) {
    const {
      defaultHeight,
      defaultWidth,
      fixedHeight,
      fixedWidth,
      keyMapper,
      minHeight,
      minWidth,
    } = params;

    this._hasFixedHeight = fixedHeight === true;
    this._hasFixedWidth = fixedWidth === true;
    this._minHeight = minHeight || 0;
    this._minWidth = minWidth || 0;
    this._keyMapper = keyMapper || defaultKeyMapper;

    // The TypedArray fast path bypasses this.getWidth()/this.getHeight()
    // when maintaining derived sizes, so it is only safe when those
    // methods are guaranteed to be the unmodified prototype methods.
    this._useTypedStorage =
      this._keyMapper === defaultKeyMapper &&
      this.constructor === CellMeasurerCache;

    this._defaultHeight = Math.max(
      this._minHeight,
      typeof defaultHeight === 'number' ? defaultHeight : DEFAULT_HEIGHT,
    );
    this._defaultWidth = Math.max(
      this._minWidth,
      typeof defaultWidth === 'number' ? defaultWidth : DEFAULT_WIDTH,
    );

    if (process.env.NODE_ENV !== 'production') {
      if (this._hasFixedHeight === false && this._hasFixedWidth === false) {
        console.warn(
          "CellMeasurerCache should only measure a cell's width or height. " +
            'You have configured CellMeasurerCache to measure both. ' +
            'This will result in poor performance.',
        );
      }

      if (this._hasFixedHeight === false && this._defaultHeight === 0) {
        console.warn(
          'Fixed height CellMeasurerCache should specify a :defaultHeight greater than 0. ' +
            'Failing to do so will lead to unnecessary layout and poor performance.',
        );
      }

      if (this._hasFixedWidth === false && this._defaultWidth === 0) {
        console.warn(
          'Fixed width CellMeasurerCache should specify a :defaultWidth greater than 0. ' +
            'Failing to do so will lead to unnecessary layout and poor performance.',
        );
      }
    }
  }

  clear(rowIndex: number, columnIndex: number = 0) {
    if (this._useTypedStorage && !this._canUseTypedIndices(rowIndex, columnIndex)) {
      this._demoteToMapStorage();
    }

    if (this._useTypedStorage) {
      if (!this._ensureCapacity(rowIndex + 1, columnIndex + 1)) {
        // Could not grow within bounds; fall back.
        this._demoteToMapStorage();
        this._clearFromMap(rowIndex, columnIndex);
        return;
      }

      const i = rowIndex * this._colCapacity + columnIndex;
      const flagBits = this._cellFlagBits;
      const wasSet = ((flagBits[i >>> 5] >>> (i & 31)) & 1) === 1;
      const oldWidth = this._cellData[i << 1];
      const oldHeight = this._cellData[(i << 1) | 1];

      if (wasSet) {
        flagBits[i >>> 5] &= ~(1 << (i & 31));
        if (!this._hasFixedWidth) {
          this._colMeasured[columnIndex]--;
          const oldClamped = Math.max(this._minWidth, oldWidth);
          if (oldClamped >= this._colMax[columnIndex]) {
            this._rescanColumnMax(columnIndex);
          }
        }
        if (!this._hasFixedHeight) {
          this._rowMeasured[rowIndex]--;
          const oldClamped = Math.max(this._minHeight, oldHeight);
          if (oldClamped >= this._rowMax[rowIndex]) {
            this._rescanRowMax(rowIndex);
          }
        }
      }

      // The original implementation always refreshed the derived caches
      // after a clear (even for never-measured cells), so we do too.
      this._writeDerivedColumn(columnIndex);
      this._writeDerivedRow(rowIndex);
      return;
    }

    this._clearFromMap(rowIndex, columnIndex);
  }

  clearAll() {
    this._cellHeightCache = new Map();
    this._cellWidthCache = new Map();
    this._columnWidthCache = new Map();
    this._rowHeightCache = new Map();

    this._rowCapacity = 0;
    this._colCapacity = 0;
    this._cellData = EMPTY_F64;
    this._cellFlagBits = EMPTY_U32;
    this._colMax = EMPTY_F64;
    this._colMeasured = EMPTY_U32;
    this._colDerived = EMPTY_F64;
    this._colDerivedSet = EMPTY_U8;
    this._rowMax = EMPTY_F64;
    this._rowMeasured = EMPTY_U32;
    this._rowDerived = EMPTY_F64;
    this._rowDerivedSet = EMPTY_U8;

    // A cache demoted because of out-of-range indices can safely try the
    // fast path again once everything has been thrown away.
    this._useTypedStorage =
      this._keyMapper === defaultKeyMapper &&
      this.constructor === CellMeasurerCache;

    this._rowCount = 0;
    this._columnCount = 0;
  }

  columnWidth = ({index}: IndexParam) => {
    if (this._useTypedStorage) {
      if (
        typeof index === 'number' &&
        index >= 0 &&
        index < this._colCapacity &&
        Number.isInteger(index) &&
        this._colDerivedSet[index] === 1
      ) {
        return this._colDerived[index];
      }
      return this._defaultWidth;
    }

    const key = this._keyMapper(0, index);
    const value = this._columnWidthCache.get(key);

    return value !== undefined ? value : this._defaultWidth;
  };

  get defaultHeight(): number {
    return this._defaultHeight;
  }

  get defaultWidth(): number {
    return this._defaultWidth;
  }

  hasFixedHeight(): boolean {
    return this._hasFixedHeight;
  }

  hasFixedWidth(): boolean {
    return this._hasFixedWidth;
  }

  getHeight(rowIndex: number, columnIndex: number = 0): number {
    if (this._hasFixedHeight) {
      return this._defaultHeight;
    }

    if (this._useTypedStorage) {
      if (this._isMeasuredTyped(rowIndex, columnIndex)) {
        const height = this._cellData[
          ((rowIndex * this._colCapacity + columnIndex) << 1) | 1
        ];
        return Math.max(this._minHeight, height);
      }
      return this._defaultHeight;
    }

    const key = this._keyMapper(rowIndex, columnIndex);
    const height = this._cellHeightCache.get(key);

    return height !== undefined
      ? Math.max(this._minHeight, height)
      : this._defaultHeight;
  }

  getWidth(rowIndex: number, columnIndex: number = 0): number {
    if (this._hasFixedWidth) {
      return this._defaultWidth;
    }

    if (this._useTypedStorage) {
      if (this._isMeasuredTyped(rowIndex, columnIndex)) {
        const width = this._cellData[
          (rowIndex * this._colCapacity + columnIndex) << 1
        ];
        return Math.max(this._minWidth, width);
      }
      return this._defaultWidth;
    }

    const key = this._keyMapper(rowIndex, columnIndex);
    const width = this._cellWidthCache.get(key);

    return width !== undefined
      ? Math.max(this._minWidth, width)
      : this._defaultWidth;
  }

  has(rowIndex: number, columnIndex: number = 0): boolean {
    if (this._useTypedStorage) {
      return this._isMeasuredTyped(rowIndex, columnIndex);
    }

    const key = this._keyMapper(rowIndex, columnIndex);

    return this._cellHeightCache.has(key);
  }

  rowHeight = ({index}: IndexParam) => {
    if (this._useTypedStorage) {
      if (
        typeof index === 'number' &&
        index >= 0 &&
        index < this._rowCapacity &&
        Number.isInteger(index) &&
        this._rowDerivedSet[index] === 1
      ) {
        return this._rowDerived[index];
      }
      return this._defaultHeight;
    }

    const key = this._keyMapper(index, 0);
    const value = this._rowHeightCache.get(key);

    return value !== undefined ? value : this._defaultHeight;
  };

  set(
    rowIndex: number,
    columnIndex: number,
    width: number,
    height: number,
  ): void {
    if (this._useTypedStorage && !this._canUseTypedIndices(rowIndex, columnIndex)) {
      this._demoteToMapStorage();
    }

    if (this._useTypedStorage) {
      if (!this._ensureCapacity(rowIndex + 1, columnIndex + 1)) {
        this._demoteToMapStorage();
        this._setInMap(rowIndex, columnIndex, width, height);
        return;
      }

      if (columnIndex >= this._columnCount) {
        this._columnCount = columnIndex + 1;
      }
      if (rowIndex >= this._rowCount) {
        this._rowCount = rowIndex + 1;
      }

      const i = rowIndex * this._colCapacity + columnIndex;
      const data = this._cellData;
      const flagBits = this._cellFlagBits;
      const wasSet = ((flagBits[i >>> 5] >>> (i & 31)) & 1) === 1;
      const oldWidth = data[i << 1];
      const oldHeight = data[(i << 1) | 1];

      data[i << 1] = width;
      data[(i << 1) | 1] = height;
      flagBits[i >>> 5] |= 1 << (i & 31);

      if (!this._hasFixedWidth) {
        if (!wasSet) {
          this._colMeasured[columnIndex]++;
        }
        const newClamped = Math.max(this._minWidth, width);
        if (newClamped >= this._colMax[columnIndex]) {
          this._colMax[columnIndex] = newClamped;
        } else if (wasSet) {
          const oldClamped = Math.max(this._minWidth, oldWidth);
          if (oldClamped >= this._colMax[columnIndex]) {
            // We may have just overwritten the previous maximum with a
            // smaller value; rescan the column to find the new maximum.
            this._rescanColumnMax(columnIndex);
          }
        }
        this._writeDerivedColumn(columnIndex);
      }

      if (!this._hasFixedHeight) {
        if (!wasSet) {
          this._rowMeasured[rowIndex]++;
        }
        const newClamped = Math.max(this._minHeight, height);
        if (newClamped >= this._rowMax[rowIndex]) {
          this._rowMax[rowIndex] = newClamped;
        } else if (wasSet) {
          const oldClamped = Math.max(this._minHeight, oldHeight);
          if (oldClamped >= this._rowMax[rowIndex]) {
            this._rescanRowMax(rowIndex);
          }
        }
        this._writeDerivedRow(rowIndex);
      }
      return;
    }

    this._setInMap(rowIndex, columnIndex, width, height);
  }

  // ---------------------------------------------------------------------
  // TypedArray storage internals
  // ---------------------------------------------------------------------

  _canUseTypedIndices(rowIndex: number, columnIndex: number): boolean {
    return (
      Number.isInteger(rowIndex) &&
      rowIndex >= 0 &&
      Number.isInteger(columnIndex) &&
      columnIndex >= 0
    );
  }

  _isMeasuredTyped(rowIndex: number, columnIndex: number): boolean {
    if (
      rowIndex < 0 ||
      columnIndex < 0 ||
      rowIndex >= this._rowCapacity ||
      columnIndex >= this._colCapacity
    ) {
      return false;
    }
    const i = rowIndex * this._colCapacity + columnIndex;
    return ((this._cellFlagBits[i >>> 5] >>> (i & 31)) & 1) === 1;
  }

  // Grows the flat cell storage so it can hold at least neededRows x neededCols.
  // Returns false when growing would exceed MAX_TYPED_CELLS.
  _ensureCapacity(neededRows: number, neededCols: number): boolean {
    const rowCapacity = this._rowCapacity;
    const colCapacity = this._colCapacity;

    if (neededRows <= rowCapacity && neededCols <= colCapacity) {
      return true;
    }

    let newRowCapacity = rowCapacity;
    let newColCapacity = colCapacity;

    if (neededRows > newRowCapacity) {
      newRowCapacity = Math.max(neededRows, rowCapacity * 2, MIN_ROW_CAPACITY);
    }
    if (neededCols > newColCapacity) {
      newColCapacity = Math.max(neededCols, colCapacity * 2, 1);
    }

    if (newRowCapacity * newColCapacity > MAX_TYPED_CELLS) {
      return false;
    }

    const newSlots = newRowCapacity * newColCapacity;
    const newData = new Float64Array(newSlots << 1);
    const newFlagBits = new Uint32Array((newSlots + 31) >>> 5);

    if (rowCapacity > 0) {
      if (newColCapacity === colCapacity) {
        // Row-only growth: slot indices are unchanged, so the payload and
        // the flag words copy contiguously.
        newData.set(this._cellData);
        newFlagBits.set(this._cellFlagBits);
      } else {
        // Column growth requires re-laying out each used row.
        const oldData = this._cellData;
        const oldFlagBits = this._cellFlagBits;
        const usedRows = Math.min(this._rowCount, rowCapacity);
        for (let r = 0; r < usedRows; r++) {
          const from = r * colCapacity;
          const to = r * newColCapacity;
          newData.set(
            oldData.subarray(from << 1, (from + colCapacity) << 1),
            to << 1,
          );
          for (let c = 0; c < colCapacity; c++) {
            const oi = from + c;
            if ((oldFlagBits[oi >>> 5] >>> (oi & 31)) & 1) {
              const ni = to + c;
              newFlagBits[ni >>> 5] |= 1 << (ni & 31);
            }
          }
        }
      }
    }

    this._cellData = newData;
    this._cellFlagBits = newFlagBits;

    if (newColCapacity !== colCapacity) {
      this._colMax = growF64(this._colMax, newColCapacity);
      this._colMeasured = growU32(this._colMeasured, newColCapacity);
      this._colDerived = growF64(this._colDerived, newColCapacity);
      this._colDerivedSet = growU8(this._colDerivedSet, newColCapacity);
    }
    if (newRowCapacity !== rowCapacity) {
      this._rowMax = growF64(this._rowMax, newRowCapacity);
      this._rowMeasured = growU32(this._rowMeasured, newRowCapacity);
      this._rowDerived = growF64(this._rowDerived, newRowCapacity);
      this._rowDerivedSet = growU8(this._rowDerivedSet, newRowCapacity);
    }

    this._rowCapacity = newRowCapacity;
    this._colCapacity = newColCapacity;

    return true;
  }

  _rescanColumnMax(columnIndex: number) {
    const colCapacity = this._colCapacity;
    const flagBits = this._cellFlagBits;
    const data = this._cellData;
    const minWidth = this._minWidth;
    const rowCount = this._rowCount;

    let max = 0;
    for (let r = 0, i = columnIndex; r < rowCount; r++, i += colCapacity) {
      if ((flagBits[i >>> 5] >>> (i & 31)) & 1) {
        const clamped = Math.max(minWidth, data[i << 1]);
        if (clamped > max) {
          max = clamped;
        }
      }
    }
    this._colMax[columnIndex] = max;
  }

  _rescanRowMax(rowIndex: number) {
    const flagBits = this._cellFlagBits;
    const data = this._cellData;
    const minHeight = this._minHeight;
    const columnCount = this._columnCount;
    const base = rowIndex * this._colCapacity;

    let max = 0;
    for (let c = 0; c < columnCount; c++) {
      const i = base + c;
      if ((flagBits[i >>> 5] >>> (i & 31)) & 1) {
        const clamped = Math.max(minHeight, data[(i << 1) | 1]);
        if (clamped > max) {
          max = clamped;
        }
      }
    }
    this._rowMax[rowIndex] = max;
  }

  // Derived :columnWidth equals the maximum of getWidth() across all rows
  // (0.._rowCount). Unmeasured cells contribute :defaultWidth, so the
  // default participates whenever at least one row in range is unmeasured.
  _writeDerivedColumn(columnIndex: number) {
    if (this._hasFixedWidth) {
      return;
    }
    const max = this._colMax[columnIndex];
    this._colDerived[columnIndex] =
      this._colMeasured[columnIndex] < this._rowCount
        ? Math.max(this._defaultWidth, max)
        : max;
    this._colDerivedSet[columnIndex] = 1;
  }

  _writeDerivedRow(rowIndex: number) {
    if (this._hasFixedHeight) {
      return;
    }
    const max = this._rowMax[rowIndex];
    this._rowDerived[rowIndex] =
      this._rowMeasured[rowIndex] < this._columnCount
        ? Math.max(this._defaultHeight, max)
        : max;
    this._rowDerivedSet[rowIndex] = 1;
  }

  // Migrates all TypedArray-resident state into the Map-based storage.
  // Called when indices are encountered that the flat layout cannot
  // represent (negative, fractional, or beyond MAX_TYPED_CELLS).
  _demoteToMapStorage() {
    if (!this._useTypedStorage) {
      return;
    }

    const colCapacity = this._colCapacity;

    for (let r = 0; r < this._rowCount; r++) {
      for (let c = 0; c < this._columnCount; c++) {
        const i = r * colCapacity + c;
        if ((this._cellFlagBits[i >>> 5] >>> (i & 31)) & 1) {
          const key = this._keyMapper(r, c);
          this._cellHeightCache.set(key, this._cellData[(i << 1) | 1]);
          this._cellWidthCache.set(key, this._cellData[i << 1]);
        }
      }
    }
    for (let c = 0; c < colCapacity; c++) {
      if (this._colDerivedSet[c] === 1) {
        this._columnWidthCache.set(this._keyMapper(0, c), this._colDerived[c]);
      }
    }
    for (let r = 0; r < this._rowCapacity; r++) {
      if (this._rowDerivedSet[r] === 1) {
        this._rowHeightCache.set(this._keyMapper(r, 0), this._rowDerived[r]);
      }
    }

    this._rowCapacity = 0;
    this._colCapacity = 0;
    this._cellData = EMPTY_F64;
    this._cellFlagBits = EMPTY_U32;
    this._colMax = EMPTY_F64;
    this._colMeasured = EMPTY_U32;
    this._colDerived = EMPTY_F64;
    this._colDerivedSet = EMPTY_U8;
    this._rowMax = EMPTY_F64;
    this._rowMeasured = EMPTY_U32;
    this._rowDerived = EMPTY_F64;
    this._rowDerivedSet = EMPTY_U8;

    this._useTypedStorage = false;
  }

  // ---------------------------------------------------------------------
  // Map storage internals (compatibility path)
  // ---------------------------------------------------------------------

  _clearFromMap(rowIndex: number, columnIndex: number) {
    const key = this._keyMapper(rowIndex, columnIndex);

    this._cellHeightCache.delete(key);
    this._cellWidthCache.delete(key);

    this._updateCachedColumnAndRowSizes(rowIndex, columnIndex);
  }

  _setInMap(
    rowIndex: number,
    columnIndex: number,
    width: number,
    height: number,
  ) {
    const key = this._keyMapper(rowIndex, columnIndex);

    if (columnIndex >= this._columnCount) {
      this._columnCount = columnIndex + 1;
    }
    if (rowIndex >= this._rowCount) {
      this._rowCount = rowIndex + 1;
    }

    // Size is cached per cell so we don't have to re-measure if cells are re-ordered.
    this._cellHeightCache.set(key, height);
    this._cellWidthCache.set(key, width);

    this._updateCachedColumnAndRowSizes(rowIndex, columnIndex);
  }

  _updateCachedColumnAndRowSizes(rowIndex: number, columnIndex: number) {
    // :columnWidth and :rowHeight are derived based on all cells in a column/row.
    // Pre-cache these derived values for faster lookup later.
    // Reads are expected to occur more frequently than writes in this case.
    // Only update non-fixed dimensions though to avoid doing unnecessary work.
    // Note: this intentionally routes through this.getWidth()/this.getHeight()
    // so that subclasses overriding those methods keep affecting derived sizes.
    if (!this._hasFixedWidth) {
      let columnWidth = 0;
      for (let i = 0; i < this._rowCount; i++) {
        columnWidth = Math.max(columnWidth, this.getWidth(i, columnIndex));
      }
      const columnKey = this._keyMapper(0, columnIndex);
      this._columnWidthCache.set(columnKey, columnWidth);
    }
    if (!this._hasFixedHeight) {
      let rowHeight = 0;
      for (let i = 0; i < this._columnCount; i++) {
        rowHeight = Math.max(rowHeight, this.getHeight(rowIndex, i));
      }
      const rowKey = this._keyMapper(rowIndex, 0);
      this._rowHeightCache.set(rowKey, rowHeight);
    }
  }
}

function defaultKeyMapper(rowIndex: number, columnIndex: number) {
  return `${rowIndex}-${columnIndex}`;
}

function growF64(array: Float64Array, capacity: number): Float64Array {
  const next = new Float64Array(capacity);
  next.set(array);
  return next;
}

function growU32(array: Uint32Array, capacity: number): Uint32Array {
  const next = new Uint32Array(capacity);
  next.set(array);
  return next;
}

function growU8(array: Uint8Array, capacity: number): Uint8Array {
  const next = new Uint8Array(capacity);
  next.set(array);
  return next;
}
