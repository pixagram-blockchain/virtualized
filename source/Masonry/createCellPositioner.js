/** @flow */
import type {CellMeasurerCache, Positioner} from './Masonry';

type createCellPositionerParams = {
  cellMeasurerCache: CellMeasurerCache,
  columnCount: number,
  columnWidth: number,
  spacer?: number,
};

type resetParams = {
  columnCount: number,
  columnWidth: number,
  spacer?: number,
};

export default function createCellPositioner({
  cellMeasurerCache,
  columnCount,
  columnWidth,
  spacer = 0,
}: createCellPositionerParams): Positioner {
  // Track the height of each column in a flat Float64Array.
  // The layout algorithm below always inserts into the shortest column.
  let columnHeights: Float64Array;

  initOrResetDerivedValues();

  function cellPositioner(index) {
    // Find the shortest column and use it.
    let columnIndex = 0;
    let minHeight = columnHeights[0];
    for (let i = 1; i < columnHeights.length; i++) {
      const height = columnHeights[i];
      if (height < minHeight) {
        minHeight = height;
        columnIndex = i;
      }
    }

    const left = columnIndex * (columnWidth + spacer);
    const top = columnHeights[columnIndex] || 0;

    columnHeights[columnIndex] =
      top + cellMeasurerCache.getHeight(index) + spacer;

    return {
      left,
      top,
    };
  }

  function initOrResetDerivedValues(): void {
    // Float64Array is zero-initialized; reallocate only when the column
    // count changes, otherwise just clear in place.
    if (!columnHeights || columnHeights.length !== columnCount) {
      columnHeights = new Float64Array(columnCount);
    } else {
      columnHeights.fill(0);
    }
  }

  function reset(params: resetParams): void {
    columnCount = params.columnCount;
    columnWidth = params.columnWidth;
    // Original implementation assigned `params.spacer` directly; when the
    // caller omitted it, `spacer` became undefined and every subsequent
    // `top` computation produced NaN. Default to 0 instead.
    spacer = params.spacer !== undefined ? params.spacer : 0;

    initOrResetDerivedValues();
  }

  cellPositioner.reset = reset;

  return cellPositioner;
}
