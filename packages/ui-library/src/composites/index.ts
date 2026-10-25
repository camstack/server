export { AddonGlobalSettingsForm } from './addon-global-settings-form'
// --- Addon page ---
export type { AddonPageProps } from './addon-page-props'
export {
  type AcceleratorIdentity,
  acceleratorLabel,
  acceleratorShortLabel,
} from './accelerator-label'
export type { AgentStepEditorProps } from './agent-step-editor'
export {
  AgentStepEditor,
  RootSuppliedModelNote,
  settingsModelIdFor,
  stepLocalFields,
} from './agent-step-editor'
export type { RootModelInfo } from './root-model-source'
export { RootModelSourceControl, rootSourceState, withUseRootModel } from './root-model-source'
export * from './app-shell'
export type { AudioClassification, AudioClassificationListProps } from './audio-classification-list'
export { AudioClassificationList } from './audio-classification-list'
export type { AudioLevelWaveformProps } from './audio-level-waveform'
export { AudioLevelWaveform } from './audio-level-waveform'
export type { AudioWaveformProps } from './audio-waveform'
// --- Audio components ---
export { AudioWaveform } from './audio-waveform'
export type { BatteryBadgeProps, BatteryStatusLike } from './battery-badge'
export { BatteryBadge } from './battery-badge'
export type { RunningBadgeProps, RunningStatusLineProps } from './running-badge'
export { RunningBadge, RunningStatusLine } from './running-badge'
export { runningDurationSince, runningStatusParts } from './running-status'
export type { RunningDuration, RunningStatusKey, RunningStatusParts } from './running-status'
export type {
  ConsumableLevel,
  ConsumableLevelBadgeProps,
  ConsumableLevelFieldView,
} from './consumable-level-badge'
export {
  CONSUMABLE_LOW_PERCENT,
  ConsumableLevelBadge,
  consumableItemLevel,
  consumableLevelBarClass,
  consumableLevelLabel,
  consumableLevelVariant,
  isConsumableLevelField,
  parseConsumableLevel,
} from './consumable-level-badge'
export type { NetworkLinkBadgeProps, NetworkLinkStatusLike } from './network-link-badge'
export { NetworkLinkBadge } from './network-link-badge'
export {
  NODE_COLOR_IDS,
  assignNodeColorId,
  nodeColorClass,
  nodeSoftBgClass,
  nodeTextColorClass,
} from './node-color'
export type { NodeColorId } from './node-color'
export type { AgentSettingsColorRow } from './node-color-map'
export { buildColorByNodeId, colorIdForNode } from './node-color-map'
export type { PipelineRoleId, RoleNodePillProps } from './role-node-pill'
export { RoleNodePill } from './role-node-pill'
export * from './breadcrumb'
export type {
  AdaptiveHintsReport,
  AdaptiveOfferPhase,
  ApplyDownlinkProbe,
  DownlinkProbeAnswer,
} from './adaptive-downlink'
export type {
  CameraStreamPlayerProps,
  ClientOfferResult,
  ClientStreamHints,
  PlayerConnectionState,
  PlayerWebrtcTarget,
  SessionSignalingState,
  SignalingResult,
} from './camera-stream-player'
// --- Camera stream player ---
export { CameraStreamPlayer } from './camera-stream-player'
// --- Stream-debug overlay (the `showStats` surface) ---
export { StreamDebugOverlay } from './stream-debug/stream-debug-overlay'
export type { StreamDebugOverlayProps } from './stream-debug/stream-debug-overlay'
export {
  deriveWebrtcDebugStats,
  freezeVerdict,
} from './stream-debug/webrtc-debug-stats'
export type {
  DeriveWebrtcDebugStatsInput,
  FreezeVerdict,
  FreezeVerdictKind,
  ResolutionMark,
  StreamDebugSample,
  WebrtcDebugStats,
  WebrtcDebugWindow,
} from './stream-debug/webrtc-debug-stats'
// --- WebRTC diagnostics (Administration → Network → Diagnostics) ---
export { buildPeerConnectionConfig } from './peer-connection-config'
export {
  EndpointResultsCard,
  EndpointTestCard,
  NatResultCard,
} from './webrtc-diagnostics/EndpointTestCard'
export type { EndpointTestCardProps } from './webrtc-diagnostics/EndpointTestCard'
export {
  HUB_SESSION_RUN_MS,
  HubSessionTestCard,
  pinnedStreamChoices,
} from './webrtc-diagnostics/HubSessionTestCard'
export type { HubSessionTestCardProps } from './webrtc-diagnostics/HubSessionTestCard'
export { RunReport } from './webrtc-diagnostics/RunReport'
export {
  classifyAddressScope,
  parseIceCandidate,
  summarizeHubCandidates,
} from './webrtc-diagnostics/ice-candidates'
export type {
  HubCandidateSummary,
  HubReachabilityFlag,
  ParsedIceCandidate,
} from './webrtc-diagnostics/ice-candidates'
export { compareSrflxMappings } from './webrtc-diagnostics/nat-mapping'
export type { NatMappingVerdict } from './webrtc-diagnostics/nat-mapping'
export {
  emptySessionRun,
  finalizeSessionRun,
  reduceSessionRun,
} from './webrtc-diagnostics/session-run'
export type {
  HubSessionRunReport,
  SessionRunEvent,
  SessionRunState,
} from './webrtc-diagnostics/session-run'
export { classifySessionVerdict } from './webrtc-diagnostics/session-verdict'
export type {
  DiagnosticIcePolicy,
  SessionVerdict,
  SessionVerdictLayer,
} from './webrtc-diagnostics/session-verdict'
export type {
  EndpointTestRow,
  IceServerEntry,
  NatCheckResult,
} from './webrtc-diagnostics/endpoint-test'
export { AutotrackSection } from './cap-settings/AutotrackSection'
export { ConsumablesPanel } from './cap-settings/ConsumablesPanel'
// CapSettingsComponentProps is a plain interface — safe to import from the barrel
// type-only (no module code executes for type-only imports).
export type { CapSettingsComponentProps } from './cap-settings/index'
// MaskShapeItem / MaskShapeCanvasProps are pure interfaces — safe type-only.
export type { MaskShapeCanvasProps, MaskShapeItem } from './cap-settings/MaskShapeCanvas'
// Cap-settings components — resolved by componentId via admin-ui UI_COMPONENTS.
// NOTE: MotionZonesSettings, PrivacyMaskSettings and MaskShapeCanvas are
// intentionally NOT imported here — they pull in react-konva / konva at
// module-evaluation time, adding ~300 KB to the first-paint bundle.
// They are exported lazily from `@camstack/ui-library`'s root index
// (ui-library/src/index.ts).
//
// Each non-konva widget is imported from its OWN file (not from the
// `./cap-settings` barrel) to avoid bundlers evaluating the entire barrel
// and dragging in the konva modules transitively — without `sideEffects:false`
// in package.json, barrel files are treated as side-effectful and all
// re-exported modules are evaluated regardless of named-import tree-shaking.
export { NavigationPanel } from './cap-settings/NavigationPanel'
export { PtzPanel } from './cap-settings/PtzPanel'
export { RecordingPanel } from './cap-settings/RecordingPanel'
export {
  SendFrameToTrainingButton,
  type SendFrameToTrainingButtonProps,
} from './training/send-frame-to-training'
export {
  TrainingCollectionPicker,
  type TrainingCollectionPickerProps,
} from './training/training-collection-picker'
export {
  TrainingBaseModelPicker,
  defaultSingleClusterRoot,
  type TrainingBaseModelPickerProps,
  type TrainingBaseModelRow,
  type TrainingBaseModelPlacement,
} from './training/TrainingBaseModelPicker'
export {
  ROOT_DETECTOR_STEP_ID,
  clusterRootModelIds,
  defaultSelectClusterRoots,
  mapRootDetectorPlacements,
  type RootDetectorDeviceInput,
  type RootDetectorNodeInput,
} from './training/root-detector-placements'
export { type TrainingFrameRefusal, trainingRefusalText } from './training/training-refusal-text'
export type { SceneCaptureVariant } from './cap-settings/scene-monitor-copy'
// The scene copy builders are pure functions over `SceneMonitor` — no React, no
// konva — so the /scenes table can share the exact sentences the editor shows.
// Two implementations of "what does this scene say" is how the table and the
// card end up disagreeing in front of the operator.
export {
  badgeFor,
  coverageLine,
  humanDuration,
  ROI_AREA_WARN_FRACTION,
  roiTooLarge,
  SCENE_CAPTURE_VARIANTS,
  statusLine,
  variantLabel,
} from './cap-settings/scene-monitor-copy'
export * from './code-block'
export type { TranslationFn } from './config-form-builder'
// --- Config Form Builder (ConfigUISchema renderer) ---
export { ConfigFormBuilder } from './config-form-builder'
export type { ProbeState } from './config-form-field'
export {
  isKeychainFieldValue,
  SECRET_MASK_PLACEHOLDER,
  SECRET_REVEAL_MS,
  type SecretEntry,
  SecretFieldControl,
  type SecretFieldProps,
  secretSubmitValue,
  type SecretRevealFn,
  SecretRevealProvider,
} from './config-secret-field'
export {
  ConfigFormField,
  isFieldVisible,
  NodeMultiSelectField,
  NodeSelectField,
} from './config-form-field'
export type { ConfirmActionButtonProps } from './confirm-action-button'
export { ConfirmActionButton } from './confirm-action-button'
export * from './confirm-dialog'
export { ConfirmDialogProvider, useConfirm } from './confirm-dialog'
export type { CopyButtonProps } from './copy-button'
export { CopyButton } from './copy-button'
export type { DataColumn, DataTableProps } from './data-table'
export * from './data-table'
export { DataTable } from './data-table'
export type { DataTablePage, DataTablePaginationLabels } from './data-table-pagination'
export { DEFAULT_PAGINATION_LABELS, paginateRows } from './data-table-pagination'
export type { DataTablePagerProps } from './data-table-pager'
export { DataTablePager } from './data-table-pager'
export type { DataTableSelection } from './data-table-selection'
export type {
  DataTableFacet,
  DataTableFacetGroup,
  DataTableFacetGroupConfig,
  DataTableFilterConfig,
  DataTableFilterState,
} from './data-table-filter'
export {
  dataTableFacetGroups,
  toggleDataTableGroupFacet,
  dataTableFacets,
  EMPTY_DATA_TABLE_FILTER,
  filterDataTableRows,
  isDataTableFilterActive,
  toggleDataTableFacet,
} from './data-table-filter'
export type {
  DataTableFilterBarGroup,
  DataTableFilterBarLabels,
  DataTableFilterBarProps,
} from './data-table-filter-bar'
export { DataTableFilterBar } from './data-table-filter-bar'
export type { DataTableFilter, DataTableFilterGroupView } from './use-data-table-filter'
export { useDataTableFilter } from './use-data-table-filter'
export type { SortHeaderButtonProps } from './sort-header-button'
export { SortHeaderButton } from './sort-header-button'
export type {
  AriaSortValue,
  TableSortDirection,
  TableSortState,
  TableSortValue,
} from './table-sort'
export { ariaSortForColumn, nextSortDirection, nextTableSort, sortRowsByColumn } from './table-sort'
export type { Detection, DetectionCanvasProps } from './detection-canvas'
export { DetectionCanvas } from './detection-canvas'
// --- Detection / Inference components ---
export { CLASS_COLORS, DEFAULT_COLOR, getClassColor } from './detection-colors'
export {
  DisplayPaletteProvider,
  useClassPainter,
  useDisplayPaletteView,
  type DisplayPaletteProviderProps,
  type DisplayPaletteView,
} from './display-palette-context'
export type { DetectionOverlayProps } from './detection-overlay'
// --- Detection overlay ---
export { DetectionOverlay } from './detection-overlay'
export type { DetectionResultTreeProps } from './detection-result-tree'
export { DetectionResultTree } from './detection-result-tree'
export type { DevShellProps } from './dev-shell'
export { DevShell, useDevShell } from './dev-shell'
export type { ActivityTabId, DeviceActivityPanelProps } from './device-activity-panel'
export { DeviceActivityPanel } from './device-activity-panel'
export * from './device-card'
export * from './device-controls'
export type { DeviceExportPanelProps } from './device-export-panel'
// --- Device export (generic `device-export` cap surface) ---
export {
  DEVICE_EXPORT_PAGE_SIZE_KEY,
  DeviceExportPanel,
  DeviceExportSetup,
} from './device-export-panel'
export * from './device-grid'
export * from './device-item'
export * from './device-list'
export type { DeviceBatchToolbarProps } from './device-list/batch-toolbar'
export { DeviceBatchToolbar } from './device-list/batch-toolbar'
// DeviceBatchActionsBar is an internal detail of DeviceList (rendered only by
// its batchActions path) — intentionally NOT re-exported from the public barrel.
export * from './device-meta'
export * from './icon-glyphs'
export * from './icon-picker'
export { DeviceMultiSelectField, DeviceSelectField } from './device-select-field'
export type {
  NotificationTargetOption,
  NotificationTargetSelectFieldProps,
  NotificationTargetsFieldProps,
} from './notification-targets-field'
export {
  ConfigNotificationTargetMultiSelectFieldView,
  ConfigNotificationTargetSelectFieldView,
  NotificationTargetSelectField,
  NotificationTargetsField,
} from './notification-targets-field'
export type {
  DeviceSelectCandidate,
  SuggestedPartition,
  SuggestionFleetDevice,
} from './device-select-filter'
export {
  deviceMatchesFilter,
  deviceOptionLabel,
  devicesToOptions,
  filterDeviceOptions,
  partitionSuggested,
  sameLocationSuggestions,
  selectedDeviceOptions,
} from './device-select-filter'
export type { DeviceSelectorTab, SelectorDevice } from './device-selector-picker'
// v3 DeviceSelector editor — shared by the raw ScopePicker row and the
// simple Access panel, so one wire shape has exactly one editor.
export {
  DeviceSelectorPicker,
  describeDeviceSelector,
  deviceTypeLabel,
  tabForSelector,
} from './device-selector-picker'
export type { DeviceStepMatrixHandle, DeviceStepMatrixProps } from './device-step-matrix'
export { DeviceStepMatrix, nextGridPosition } from './device-step-matrix'
export { DiscoveryPanel } from './discovery-panel'
export type { DoorbellRecentPanelProps } from './doorbell-recent-panel'
export { DoorbellRecentPanel } from './doorbell-recent-panel'
export * from './empty-state'
export * from './error-box'
export * from './section-card'
export type { EventKindGlyphProps } from './event-kind-visuals'
export {
  EVENT_KIND_ICONS,
  EventKindGlyph,
  eventKindLabel,
  resolveEventKindIcon,
} from './event-kind-visuals'
export type { EventStreamProps, FloatingEventStreamProps } from './event-stream'
export { EventStream, FloatingEventStream } from './event-stream'
// --- Extensions panel (D648 slots; `slots` filter for the Customize tab, D676) ---
export { ExtensionsPanel, type ExtensionsPanelProps } from './extensions/ExtensionsPanel.js'
export * from './filter-bar'
export * from './form-field'
export type { GroupedModelSelectorProps } from './grouped-model-selector'
export * from './grouped-tile-picker'
export { GroupedModelSelector } from './grouped-model-selector'
export type { HlsVideoProps } from './hls-video'
// --- HLS VOD player (recorded playback) ---
export { HlsVideo } from './hls-video'
export type { HoverZoomImageProps } from './hover-zoom-image'
export { HoverZoomImage } from './hover-zoom-image'
export type { ImageSelectorProps, ReferenceImage } from './image-selector'
export { ImageSelector } from './image-selector'
export type {
  InferenceAgentOption,
  InferenceBackendOption,
  InferenceConfigSelectorProps,
  InferenceModelOption,
} from './inference-config-selector'
export { InferenceConfigSelector } from './inference-config-selector'
export type { KebabMenuItem, KebabMenuProps } from './kebab-menu'
export { KebabMenu } from './kebab-menu'
export * from './key-value-list'
export type { FloatingLogStreamProps, LogStreamProps } from './log-stream'
export { FloatingLogStream, LogStream } from './log-stream'
export type { LoginFormProps } from './login-form'

// --- Auth / Dev ---
export { LoginForm } from './login-form'
export type { ModelOption } from './model-picker'
export { ModelPicker } from './model-picker'
export type { MountAddonPageOptions } from './mount-addon-page'
export { mountAddonPage } from './mount-addon-page'
export type { NodePickerProps } from './node-picker'
export { NodePicker } from './node-picker'
export * from './page-header'
export * from './page-shell'
export * from './sectioned-page'
export * from './stable-tab-panel'
export * from './section-toolbar'
export * from './item-form-dialog'
export * from './use-item-form-url'
export * from './media-grid'
export type { PhaseIconProps } from './phase-icon'
export { PhaseIcon } from './phase-icon'
export type { PipelineBuilderProps } from './pipeline-builder'
export { PipelineBuilder } from './pipeline-builder'
export type {
  AgentColumn,
  AgentColumnGroup,
  AgentColumnIdentity,
  CellState,
  MatrixSelectedCell,
} from './pipeline-matrix-shared'
export { agentColumnKey, groupAgentColumns, shouldUseSingleNode } from './pipeline-matrix-shared'
export type { PipelineRuntimeOption } from './pipeline-runtime-selector'
export { PipelineRuntimeSelector } from './pipeline-runtime-selector'
export type { PipelineStepDisplayConfig, PipelineStepProps } from './pipeline-step'
// --- Pipeline components ---
export { ConfigSchemaField, PipelineStep } from './pipeline-step'
export * from './provider-badge'
export {
  AddProviderEntryDialog,
  ProviderEntryPills,
} from './provider-entries'
export type {
  AddProviderEntryCreateInput,
  AddProviderEntryDialogProps,
  ProviderEntryPill,
  ProviderEntryPillsProps,
  ProviderEntryStatus,
  ProviderEntryTypeOption,
} from './provider-entries'
export * from './data-records'
export * from './record-entries'
export * from './storage-records'
export type { PTZOverlayProps } from './ptz-overlay'
export { PTZOverlay } from './ptz-overlay'
export type { QrCodeProps } from './qr-code'
export { QrCode } from './qr-code'
export type { ReconnectAction, ReconnectPolicy } from './reconnect-schedule'
export { nextReconnectAction, RECONNECT_POLICY } from './reconnect-schedule'
export type {
  EffectiveStepModelInput,
  StepModelCatalog,
  StepModelFormatBuilds,
} from './resolve-step-default-model'
export {
  resolveEffectiveDefaultModel,
  resolveEffectiveStepModel,
  resolveStepDefaultModel,
  stepHasModelForFormat,
  stepModelOptions,
} from './resolve-step-default-model'
export type { ResponseLogProps } from './response-log'
// --- Debug components ---
export { ResponseLog } from './response-log'
export type { ScopeAccess } from './scope-picker'
// Scope picker (auth) — used by Users / ApiKeys admin pages.
export { ScopePicker, validateScopes } from './scope-picker'
export type { SettingRowElements, SettingRowProps } from './setting-row'
export { SettingRow } from './setting-row'
// The `device-table/` skeleton (DeviceTable / TableStatusDot / IconAction) was
// retired in Phase 5: its responsive table is superseded by the unified
// `device-list` table, and `IconAction` was absorbed into
// `device-list/icon-action.tsx` (re-exported via `export * from './device-list'`
// below). Nothing consumed `DeviceTable`/`TableStatusDot` outside the skeleton.
export type { SnapshotButtonProps, SnapshotButtonTrpc } from './snapshot-button'
export { SnapshotButton } from './snapshot-button'
export * from './stat-card'
export type { StateValuesStreamProps } from './state-values-stream'
export { StateValuesStream } from './state-values-stream'
export * from './status-badge'
export type { StepTimingsProps } from './step-timings'
export { StepTimings } from './step-timings'
// The step matrix's settings panel and its parts (D757).
export * from './step-inspector'
export type { StepTreeNode } from './step-tree'
export { buildStepTreeFromSchema } from './step-tree'
export type { StreamBrokerSelectorProps } from './stream-broker-selector'
// --- Stream broker selector (per-device "preferred stream" picker) ---
export { StreamBrokerSelector } from './stream-broker-selector'
export type { StreamChoice, StreamPanelProps, StreamStats } from './stream-panel'
// --- Stream panel (unified viewer) ---
export { StreamPanel } from './stream-panel'
export type { Timezone, TimezoneDstRule, TimezoneSelectorProps, Weekday } from './timezone-selector'
export { findTimezone, TIMEZONES, TimezoneSelector } from './timezone-selector'
export * from './version-badge'
export * from './widget-panel.js'
export type { WidgetSlotProps } from './widget-slot'
export { WidgetSlot } from './widget-slot'

// --- Option select (dropdown + pills; single/multi) ---
export type {
  OptionSelectMultiProps,
  OptionSelectOption,
  OptionSelectProps,
  OptionSelectSingleProps,
} from './option-select/index.js'
export {
  OptionSelect,
  OPTION_SELECT_SEARCH_MIN_OPTIONS,
  catalogHasDraft,
  draftFromQuery,
  filterOptions as filterOptionSelectOptions,
  optionSearchText as optionSelectSearchText,
  partitionSelected as partitionOptionSelectSelected,
  resolveSearchable as resolveOptionSelectSearchable,
  shouldShowAddNewFooter,
  shouldShowUseQueryRow,
} from './option-select/index.js'

// --- Device picker (shared with admin-ui + addon MFEs; D636) ---
export * from './device-picker/index.js'
export * from './unit-picker/index.js'
export * from './placeholder-field/index.js'
export {
  type RetrainReviewBadgeKind,
  type RetrainReviewBadgeLook,
  type RetrainReviewBadgeProps,
  RetrainReviewBadge,
  retrainReviewBadgeLook,
} from './training/retrain-review-badge'

// --- Charts (uPlot; D899) ---
export * from './charts/index.js'

// --- Device history views (D850, D896) ---
export * from './device-history/index.js'
