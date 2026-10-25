/**
 * Device history views (D850, D896): the device History tab / Live Stats
 * last day (`DeviceHistoryView`) and the building blocks the cross-device
 * History page composes.
 */
export { DeviceHistoryView, humanizeName, type DeviceHistoryViewProps } from './DeviceHistoryView'
export { HistoryChart, booleanLabels, type HistoryChartProps } from './HistoryChart'
export { HistoryWindowBar, type HistoryWindowBarProps } from './HistoryWindowBar'
export {
  BOOLEAN_STATES,
  OCCUPANCY_KEY,
  chartKeys,
  energyBuckets,
  filterOccupancyLines,
  groupDeviceSeries,
  linePoints,
  occupancyFacets,
  occupancyLines,
  parseCapKey,
  parseProducerKey,
  shiftPoints,
  stateRow,
  type HistoryChartSpec,
  type HistorySection,
  type OccupancyFilter,
  type OccupancyScopeLine,
} from './history-model'
export {
  chunk,
  isRefusal,
  readHistory,
  type HistoryReader,
  type HistoryReadWindow,
} from './history-reads'
export {
  EMPTY_HISTORY_PANELS,
  HISTORY_PAGE_PATH,
  HISTORY_PANELS_NAMESPACE,
  HISTORY_SELECTION_MAX,
  decodeSeriesRef,
  encodeSeriesRef,
  historyPageHref,
  normalizeSelection,
  readHistoryPanels,
  seriesRefId,
  withHiddenChart,
  withPanel,
  withoutPanel,
  type HistoryPanel,
  type HistoryPanelsValue,
  type HistorySeriesRef,
  type HistorySubject,
} from './history-selection'
export {
  HISTORY_WINDOW_IDS,
  HISTORY_WINDOW_MS,
  RESOLUTION_BUCKET_MS,
  decodeCustomWindow,
  encodeCustomWindow,
  isHistoryWindowId,
  previousWindow,
  resolveHistoryWindow,
  type CustomWindow,
  type HistoryWindow,
  type HistoryWindowId,
} from './history-window'
export {
  anchorNow,
  readItemId,
  useDeviceSeriesList,
  useHistoryReader,
  useHistoryReads,
  type HistoryReads,
  type HistoryStage,
} from './use-device-history'
export { useHistoryPanels, type HistoryPanelsState } from './use-history-panels'
