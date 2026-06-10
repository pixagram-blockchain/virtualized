/** @flow */

type RenderCallback = (index: number, left: number, top: number) => void;

const EMPTY_F64 = new Float64Array(0);
const EMPTY_U32 = new Uint32Array(0);
const EMPTY_U8 = new Uint8Array(0);

const MIN_CAPACITY = 64;

// Position cache requirements:
//   O(log(n) + k) lookup of cells to render for a given viewport size
//   O(1) lookup of shortest measured column (so we know when to enter phase 1)
//
// This implementation replaces the previous interval tree with flat
// TypedArrays:
//
//   - `_tops` / `_lefts` / `_heights` store each cell's geometry, indexed
//     directly by cell index (cells arrive mostly sequentially).
//   - `_order` keeps cell indices sorted by their `top` coordinate. Masonry
//     layouts grow downward, so insertions are almost always appends and the
//     occasional out-of-order insert is a single `copyWithin` (memmove).
//   - Range queries binary-search `_order` and scan the narrow band of cells
//     whose tops fall within `[lo - maxCellHeight, hi]`; any intersecting
//     cell must start in that window. The scan is a contiguous, branch-light
//     walk over typed memory instead of pointer chasing through tree nodes.
//
// Unlike the interval tree (which silently accumulated duplicate entries if
// the same index was positioned twice), `setPosition` now overwrites the
// previous position for an index. This avoids duplicate render callbacks
// (and duplicate React keys) when a range is re-populated.
export default class PositionCache {
  _capacity = 0;
  _count = 0;

  _tops: Float64Array = EMPTY_F64;
  _lefts: Float64Array = EMPTY_F64;
  _heights: Float64Array = EMPTY_F64;
  _flags: Uint8Array = EMPTY_U8;

  // Cell indices sorted by ascending `top`; only the first `_count`
  // entries are meaningful.
  _order: Uint32Array = EMPTY_U32;

  // Upper bound for the height of any cell ever inserted; used to bound
  // the candidate band during range queries.
  _maxCellHeight = 0;

  // Tracks the bottom edge of each column. Parallel arrays beat a Map for
  // realistic column counts (a handful): the lookup is a short linear scan
  // over a Float64Array instead of a hash on every insert.
  _colLefts: Float64Array = new Float64Array(8);
  _colBottoms: Float64Array = new Float64Array(8);
  _colCount = 0;

  // Cached column metrics, recomputed lazily.
  _columnMetricsDirty = false;
  _shortestColumnSize = 0;
  _tallestColumnSize = 0;

  estimateTotalHeight(
    cellCount: number,
    columnCount: number,
    defaultCellHeight: number,
  ): number {
    const unmeasuredCellCount = cellCount - this._count;
    return (
      this.tallestColumnSize +
      Math.ceil(unmeasuredCellCount / columnCount) * defaultCellHeight
    );
  }

  // Render all cells visible within the viewport range defined.
  // Cells are reported in ascending order of their `top` coordinate.
  range(
    scrollTop: number,
    clientHeight: number,
    renderCallback: RenderCallback,
  ): void {
    const count = this._count;
    const hi = scrollTop + clientHeight;

    if (count === 0 || scrollTop > hi) {
      return;
    }

    const order = this._order;
    const tops = this._tops;
    const lefts = this._lefts;
    const heights = this._heights;

    // First cell whose top could still produce an intersection:
    // any intersecting cell satisfies top >= lo - maxCellHeight.
    const minTop = scrollTop - this._maxCellHeight;

    // Lower bound binary search over `order` by top.
    let low = 0;
    let high = count;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (tops[order[mid]] < minTop) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    for (let k = low; k < count; k++) {
      const index = order[k];
      const top = tops[index];

      if (top > hi) {
        break;
      }

      if (top + heights[index] >= scrollTop) {
        renderCallback(index, lefts[index], top);
      }
    }
  }

  setPosition(index: number, left: number, top: number, height: number): void {
    this._ensureCapacity(index + 1);

    const tops = this._tops;
    const order = this._order;
    const wasSet = this._flags[index] === 1;

    if (wasSet) {
      // Overwrite: remove the stale entry from the sorted order first.
      const oldTop = tops[index];
      const oldPos = this._findOrderPosition(index, oldTop);
      if (oldPos !== -1) {
        order.copyWithin(oldPos, oldPos + 1, this._count);
        this._count--;
      }
    }

    tops[index] = top;
    this._lefts[index] = left;
    this._heights[index] = height;
    this._flags[index] = 1;

    if (height > this._maxCellHeight) {
      this._maxCellHeight = height;
    }

    // Insert `index` into `order`, keeping it sorted by top (upper bound,
    // so equal tops preserve insertion order). Masonry grows downward, so
    // this is nearly always an append.
    const count = this._count;
    if (count === 0 || tops[order[count - 1]] <= top) {
      order[count] = index;
    } else {
      let low = 0;
      let high = count;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (tops[order[mid]] <= top) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      order.copyWithin(low + 1, low, count);
      order[low] = index;
    }
    this._count = count + 1;

    const bottom = top + height;
    const colLefts = this._colLefts;
    const colCount = this._colCount;
    let c = 0;
    for (; c < colCount; c++) {
      if (colLefts[c] === left) {
        break;
      }
    }
    if (c === colCount) {
      if (colCount === colLefts.length) {
        const nextLefts = new Float64Array(colCount << 1);
        const nextBottoms = new Float64Array(colCount << 1);
        nextLefts.set(colLefts);
        nextBottoms.set(this._colBottoms);
        this._colLefts = nextLefts;
        this._colBottoms = nextBottoms;
      }
      this._colLefts[c] = left;
      this._colBottoms[c] = bottom;
      this._colCount = colCount + 1;
    } else if (bottom > this._colBottoms[c]) {
      this._colBottoms[c] = bottom;
    }
    this._columnMetricsDirty = true;
  }

  get count(): number {
    return this._count;
  }

  get shortestColumnSize(): number {
    if (this._columnMetricsDirty) {
      this._recomputeColumnMetrics();
    }
    return this._shortestColumnSize;
  }

  get tallestColumnSize(): number {
    if (this._columnMetricsDirty) {
      this._recomputeColumnMetrics();
    }
    return this._tallestColumnSize;
  }

  _recomputeColumnMetrics() {
    let shortest = 0;
    let tallest = 0;

    const colBottoms = this._colBottoms;
    const colCount = this._colCount;
    for (let i = 0; i < colCount; i++) {
      const height = colBottoms[i];
      shortest = shortest === 0 ? height : Math.min(shortest, height);
      tallest = Math.max(tallest, height);
    }

    this._shortestColumnSize = shortest;
    this._tallestColumnSize = tallest;
    this._columnMetricsDirty = false;
  }

  // Locates `index` inside the sorted `_order` array given its current top.
  // Binary-searches to the run of equal tops, then scans it.
  _findOrderPosition(index: number, top: number): number {
    const order = this._order;
    const tops = this._tops;
    const count = this._count;

    // Lower bound of the run of entries with this top.
    let low = 0;
    let high = count;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (tops[order[mid]] < top) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    for (let k = low; k < count && tops[order[k]] === top; k++) {
      if (order[k] === index) {
        return k;
      }
    }

    return -1;
  }

  _ensureCapacity(needed: number) {
    const capacity = this._capacity;
    // `_order` must be able to hold one entry per positioned cell; cells are
    // indexed directly, so capacity is driven by the largest index.
    if (needed <= capacity) {
      return;
    }

    const newCapacity = Math.max(needed, capacity * 2, MIN_CAPACITY);

    const tops = new Float64Array(newCapacity);
    const lefts = new Float64Array(newCapacity);
    const heights = new Float64Array(newCapacity);
    const flags = new Uint8Array(newCapacity);
    const order = new Uint32Array(newCapacity);

    if (capacity > 0) {
      tops.set(this._tops);
      lefts.set(this._lefts);
      heights.set(this._heights);
      flags.set(this._flags);
      order.set(this._order);
    }

    this._tops = tops;
    this._lefts = lefts;
    this._heights = heights;
    this._flags = flags;
    this._order = order;
    this._capacity = newCapacity;
  }
}
