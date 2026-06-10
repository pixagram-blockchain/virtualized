/** @flow */

type RenderCallback = (index: number, left: number, top: number) => void;

const EMPTY_F64 = new Float64Array(0);
const EMPTY_U32 = new Uint32Array(0);
const EMPTY_U8 = new Uint8Array(0);

const MIN_CAPACITY = 64;
const MIN_COLUMN_CAPACITY = 32;

// Position cache requirements:
//   O(log(n) + k) lookup of cells to render for a given viewport size
//   O(1) lookup of shortest measured column (so we know when to enter phase 1)
//
// A masonry layout is a set of independent column stacks, so instead of one
// global geometry structure this cache keeps one top-sorted index array per
// column:
//
//   - `_tops` / `_lefts` / `_heights` store each cell's geometry, indexed
//     directly by cell index (cells arrive mostly sequentially).
//   - Each column (identified by its x offset) owns a Uint32Array of its
//     cell indices sorted by `top`. Masonry grows downward per column, so
//     inserts are O(1) amortized appends; rare out-of-order inserts are a
//     single `copyWithin` within that column only.
//   - Range queries binary-search each column independently and walk the
//     narrow per-column band `[lo - columnMaxCellHeight, hi]`. Queries are
//     output-sensitive — O(columns * log n + reported) — and one giant cell
//     only widens the candidate band of its own column.
//
// Unlike the original interval tree (which silently accumulated duplicate
// entries if the same index was positioned twice), `setPosition` overwrites
// the previous position for an index. This avoids duplicate render
// callbacks (and duplicate React keys) when a range is re-populated.
export default class PositionCache {
  _capacity = 0;
  _count = 0;

  _tops: Float64Array = EMPTY_F64;
  _lefts: Float64Array = EMPTY_F64;
  _heights: Float64Array = EMPTY_F64;
  _flags: Uint8Array = EMPTY_U8;

  // Column registry, keyed by x offset. Parallel arrays beat a Map for
  // realistic column counts (a handful): lookup is a short linear scan.
  _colLefts: Float64Array = new Float64Array(8);
  _colBottoms: Float64Array = new Float64Array(8);
  // Per-column sorted cell indices (ascending top) and their counts.
  _colOrders: Array<Uint32Array> = [];
  _colItemCounts: Uint32Array = new Uint32Array(8);
  // Per-column monotone upper bound on cell height; bounds the candidate
  // band during range queries.
  _colMaxHeights: Float64Array = new Float64Array(8);
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
  // Cells are reported column by column, in ascending `top` order within
  // each column.
  range(
    scrollTop: number,
    clientHeight: number,
    renderCallback: RenderCallback,
  ): void {
    const hi = scrollTop + clientHeight;

    if (this._count === 0 || scrollTop > hi) {
      return;
    }

    const tops = this._tops;
    const lefts = this._lefts;
    const heights = this._heights;
    const colCount = this._colCount;

    for (let c = 0; c < colCount; c++) {
      const n = this._colItemCounts[c];
      if (n === 0) {
        continue;
      }
      const order = this._colOrders[c];

      // First cell whose top could still produce an intersection in this
      // column: any intersecting cell satisfies top >= lo - colMaxHeight.
      const minTop = scrollTop - this._colMaxHeights[c];

      let low = 0;
      let high = n;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (tops[order[mid]] < minTop) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }

      for (let k = low; k < n; k++) {
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
  }

  setPosition(index: number, left: number, top: number, height: number): void {
    this._ensureCapacity(index + 1);

    const tops = this._tops;
    const wasSet = this._flags[index] === 1;

    if (wasSet) {
      // Overwrite: remove the stale entry from its previous column first.
      const oldColumn = this._findColumn(this._lefts[index]);
      if (oldColumn !== -1) {
        this._removeFromColumn(oldColumn, index, tops[index]);
        this._count--;
      }
    }

    tops[index] = top;
    this._lefts[index] = left;
    this._heights[index] = height;
    this._flags[index] = 1;

    let c = this._findColumn(left);
    if (c === -1) {
      c = this._addColumn(left);
    }

    if (height > this._colMaxHeights[c]) {
      this._colMaxHeights[c] = height;
    }

    this._insertIntoColumn(c, index, top);
    this._count++;

    const bottom = top + height;
    if (bottom > this._colBottoms[c]) {
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

  _findColumn(left: number): number {
    const colLefts = this._colLefts;
    const colCount = this._colCount;
    for (let c = 0; c < colCount; c++) {
      if (colLefts[c] === left) {
        return c;
      }
    }
    return -1;
  }

  _addColumn(left: number): number {
    const c = this._colCount;
    if (c === this._colLefts.length) {
      const nextSize = c << 1;
      const nextLefts = new Float64Array(nextSize);
      const nextBottoms = new Float64Array(nextSize);
      const nextItemCounts = new Uint32Array(nextSize);
      const nextMaxHeights = new Float64Array(nextSize);
      nextLefts.set(this._colLefts);
      nextBottoms.set(this._colBottoms);
      nextItemCounts.set(this._colItemCounts);
      nextMaxHeights.set(this._colMaxHeights);
      this._colLefts = nextLefts;
      this._colBottoms = nextBottoms;
      this._colItemCounts = nextItemCounts;
      this._colMaxHeights = nextMaxHeights;
    }
    this._colLefts[c] = left;
    this._colBottoms[c] = 0;
    this._colItemCounts[c] = 0;
    this._colMaxHeights[c] = 0;
    this._colOrders[c] = EMPTY_U32;
    this._colCount = c + 1;
    return c;
  }

  // Inserts `index` into column `c`, keeping its order sorted by top
  // (upper bound, so equal tops preserve insertion order). Masonry grows
  // downward per column, so this is nearly always an append.
  _insertIntoColumn(c: number, index: number, top: number): void {
    let order = this._colOrders[c];
    const n = this._colItemCounts[c];

    if (n === order.length) {
      const next = new Uint32Array(
        n === 0 ? MIN_COLUMN_CAPACITY : n << 1,
      );
      next.set(order);
      order = next;
      this._colOrders[c] = next;
    }

    const tops = this._tops;
    if (n === 0 || tops[order[n - 1]] <= top) {
      order[n] = index;
    } else {
      let low = 0;
      let high = n;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (tops[order[mid]] <= top) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      order.copyWithin(low + 1, low, n);
      order[low] = index;
    }
    this._colItemCounts[c] = n + 1;
  }

  // Locates and removes `index` from column `c` given its current top.
  // Binary-searches to the run of equal tops, then scans it.
  _removeFromColumn(c: number, index: number, top: number): void {
    const order = this._colOrders[c];
    const n = this._colItemCounts[c];
    const tops = this._tops;

    let low = 0;
    let high = n;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (tops[order[mid]] < top) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    for (let k = low; k < n; k++) {
      if (order[k] === index) {
        order.copyWithin(k, k + 1, n);
        this._colItemCounts[c] = n - 1;
        return;
      }
      if (tops[order[k]] !== top) {
        break;
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

    const tops = new Float64Array(newCapacity);
    const lefts = new Float64Array(newCapacity);
    const heights = new Float64Array(newCapacity);
    const flags = new Uint8Array(newCapacity);

    if (capacity > 0) {
      tops.set(this._tops);
      lefts.set(this._lefts);
      heights.set(this._heights);
      flags.set(this._flags);
    }

    this._tops = tops;
    this._lefts = lefts;
    this._heights = heights;
    this._flags = flags;
    this._capacity = newCapacity;
  }
}
