/** @flow */

import type {Alignment, CellSizeGetter, VisibleCellRange} from '../types';

type CellSizeAndPositionManagerParams = {
  cellCount: number,
  cellSizeGetter: CellSizeGetter,
  estimatedCellSize: number,
};

type ConfigureParams = {
  cellCount: number,
  estimatedCellSize: number,
  cellSizeGetter: CellSizeGetter,
};

type GetUpdatedOffsetForIndex = {
  align: Alignment,
  containerSize: number,
  currentOffset: number,
  targetIndex: number,
};

type GetVisibleCellRangeParams = {
  containerSize: number,
  offset: number,
};

type SizeAndPositionData = {
  offset: number,
  size: number,
};

const EMPTY_F64 = new Float64Array(0);
const MIN_CAPACITY = 256;

/**
 * Just-in-time calculates and caches size and position information for a collection of cells.
 *
 * Sizes and offsets live in two flat Float64Arrays instead of one
 * {offset, size} object per cell: the just-in-time fill writes
 * sequentially, searches read raw doubles with no property loads, and a
 * 100k-cell list costs two contiguous buffers instead of 100k heap objects.
 */
export default class CellSizeAndPositionManager {
  // Cell offsets/sizes by index. Values past _lastMeasuredIndex are garbage;
  // only rely on cells up to this._lastMeasuredIndex.
  _offsets: Float64Array = EMPTY_F64;
  _sizes: Float64Array = EMPTY_F64;
  _capacity = 0;

  // Point-resize support (see resizeCell): pending offset corrections are
  // held in a Fenwick (binary indexed) tree keyed by threshold cell index —
  // a correction with threshold t applies to the offsets of all cells with
  // index >= t. `_deltaRaw` mirrors the same corrections in flat per-
  // threshold form so a rebase folds them into `_offsets` in one O(n) pass.
  // While `_deltaCount` is 0 every offset read takes the original fast path.
  _deltaTree: Float64Array = EMPTY_F64;
  _deltaRaw: Float64Array = EMPTY_F64;
  _deltaCount = 0;

  // Measurements for cells up to this index can be trusted; cells afterward should be estimated.
  _lastMeasuredIndex = -1;

  // Used in deferred mode to track which cells have been queued for measurement.
  _lastBatchedIndex = -1;

  _cellCount: number;
  _cellSizeGetter: CellSizeGetter;
  _estimatedCellSize: number;

  constructor({
    cellCount,
    cellSizeGetter,
    estimatedCellSize,
  }: CellSizeAndPositionManagerParams) {
    this._cellSizeGetter = cellSizeGetter;
    this._cellCount = cellCount;
    this._estimatedCellSize = estimatedCellSize;
  }

  areOffsetsAdjusted() {
    return false;
  }

  configure({cellCount, estimatedCellSize, cellSizeGetter}: ConfigureParams) {
    this._cellCount = cellCount;
    this._estimatedCellSize = estimatedCellSize;
    this._cellSizeGetter = cellSizeGetter;
  }

  getCellCount(): number {
    return this._cellCount;
  }

  getEstimatedCellSize(): number {
    return this._estimatedCellSize;
  }

  getLastMeasuredIndex(): number {
    return this._lastMeasuredIndex;
  }

  getOffsetAdjustment() {
    return 0;
  }

  /**
   * This method returns the size and position for the cell at the specified index.
   * It just-in-time calculates (or used cached values) for cells leading up to the index.
   */
  getSizeAndPositionOfCell(index: number): SizeAndPositionData {
    if (index < 0 || index >= this._cellCount) {
      throw Error(
        `Requested index ${index} is outside of range 0..${this._cellCount}`,
      );
    }

    this._fill(index);

    return {
      offset: this._offsetOf(index),
      size: this._sizes[index],
    };
  }

  getSizeAndPositionOfLastMeasuredCell(): SizeAndPositionData {
    const last = this._lastMeasuredIndex;
    return last >= 0
      ? {
          offset: this._offsetOf(last),
          size: this._sizes[last],
        }
      : {
          offset: 0,
          size: 0,
        };
  }

  /**
   * Total size of all cells being measured.
   * This value will be completely estimated initially.
   * As cells are measured, the estimate will be updated.
   */
  getTotalSize(): number {
    const last = this._lastMeasuredIndex;
    const totalSizeOfMeasuredCells =
      last >= 0 ? this._offsetOf(last) + this._sizes[last] : 0;
    const numUnmeasuredCells = this._cellCount - last - 1;
    const totalSizeOfUnmeasuredCells =
      numUnmeasuredCells * this._estimatedCellSize;
    return totalSizeOfMeasuredCells + totalSizeOfUnmeasuredCells;
  }

  /**
   * Determines a new offset that ensures a certain cell is visible, given the current offset.
   * If the cell is already visible then the current offset will be returned.
   * If the current offset is too great or small, it will be adjusted just enough to ensure the specified index is visible.
   *
   * @param align Desired alignment within container; one of "auto" (default), "start", or "end"
   * @param containerSize Size (width or height) of the container viewport
   * @param currentOffset Container's current (x or y) offset
   * @param totalSize Total size (width or height) of all cells
   * @return Offset to use to ensure the specified cell is visible
   */
  getUpdatedOffsetForIndex({
    align = 'auto',
    containerSize,
    currentOffset,
    targetIndex,
  }: GetUpdatedOffsetForIndex): number {
    if (containerSize <= 0) {
      return 0;
    }

    const datum = this.getSizeAndPositionOfCell(targetIndex);
    const maxOffset = datum.offset;
    const minOffset = maxOffset - containerSize + datum.size;

    let idealOffset;

    switch (align) {
      case 'start':
        idealOffset = maxOffset;
        break;
      case 'end':
        idealOffset = minOffset;
        break;
      case 'center':
        idealOffset = maxOffset - (containerSize - datum.size) / 2;
        break;
      default:
        idealOffset = Math.max(minOffset, Math.min(maxOffset, currentOffset));
        break;
    }

    const totalSize = this.getTotalSize();

    return Math.max(0, Math.min(totalSize - containerSize, idealOffset));
  }

  getVisibleCellRange(params: GetVisibleCellRangeParams): VisibleCellRange {
    let {containerSize, offset} = params;

    const totalSize = this.getTotalSize();

    if (totalSize === 0) {
      return {};
    }

    const maxOffset = offset + containerSize;
    const start = this._findNearestCell(offset);

    this._probe(start);
    offset = this._offsetOf(start) + this._sizes[start];

    let stop = start;
    const stopLimit = this._cellCount - 1;

    while (offset < maxOffset && stop < stopLimit) {
      stop++;
      // _probe can reallocate the backing arrays, so read through `this`.
      this._probe(stop);
      offset += this._sizes[stop];
    }

    return {
      start,
      stop,
    };
  }

  /**
   * Clear all cached values for cells after the specified index.
   * This method should be called for any cell that has changed its size.
   * It will not immediately perform any calculations; they'll be performed the next time getSizeAndPositionOfCell() is called.
   */
  resetCell(index: number): void {
    if (this._deltaCount > 0) {
      this._rebase();
    }
    this._lastMeasuredIndex = Math.min(this._lastMeasuredIndex, index - 1);
  }

  /**
   * Point update: cell `index` changed size but every other cell kept its
   * identity (the CellMeasurer re-measure case). Re-asks the size getter
   * for that single cell and patches all downstream offsets in O(log n)
   * via the delta tree — unlike resetCell, which invalidates the whole
   * suffix and re-asks the getter for every later cell.
   *
   * Only valid when sizes are index-stable; for row/column insertions or
   * removals use resetCell.
   */
  resizeCell(index: number): void {
    if (index < 0 || index >= this._cellCount) {
      return;
    }
    if (index > this._lastMeasuredIndex) {
      // Not measured yet; the next lazy fill will ask the getter anyway.
      return;
    }

    let size = this._cellSizeGetter({index});

    if (size === undefined || isNaN(size)) {
      throw Error(`Invalid size returned for cell ${index} of value ${size}`);
    } else if (size === null) {
      size = 0;
      this._lastBatchedIndex = index;
    }

    const delta = size - this._sizes[index];
    if (delta === 0) {
      return;
    }
    this._sizes[index] = size;

    // Corrections apply to offsets of cells with index >= index + 1.
    const threshold = index + 1;
    const tree = this._deltaTree;
    const n = tree.length - 1;
    if (threshold <= n - 1) {
      this._deltaRaw[threshold] += delta;
      for (let j = threshold + 1; j <= n; j += j & -j) {
        tree[j] += delta;
      }
      this._deltaCount++;
    }
    // threshold beyond the last cell only affects total size, which reads
    // sizes[last] directly.
  }

  // Sum of pending corrections applying to cell `index`
  // (all thresholds <= index; tree position = threshold + 1).
  _deltaPrefix(index: number): number {
    const tree = this._deltaTree;
    let sum = 0;
    for (let j = index + 1; j > 0; j -= j & -j) {
      sum += tree[j];
    }
    return sum;
  }

  _offsetOf(index: number): number {
    const offset = this._offsets[index];
    return this._deltaCount === 0 ? offset : offset + this._deltaPrefix(index);
  }

  // Folds pending corrections into the absolute offsets (single O(n) pass
  // over the raw per-threshold deltas) and empties the tree. Runs lazily
  // before any structural change: a sequential fill extension or a
  // resetCell.
  _rebase(): void {
    const offsets = this._offsets;
    const raw = this._deltaRaw;
    const last = this._lastMeasuredIndex;

    let acc = 0;
    for (let i = 0; i <= last; i++) {
      acc += raw[i];
      offsets[i] += acc;
    }

    raw.fill(0);
    this._deltaTree.fill(0);
    this._deltaCount = 0;
  }

  /**
   * Just-in-time calculates offsets/sizes up to `index`, mirroring the
   * original lazy loop exactly: a `null` size (deferred CellMeasurer cell)
   * stores size 0 without advancing the running offset and records
   * `_lastBatchedIndex`; a numeric size advances `_lastMeasuredIndex` to
   * the requested target index.
   */
  _probe(index: number): void {
    if (index < 0 || index >= this._cellCount) {
      throw Error(
        `Requested index ${index} is outside of range 0..${this._cellCount}`,
      );
    }
    this._fill(index);
  }

  _fill(index: number): void {
    if (index <= this._lastMeasuredIndex) {
      return;
    }

    if (this._deltaCount > 0) {
      this._rebase();
    }

    this._ensureCapacity(index + 1);

    const offsets = this._offsets;
    const sizes = this._sizes;
    const last = this._lastMeasuredIndex;

    let offset = last >= 0 ? offsets[last] + sizes[last] : 0;

    for (var i = last + 1; i <= index; i++) {
      let size = this._cellSizeGetter({index: i});

      // undefined or NaN probably means a logic error in the size getter.
      // null means we're using CellMeasurer and haven't yet measured a given index.
      if (size === undefined || isNaN(size)) {
        throw Error(`Invalid size returned for cell ${i} of value ${size}`);
      } else if (size === null) {
        offsets[i] = offset;
        sizes[i] = 0;

        this._lastBatchedIndex = index;
      } else {
        offsets[i] = offset;
        sizes[i] = size;

        offset += size;

        this._lastMeasuredIndex = index;
      }
    }
  }

  _ensureCapacity(minCapacity: number): void {
    const capacity = this._capacity;
    if (minCapacity <= capacity) {
      return;
    }

    let newCapacity = capacity > 0 ? capacity << 1 : MIN_CAPACITY;
    if (newCapacity < minCapacity) {
      newCapacity = minCapacity;
    }

    const newOffsets = new Float64Array(newCapacity);
    const newSizes = new Float64Array(newCapacity);
    if (capacity > 0) {
      newOffsets.set(this._offsets);
      newSizes.set(this._sizes);
    }
    this._offsets = newOffsets;
    this._sizes = newSizes;
    // Growth only happens from _fill, which rebases first, so the delta
    // structures are guaranteed empty: fresh zeroed allocations suffice.
    this._deltaTree = new Float64Array(newCapacity + 2);
    this._deltaRaw = new Float64Array(newCapacity + 2);
    this._capacity = newCapacity;
  }

  _binarySearch(high: number, low: number, offset: number): number {
    while (low <= high) {
      const middle = low + ((high - low) >>> 1);
      // _probe can reallocate the backing arrays, so read through `this`.
      this._probe(middle);
      const currentOffset = this._offsetOf(middle);

      if (currentOffset === offset) {
        return middle;
      } else if (currentOffset < offset) {
        low = middle + 1;
      } else if (currentOffset > offset) {
        high = middle - 1;
      }
    }

    if (low > 0) {
      return low - 1;
    } else {
      return 0;
    }
  }

  _exponentialSearch(index: number, offset: number): number {
    let interval = 1;
    const cellCount = this._cellCount;

    while (index < cellCount) {
      this._probe(index);
      if (this._offsetOf(index) >= offset) {
        break;
      }
      index += interval;
      interval *= 2;
    }

    return this._binarySearch(
      Math.min(index, cellCount - 1),
      Math.floor(index / 2),
      offset,
    );
  }

  /**
   * Searches for the cell (index) nearest the specified offset.
   *
   * If no exact match is found the next lowest cell index will be returned.
   * This allows partially visible cells (with offsets just before/above the fold) to be visible.
   */
  _findNearestCell(offset: number): number {
    if (isNaN(offset)) {
      throw Error(`Invalid offset ${offset} specified`);
    }

    // Our search algorithms find the nearest match at or below the specified offset.
    // So make sure the offset is at least 0 or no match will be found.
    offset = Math.max(0, offset);

    const lastMeasuredOffset =
      this._lastMeasuredIndex >= 0
        ? this._offsetOf(this._lastMeasuredIndex)
        : 0;
    const lastMeasuredIndex = Math.max(0, this._lastMeasuredIndex);

    if (lastMeasuredOffset >= offset) {
      // If we've already measured cells within this range just use a binary search as it's faster.
      return this._binarySearch(lastMeasuredIndex, 0, offset);
    } else {
      // If we haven't yet measured this high, fallback to an exponential search with an inner binary search.
      // The exponential search avoids pre-computing sizes for the full set of cells as a binary search would.
      // The overall complexity for this approach is O(log n).
      return this._exponentialSearch(lastMeasuredIndex, offset);
    }
  }
}
