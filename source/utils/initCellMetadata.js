/**
 * Initializes metadata for an axis and its cells.
 * This data is used to determine which cells are visible given a container size and scroll position.
 *
 * @param cellCount Total number of cells.
 * @param size Either a fixed size or a function that returns the size for a given given an index.
 * @return Object mapping cell index to cell metadata (size, offset)
 */
export default function initCellMetadata({cellCount, size}) {
  const sizeGetter = typeof size === 'function' ? size : () => size;

  // Preallocate to avoid repeated array growth for large cell counts.
  const cellMetadata = new Array(cellCount);
  let offset = 0;

  for (let i = 0; i < cellCount; i++) {
    const cellSize = sizeGetter({index: i});

    if (cellSize == null || isNaN(cellSize)) {
      throw Error(`Invalid size returned for cell ${i} of value ${cellSize}`);
    }

    cellMetadata[i] = {
      size: cellSize,
      offset,
    };

    offset += cellSize;
  }

  return cellMetadata;
}
