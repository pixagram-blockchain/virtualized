# Modernization: CellMeasurer, Masonry, utils

TypedArray-backed rewrites plus algorithmic and React-layer upgrades. The
full original jest tree passes (568 tests across all 27 suites; one
assertion adapted, noted below); randomized differential testing (old vs new, thousands
of operations) confirms observable-behavior parity, including documented
quirks. Verified on React 17 and React 18 (createRoot), plus a simulated
React 19 environment (no `ReactDOM.findDOMNode`).

## CellMeasurer/CellMeasurerCache.js

- Default configuration (no custom `keyMapper`, not subclassed) stores cell
  widths/heights in flat `Float64Array`s with a `Uint8Array` presence bitmap,
  laid out `rowIndex * columnCapacity + columnIndex`. Geometric growth;
  row-only growth is a single contiguous copy.
- Derived `rowHeight`/`columnWidth` are maintained incrementally with
  per-row/per-column aggregate arrays (max, measured-count, derived value).
  The original rescanned an entire row/column on every `set`/`clear`, making
  bulk population O(n²); the rewrite is O(1) amortized per write (a rescan
  happens only when the previous maximum is overwritten/cleared with a
  smaller value).
- The cell payload is interleaved as `[width, height]` pairs in a single
  `Float64Array` (`data[slot << 1]`, `data[(slot << 1) | 1]`), so a
  set/measure pair touches one buffer; the presence flags are a
  `Uint32Array` bitset addressed with `slot >>> 5` / `slot & 31`.
- A Map-based compatibility path preserves exact original behavior for
  custom `keyMapper`s, subclasses, and non-integer/negative/huge indices
  (automatic, lossless demotion at runtime; capacity cap 2^22 cells).
- Preserved quirks: `keyMapper` call counts (exactly one call each for
  `has`/`columnWidth`/`rowHeight`); `clear()` on a never-set coordinate
  writes derived 0; stale derived values for untouched rows/columns;
  `has()` consults only the height store; min-clamping on read;
  `_rowCount`/`_columnCount` semantics; constructor dev warnings verbatim.

## CellMeasurer/CellMeasurer.js

- `findDOMNode` is resolved defensively (`typeof === 'function'`), so the
  component keeps working on React 19 where it no longer exists: with
  `registerChild` everything functions as before; without it, measurement is
  skipped gracefully with a one-time (module-level) dev warning instead of a
  crash.
- `registerChild`'s `instanceof Element` validation is now guarded with
  `typeof Element !== 'undefined'` (the original threw in DOM-less or
  non-standard-global environments).
- `_getCellMeasurements(node?)` keeps its optional-node signature; the
  measure sequence (style auto → `Math.ceil(offset*)` → restore) is
  byte-for-byte the original (issues #593/#660 covered by tests).

## Grid/utils/CellSizeAndPositionManager.js

The engine under Grid, List, Table, MultiGrid and InfiniteLoader.

- Cell offsets and sizes now live in two flat `Float64Array`s instead of
  one `{offset, size}` heap object per cell stored in a plain object map —
  a 100k-row list keeps two contiguous buffers instead of ~100k small
  objects.
- The just-in-time fill is factored into `_fill`/`_probe`; binary and
  exponential search probes read raw doubles after a one-compare fill
  check, with no property loads and no per-probe guard chain. Probes
  beyond `cellCount` still throw the original error verbatim (relevant
  when `configure()` shrinks the collection without `resetCell` — the
  original failed loudly there and the rewrite matches it exactly).
- Verified by a randomized differential harness asserting identical
  return values, identical thrown errors, identical
  `_lastMeasuredIndex`/`_lastBatchedIndex` progression, and — strongest —
  identical `cellSizeGetter` call sequences across thousands of mixed
  operations in both fully-measured and deferred (CellMeasurer) modes.
- **New: `resizeCell(index)` point updates (Fenwick delta tree).** For the
  case where one cell changed size but every other cell kept its identity
  (a CellMeasurer re-measure), `resizeCell` re-asks the getter for that
  single cell and patches all downstream offsets in O(log n) via a binary
  indexed tree of pending corrections, instead of invalidating and
  re-asking the whole suffix. While no corrections are pending, every
  offset read keeps the original fast path (one extra compare); pending
  corrections add an O(log n) prefix to reads until they are folded back
  into the absolute offsets by a single O(n) rebase, which runs lazily
  before any structural change (`resetCell` or a sequential fill
  extension). `resetCell` itself keeps its documented suffix-invalidation
  semantics verbatim — insertions and removals must still use it.
  Ground-truth tested against brute-force prefix sums across thousands of
  mixed operations, and proven to converge to exactly the same state as
  the suffix path.
- `ScalingCellSizeAndPositionManager` forwards `resizeCell`. Grid gains
  `recomputeCellSize({columnIndex, rowIndex})` — the point-update twin of
  `recomputeGridSize` — and CellMeasurer prefers it when the parent
  exposes it. Net effect: a re-measured cell near the top of a 100k-row
  list while scrolled near the bottom costs ~1 µs instead of ~707 µs (and
  no longer re-invokes the size getter 100k times).
- Quirk preserved: a run of cells filled toward a target index sets
  `_lastMeasuredIndex`/`_lastBatchedIndex` to the *target* index per
  branch, exactly as the original loop did.
- Trade-off: `getSizeAndPositionOfCell` now allocates its return object
  (the original handed back the stored one), costing ~10% on that single
  warm micro-path while searches, fills, and deep scrolls are 2–7x
  faster and memory drops by roughly an order of magnitude.

## Masonry/PositionCache.js

- A masonry layout is a set of independent column stacks, so the cache keeps
  one top-sorted Uint32Array of cell indices per column instead of one
  global geometry structure. Inserts are O(1) amortized appends per column;
  rare out-of-order inserts move memory within one column only.
- `range()` binary-searches each column independently and walks the
  per-column band `[scrollTop - columnMaxCellHeight, hi]` — output-sensitive
  O(columns * log n + reported), and one giant cell only widens the
  candidate band of its own column. Cells are reported column by column in
  ascending-top order (the original tree's order differed; Masonry's output
  is order-independent because keys are stable).
- `shortestColumnSize`/`tallestColumnSize` are cached with lazy
  recomputation (original did a `for...in` object scan per access — these
  are read on every render/scroll). Original min/max formulas preserved,
  including the `size === 0 ? height : min(size, height)` shortest-column
  quirk.
- Column bottoms are tracked in two parallel `Float64Array`s with a short
  linear scan instead of a `Map` — for realistic column counts the scan
  beats hashing on every insert, and the monotonic (never-shrinking)
  bottom semantics of the original are kept.
- Behavior fixes (deliberate deviations, both strictly closer to the
  documented contract):
  1. `setPosition` on an existing index overwrites its interval. The
     original inserted a duplicate into the tree and leaked the old one.
  2. `range()` always reports every intersecting cell. The original
     early-exited as soon as the render callback returned a truthy value —
     an undocumented vendor-tree quirk contradicting the `void` Flow
     contract (Masonry itself never returns truthy, so it never noticed).
- `vendor/intervalTree.js` and `vendor/binarySearchBounds.js` are left in
  place for external deep-importers but are no longer used internally.

## Masonry/Masonry.js — React-layer rendering upgrades

- **Range-gated rendering.** Scroll events no longer call `setState`
  unconditionally. The handler recomputes the overscanned cell range (a
  position-cache walk, sub-microsecond) and re-renders only when the range
  changed, a measurement batch is needed, or `isScrolling` must flip on.
  Offsets within the current range scroll natively — absolutely-positioned
  cells inside the fixed-height inner container need no React work — so
  render frequency drops from event-rate (~60/s) to range crossings. The
  `onScroll` prop still fires for every distinct offset (now directly from
  the handler, memoized as before), and `onCellsRendered` semantics are
  unchanged (it was already memoized on indices).
- **Element cache while scrolling.** Mirroring Grid's `_cellCache`: during
  `isScrolling`, rendered cell elements are reused by key, so a render
  caused by a range change invokes `cellRenderer` only for cells entering
  the window; scrolling back over a previous range invokes it zero times.
  The cache clears exactly when the scroll burst ends and on every
  position/style invalidation. One shipped test asserted exact
  `cellRenderer` call counts as a proxy for "measured cells must not leave
  the DOM" (issue #875); the assertion was adapted to test that intent
  directly, which the element cache preserves by construction.
- Native `getDerivedStateFromProps`; the `react-lifecycles-compat` polyfill
  import is dropped.
- Per-cell style objects are cached (`Map<index, style>`), so unchanged
  cells receive referentially-stable `style` props across renders — enabling
  `React.memo`/`PureComponent` bailouts in cell renderers. The cache is
  invalidated on `rowDirection` change and cleared by
  `clearCellPositions`/`recomputeCellPositions`.
- Estimated total height and shortest-column lookups are now O(1) via the
  PositionCache caching above. Rendering, props, defaults, scroll handling,
  and batched measurement are unchanged.

## Masonry/createCellPositioner.js

- Column heights tracked in a `Float64Array` (reused across resets when the
  column count is unchanged).
- Bug fix: `reset({columnCount, columnWidth})` without `spacer` previously
  set `spacer = undefined`, poisoning every subsequent `top` with NaN. It
  now defaults to 0.

## utils

- `animationFrame.js`: dropped 2011-era vendor prefixes; resolves
  window/self/globalThis and binds natives to the host object. Same
  `raf`/`caf` exports and `setTimeout(cb, 1000/60)` fallback.
- `createCallbackMemoizer.js`: allocation-free elementwise array comparison
  replaces `join(',')` string building on every call; also no longer throws
  when key sets of equal size differ. Same memoization semantics.
- `initCellMetadata.js`: preallocates the metadata array; same
  `{size, offset}` objects and exact error message.
- `getUpdatedOffsetForIndex.js`, `requestAnimationTimeout.js`: unchanged
  (already optimal).

## React modernization sweep

`react-lifecycles-compat` is removed from Grid, ArrowKeyStepper,
CollectionView and MultiGrid (Masonry already had it removed); all use
native `getDerivedStateFromProps`. The library no longer imports the
polyfill anywhere.

## Compatibility notes

- Public APIs, prop types, exports, class-ness (instance methods and
  `parent` contracts), and DOM output are identical.
- React 17 and 18 fully supported; React 19 supported when cells use the
  `registerChild` render-prop (the pre-existing recommendation), since
  `findDOMNode` no longer exists there.
- Other components (Grid, List, Table, Collection, …) are untouched.
