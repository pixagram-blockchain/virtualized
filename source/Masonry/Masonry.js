/** @flow */
import clsx from 'clsx';
import * as React from 'react';
import PositionCache from './PositionCache';
import {
  requestAnimationTimeout,
  cancelAnimationTimeout,
} from '../utils/requestAnimationTimeout';

import type {AnimationTimeoutId} from '../utils/requestAnimationTimeout';

type Props = {
  autoHeight: boolean,
  cellCount: number,
  cellMeasurerCache: CellMeasurerCache,
  cellPositioner: Positioner,
  cellRenderer: CellRenderer,
  className: ?string,
  height: number,
  id: ?string,
  keyMapper: KeyMapper,
  onCellsRendered: ?OnCellsRenderedCallback,
  onScroll: ?OnScrollCallback,
  overscanByPixels: number,
  role: string,
  scrollingResetTimeInterval: number,
  style: mixed,
  tabIndex: number,
  width: number,
  rowDirection: string,
  scrollTop?: number,
};

type State = {
  isScrolling: boolean,
  scrollTop: number,
};

type CachedCellStyle = {
  left: number,
  top: number,
  width: number,
  height: number,
  style: Object,
};

const emptyObject = {};

/**
 * Specifies the number of miliseconds during which to disable pointer events while a scroll is in progress.
 * This improves performance and makes scrolling smoother.
 */
export const DEFAULT_SCROLLING_RESET_TIME_INTERVAL = 150;

/**
 * This component efficiently displays arbitrarily positioned cells using windowing techniques.
 * Cell position is determined by an injected `cellPositioner` property.
 * Windowing is vertical; this component does not support horizontal scrolling.
 *
 * Rendering occurs in two phases:
 * 1) First pass uses estimated cell sizes (provided by the cache) to determine how many cells to measure in a batch.
 *    Batch size is chosen using a fast, naive layout algorithm that stacks images in order until the viewport has been filled.
 *    After measurement is complete (componentDidMount or componentDidUpdate) this component evaluates positioned cells
 *    in order to determine if another measurement pass is required (eg if actual cell sizes were less than estimated sizes).
 *    All measurements are permanently cached (keyed by `keyMapper`) for performance purposes.
 * 2) Second pass uses the external `cellPositioner` to layout cells.
 *    At this time the positioner has access to cached size measurements for all cells.
 *    The positions it returns are cached by Masonry for fast access later.
 *    Phase one is repeated if the user scrolls beyond the current layout's bounds.
 *    If the layout is invalidated due to eg a resize, cached positions can be cleared using `recomputeCellPositions()`.
 *
 * Animation constraints:
 *   Simple animations are supported (eg translate/slide into place on initial reveal).
 *   More complex animations are not (eg flying from one position to another on resize).
 *
 * Layout constraints:
 *   This component supports multi-column layout.
 *   The height of each item may vary.
 *   The width of each item must not exceed the width of the column it is "in".
 *   The left position of all items within a column must align.
 *   (Items may not span multiple columns.)
 */
class Masonry extends React.PureComponent<Props, State> {
  static defaultProps = {
    autoHeight: false,
    keyMapper: identity,
    onCellsRendered: noop,
    onScroll: noop,
    overscanByPixels: 20,
    role: 'grid',
    scrollingResetTimeInterval: DEFAULT_SCROLLING_RESET_TIME_INTERVAL,
    style: emptyObject,
    tabIndex: 0,
    rowDirection: 'ltr',
  };

  state = {
    isScrolling: false,
    scrollTop: 0,
  };

  _debounceResetIsScrollingId: AnimationTimeoutId;
  _invalidateOnUpdateStartIndex: ?number = null;
  _invalidateOnUpdateStopIndex: ?number = null;
  _positionCache: PositionCache = new PositionCache();
  _startIndex: ?number = null;
  _startIndexMemoized: ?number = null;
  _stopIndex: ?number = null;
  _stopIndexMemoized: ?number = null;

  // Caches the per-cell style objects so unchanged cells receive a
  // referentially identical `style` on every render. This lets memoized
  // cell renderers (React.memo / PureComponent) bail out while scrolling.
  _styleCache: Map<number, CachedCellStyle> = new Map();
  _styleCacheRowDirection: string = 'ltr';

  // Latest scroll offset, updated on every scroll event. Renders read this
  // (in uncontrolled mode) so that scroll events which do not change the
  // rendered cell range can skip setState entirely: absolutely-positioned
  // cells inside the fixed-height inner container scroll natively without
  // any React work.
  _scrollTop: number = 0;
  // Signature of the cell range produced by the last render:
  // [start, stop, count] of the overscanned position-cache window, plus
  // whether the render mounted a measurement batch.
  _renderedRangeStart: number = -1;
  _renderedRangeStop: number = -1;
  _renderedRangeCount: number = -1;

  // While `isScrolling`, rendered cell elements are reused by key so that
  // a render triggered by a range change only invokes `cellRenderer` for
  // cells entering the window (mirrors Grid's cell cache).
  _cellCache: Map<mixed, React.Node> = new Map();

  clearCellPositions() {
    this._positionCache = new PositionCache();
    this._styleCache.clear();
    this._cellCache.clear();
    this.forceUpdate();
  }

  // HACK This method signature was intended for Grid
  invalidateCellSizeAfterRender({rowIndex: index}) {
    if (this._invalidateOnUpdateStartIndex === null) {
      this._invalidateOnUpdateStartIndex = index;
      this._invalidateOnUpdateStopIndex = index;
    } else {
      this._invalidateOnUpdateStartIndex = Math.min(
        this._invalidateOnUpdateStartIndex,
        index,
      );
      this._invalidateOnUpdateStopIndex = Math.max(
        this._invalidateOnUpdateStopIndex,
        index,
      );
    }
  }

  recomputeCellPositions() {
    const stopIndex = this._positionCache.count - 1;

    this._positionCache = new PositionCache();
    this._styleCache.clear();
    this._cellCache.clear();
    this._populatePositionCache(0, stopIndex);

    this.forceUpdate();
  }

  static getDerivedStateFromProps(
    nextProps: Props,
    prevState: State,
  ): $Shape<State> {
    if (
      nextProps.scrollTop !== undefined &&
      prevState.scrollTop !== nextProps.scrollTop
    ) {
      return {
        isScrolling: true,
        scrollTop: nextProps.scrollTop,
      };
    }

    return null;
  }

  componentDidMount() {
    this._checkInvalidateOnUpdate();
    this._invokeOnScrollCallback();
    this._invokeOnCellsRenderedCallback();
  }

  componentDidUpdate(prevProps: Props, prevState: State) {
    this._checkInvalidateOnUpdate();
    this._invokeOnScrollCallback();
    this._invokeOnCellsRenderedCallback();

    if (this.props.scrollTop !== prevProps.scrollTop) {
      this._debounceResetIsScrolling();
    }
  }

  componentWillUnmount() {
    if (this._debounceResetIsScrollingId) {
      cancelAnimationTimeout(this._debounceResetIsScrollingId);
    }
  }

  render() {
    const {
      autoHeight,
      cellCount,
      cellMeasurerCache,
      cellRenderer,
      className,
      height,
      id,
      keyMapper,
      overscanByPixels,
      role,
      style,
      tabIndex,
      width,
      rowDirection,
    } = this.props;

    const {isScrolling} = this.state;
    const scrollTop = this._getScrollTop();

    const children = [];
    let rangeStart = -1;
    let rangeStop = -1;
    let rangeCount = 0;
    const cellCache = this._cellCache;

    const estimateTotalHeight = this._getEstimatedTotalHeight();

    const shortestColumnSize = this._positionCache.shortestColumnSize;
    const measuredCellCount = this._positionCache.count;

    let startIndex = 0;
    let stopIndex;

    if (this._styleCacheRowDirection !== rowDirection) {
      // Cached styles are keyed on the opposite offset property; drop them.
      this._styleCache.clear();
      this._cellCache.clear();
      this._styleCacheRowDirection = rowDirection;
    }
    const styleCache = this._styleCache;
    const positionProperty = rowDirection === 'ltr' ? 'left' : 'right';

    this._positionCache.range(
      Math.max(0, scrollTop - overscanByPixels),
      height + overscanByPixels * 2,
      (index: number, left: number, top: number) => {
        if (typeof stopIndex === 'undefined') {
          startIndex = index;
          stopIndex = index;
        } else {
          startIndex = Math.min(startIndex, index);
          stopIndex = Math.max(stopIndex, index);
        }
        if (rangeStart === -1 || index < rangeStart) {
          rangeStart = index;
        }
        if (index > rangeStop) {
          rangeStop = index;
        }
        rangeCount++;

        const cellKey = keyMapper(index);
        if (isScrolling) {
          const cachedElement = cellCache.get(cellKey);
          if (cachedElement !== undefined) {
            children.push(cachedElement);
            return;
          }
        }

        const cellHeight = cellMeasurerCache.getHeight(index);
        const cellWidth = cellMeasurerCache.getWidth(index);

        let cellStyle;
        const cached = styleCache.get(index);
        if (
          cached !== undefined &&
          cached.left === left &&
          cached.top === top &&
          cached.width === cellWidth &&
          cached.height === cellHeight
        ) {
          cellStyle = cached.style;
        } else {
          cellStyle = {
            height: cellHeight,
            [positionProperty]: left,
            position: 'absolute',
            top,
            width: cellWidth,
          };
          styleCache.set(index, {
            left,
            top,
            width: cellWidth,
            height: cellHeight,
            style: cellStyle,
          });
        }

        const element = cellRenderer({
          index,
          isScrolling,
          key: cellKey,
          parent: this,
          style: cellStyle,
        });
        if (isScrolling) {
          cellCache.set(cellKey, element);
        }
        children.push(element);
      },
    );

    this._renderedRangeStart = rangeStart;
    this._renderedRangeStop = rangeStop;
    this._renderedRangeCount = rangeCount;

    // We need to measure additional cells for this layout
    if (
      shortestColumnSize < scrollTop + height + overscanByPixels &&
      measuredCellCount < cellCount
    ) {
      const batchSize = Math.min(
        cellCount - measuredCellCount,
        Math.ceil(
          (((scrollTop + height + overscanByPixels - shortestColumnSize) /
            cellMeasurerCache.defaultHeight) *
            width) /
            cellMeasurerCache.defaultWidth,
        ),
      );

      for (
        let index = measuredCellCount;
        index < measuredCellCount + batchSize;
        index++
      ) {
        stopIndex = index;

        children.push(
          cellRenderer({
            index: index,
            isScrolling,
            key: keyMapper(index),
            parent: this,
            style: {
              width: cellMeasurerCache.getWidth(index),
            },
          }),
        );
      }
    }

    this._startIndex = startIndex;
    this._stopIndex = stopIndex;

    return (
      <div
        ref={this._setScrollingContainerRef}
        aria-label={this.props['aria-label']}
        className={clsx('ReactVirtualized__Masonry', className)}
        id={id}
        onScroll={this._onScroll}
        role={role}
        style={{
          boxSizing: 'border-box',
          direction: 'ltr',
          height: autoHeight ? 'auto' : height,
          overflowX: 'hidden',
          overflowY: estimateTotalHeight < height ? 'hidden' : 'auto',
          position: 'relative',
          width,
          WebkitOverflowScrolling: 'touch',
          willChange: 'transform',
          ...style,
        }}
        tabIndex={tabIndex}>
        <div
          className="ReactVirtualized__Masonry__innerScrollContainer"
          style={{
            width: '100%',
            height: estimateTotalHeight,
            maxWidth: '100%',
            maxHeight: estimateTotalHeight,
            overflow: 'hidden',
            pointerEvents: isScrolling ? 'none' : '',
            position: 'relative',
          }}>
          {children}
        </div>
      </div>
    );
  }

  _checkInvalidateOnUpdate() {
    if (typeof this._invalidateOnUpdateStartIndex === 'number') {
      const startIndex = this._invalidateOnUpdateStartIndex;
      const stopIndex = this._invalidateOnUpdateStopIndex;

      this._invalidateOnUpdateStartIndex = null;
      this._invalidateOnUpdateStopIndex = null;

      // Query external layout logic for position of newly-measured cells
      this._populatePositionCache(startIndex, stopIndex);

      this.forceUpdate();
    }
  }

  _debounceResetIsScrolling() {
    const {scrollingResetTimeInterval} = this.props;

    if (this._debounceResetIsScrollingId) {
      cancelAnimationTimeout(this._debounceResetIsScrollingId);
    }

    this._debounceResetIsScrollingId = requestAnimationTimeout(
      this._debounceResetIsScrollingCallback,
      scrollingResetTimeInterval,
    );
  }

  _debounceResetIsScrollingCallback = () => {
    this._cellCache.clear();
    this.setState({
      isScrolling: false,
      scrollTop: this._getScrollTop(),
    });
  };

  // In controlled mode (scrollTop prop, e.g. under WindowScroller) the
  // offset flows through getDerivedStateFromProps into state; otherwise the
  // instance field tracks the live DOM offset.
  _getScrollTop(): number {
    return this.props.scrollTop !== undefined
      ? this.state.scrollTop
      : this._scrollTop;
  }

  _getEstimatedTotalHeight() {
    const {cellCount, cellMeasurerCache, width} = this.props;

    const estimatedColumnCount = Math.max(
      1,
      Math.floor(width / cellMeasurerCache.defaultWidth),
    );

    return this._positionCache.estimateTotalHeight(
      cellCount,
      estimatedColumnCount,
      cellMeasurerCache.defaultHeight,
    );
  }

  _invokeOnScrollCallback() {
    const {height, onScroll} = this.props;
    const scrollTop = this._getScrollTop();

    if (this._onScrollMemoized !== scrollTop) {
      onScroll({
        clientHeight: height,
        scrollHeight: this._getEstimatedTotalHeight(),
        scrollTop,
      });

      this._onScrollMemoized = scrollTop;
    }
  }

  _invokeOnCellsRenderedCallback() {
    if (
      this._startIndexMemoized !== this._startIndex ||
      this._stopIndexMemoized !== this._stopIndex
    ) {
      const {onCellsRendered} = this.props;

      onCellsRendered({
        startIndex: this._startIndex,
        stopIndex: this._stopIndex,
      });

      this._startIndexMemoized = this._startIndex;
      this._stopIndexMemoized = this._stopIndex;
    }
  }

  _populatePositionCache(startIndex: number, stopIndex: number) {
    const {cellMeasurerCache, cellPositioner} = this.props;

    for (let index = startIndex; index <= stopIndex; index++) {
      const {left, top} = cellPositioner(index);

      this._positionCache.setPosition(
        index,
        left,
        top,
        cellMeasurerCache.getHeight(index),
      );
    }
  }

  _setScrollingContainerRef = ref => {
    this._scrollingContainer = ref;
  };

  _onScroll = event => {
    const {height} = this.props;

    const eventScrollTop = event.currentTarget.scrollTop;

    // When this component is shrunk drastically, React dispatches a series of back-to-back scroll events,
    // Gradually converging on a scrollTop that is within the bounds of the new, smaller height.
    // This causes a series of rapid renders that is slow for long lists.
    // We can avoid that by doing some simple bounds checking to ensure that scroll offsets never exceed their bounds.
    const scrollTop = Math.min(
      Math.max(0, this._getEstimatedTotalHeight() - height),
      eventScrollTop,
    );

    // On iOS, we can arrive at negative offsets by swiping past the start or end.
    // Avoid re-rendering in this case as it can cause problems; see #532 for more.
    if (eventScrollTop !== scrollTop) {
      return;
    }

    // Prevent pointer events from interrupting a smooth scroll
    this._debounceResetIsScrolling();

    if (this._scrollTop === scrollTop && this.state.isScrolling) {
      return;
    }
    this._scrollTop = scrollTop;

    // The onScroll prop fires for every distinct offset, independent of
    // whether React work is needed (memoized inside).
    this._invokeOnScrollCallback();

    // Re-render only when it would change the output: the overscanned cell
    // range moved, a measurement batch is required, or the isScrolling flag
    // needs to flip on. Offsets within the current range scroll natively.
    if (
      this.state.isScrolling &&
      !this._rangeChanged(scrollTop) &&
      !this._needsMeasurementBatch(scrollTop)
    ) {
      return;
    }

    this.setState({
      isScrolling: true,
      scrollTop,
    });
  };

  // Recomputes the overscanned range signature for `scrollTop` and compares
  // it with what the last render produced. A position-cache walk costs well
  // under a microsecond, so this runs on every scroll event.
  _rangeChanged(scrollTop: number): boolean {
    const {height, overscanByPixels} = this.props;

    let start = -1;
    let stop = -1;
    let count = 0;
    this._positionCache.range(
      Math.max(0, scrollTop - overscanByPixels),
      height + overscanByPixels * 2,
      index => {
        if (start === -1 || index < start) {
          start = index;
        }
        if (index > stop) {
          stop = index;
        }
        count++;
      },
    );

    return (
      start !== this._renderedRangeStart ||
      stop !== this._renderedRangeStop ||
      count !== this._renderedRangeCount
    );
  }

  _needsMeasurementBatch(scrollTop: number): boolean {
    const {cellCount, height, overscanByPixels} = this.props;

    return (
      this._positionCache.shortestColumnSize <
        scrollTop + height + overscanByPixels &&
      this._positionCache.count < cellCount
    );
  }
}

function identity(value) {
  return value;
}

function noop() {}

type KeyMapper = (index: number) => mixed;

export type CellMeasurerCache = {
  defaultHeight: number,
  defaultWidth: number,
  getHeight: (index: number) => number,
  getWidth: (index: number) => number,
};

type CellRenderer = (params: {|
  index: number,
  isScrolling: boolean,
  key: mixed,
  parent: mixed,
  style: mixed,
|}) => mixed;

type OnCellsRenderedCallback = (params: {|
  startIndex: number,
  stopIndex: number,
|}) => void;

type OnScrollCallback = (params: {|
  clientHeight: number,
  scrollHeight: number,
  scrollTop: number,
|}) => void;

type Position = {
  left: number,
  top: number,
};

export default Masonry;

export type Positioner = (index: number) => Position;
