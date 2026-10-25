/**
 * The chart family (D899): one look for every time-based chart, built on
 * uPlot, themed only through `--color-chart-series-*` and the neutral tokens.
 */
export { TimeSeriesChart, type ChartRange, type TimeSeriesChartProps } from './TimeSeriesChart'
export {
  StateTimeline,
  stateStyle,
  type StateRowDef,
  type StateTimelineProps,
} from './StateTimeline'
export { BarSeries, type BarSeriesProps } from './BarSeries'
export { Sparkline, type SparklinePoint, type SparklineProps } from './Sparkline'
export {
  ChartFrame,
  ChartPlaceholder,
  ChartSwatch,
  type ChartFrameProps,
  type ChartLegendEntry,
} from './chart-frame'
export {
  ChartWindowToggle,
  type ChartWindowOption,
  type ChartWindowToggleProps,
} from './chart-window'
export {
  CHART_SERIES_TOKENS,
  chartSeriesStyle,
  swatchFillClass,
  swatchLineClass,
  type ChartSeriesStyle,
  type ChartSwatchToken,
  type ChartSeriesToken,
} from './chart-palette'
export {
  GAP_INTERVAL_FACTOR,
  axisTicks,
  gapThresholdMs,
  niceMax,
  niceRange,
  type AxisScale,
} from './chart-scale'
export {
  alignSeries,
  formatSpan,
  formatTimeLabel,
  segmentsFromChanges,
  sharedGapSpans,
  stackSeries,
  stateAt,
  timeInState,
  type GapSpan,
  type StateChange,
  type StateSegment,
  type TimePoint,
} from './chart-data'
export {
  defaultAxisSpec,
  formatChartBytes,
  formatChartNumber,
  formatChartValue,
  isByteUnit,
  type ValueAxisSpec,
} from './chart-uplot'
export {
  buildTimeSeriesModel,
  unitAxes,
  type SeriesInterpolation,
  type TimeSeriesDef,
} from './time-series-model'
export { bucketTotals, stackBuckets, type BarBucket, type BarLayerDef } from './bar-series-model'
