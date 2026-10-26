/**
 * Capability definitions — Zod-schema-first, single source of truth.
 *
 * Each capability has its own .cap.ts file. Shared schemas live in schemas/.
 * TypeScript interfaces are inferred via z.infer<> — zero duplication.
 */

// ── Pipeline capability roster ──────────────────────────────────────
//
// Canonical names of the capabilities considered "pipeline-owning":
// anything under this list is an addon whose `getConfigSchema()` is
// rendered on the Pipeline Defaults / per-device Detection tab, and
// whose per-device settings changes trigger an `OrchestrationSettingsUpdated`
// event so the orchestrator can restart detection.
//
// Consumers (backend + admin-ui) import this list instead of hardcoding
// addon ids. Any new addon that declares one of these caps automatically
// participates in the pipeline surface without code changes.

/** Caps that show up in the canonical flow strip (decode → motion → detect → audio → analyze → notify). */
export const PIPELINE_FLOW_CAPABILITY_NAMES: readonly string[] = [
  'decoder',
  'motion-detection',
  'pipeline-executor',
  'audio-analyzer',
  'pipeline-analytics',
  'notification-output',
]

/**
 * Superset that also includes the control-plane capabilities (orchestrator
 * + runner). Used to enumerate addons whose settings belong to the pipeline
 * page — not just flow providers.
 */
export const PIPELINE_OWNER_CAPABILITY_NAMES: readonly string[] = [
  ...PIPELINE_FLOW_CAPABILITY_NAMES,
  'pipeline-orchestrator',
  'pipeline-runner',
]

export type { IAddonPagesAggregatorProvider } from './addon-pages.cap.js'
export { AddonPageInfoSchema, addonPagesCapability } from './addon-pages.cap.js'
export type { IAddonPagesSourceProvider } from './addon-pages-source.cap.js'
export { AddonPageDeclarationSchema, addonPagesSourceCapability } from './addon-pages-source.cap.js'
export { addonRoutesCapability } from './addon-routes.cap.js'
// ── Addon Settings ──────────────────────────────────────────────────
export {
  addonSettingsCapability,
  ConfigSectionWithValuesSchema,
  ConfigTabDeclarationSchema,
  type IAddonSettingsProvider,
  SettingsPatchSchema,
  SettingsSchemaWithValuesSchema,
  SettingsUpdateResultSchema,
} from './addon-settings.cap.js'
export type {
  EnrichedWidgetMetadata,
  IAddonWidgetsAggregatorProvider,
} from './addon-widgets.cap.js'
export { addonWidgetsCapability, EnrichedWidgetMetadataSchema } from './addon-widgets.cap.js'
export type { IAddonWidgetsSourceProvider, WidgetMetadata } from './addon-widgets-source.cap.js'
export {
  addonWidgetsSourceCapability,
  WidgetHostEnum,
  WidgetMetadataSchema,
  WidgetRemoteSchema,
  WidgetSizeEnum,
} from './addon-widgets-source.cap.js'
export type { IAdminUiProvider } from './admin-ui.cap.js'
export { adminUiCapability } from './admin-ui.cap.js'
export type { Alert, AlertSeverity, AlertStatus } from './alerts.cap.js'
// ── Alerts ──────────────────────────────────────────────────────────
export {
  AlertSchema,
  AlertSeveritySchema,
  AlertSourceSchema,
  AlertStatusSchema,
  alertsCapability,
} from './alerts.cap.js'
export { audioAnalysisCapability, type IAudioAnalysisProvider } from './audio-analysis.cap.js'
export type {
  AudioAnalyzerGlobalConfig,
  AudioBackendChoice,
  IAudioAnalyzerProvider,
} from './audio-analyzer.cap.js'
export {
  AUDIO_BACKEND_CHOICES,
  AudioAnalysisResultSchema,
  AudioAnalysisSettingsSchema,
  AudioAttachDeviceInputSchema,
  AudioAttachDeviceResultSchema,
  AudioClassificationResultSchema,
  AudioDetachDeviceResultSchema,
  audioAnalyzerCapability,
  DEFAULT_AUDIO_ANALYZER_CONFIG,
} from './audio-analyzer.cap.js'
export {
  AudioCodecInfoSchema,
  AudioDecodeSessionConfigSchema,
  AudioEncodedChunkSchema,
  AudioEncodeSessionConfigSchema,
  AudioPcmChunkSchema,
  audioCodecCapability,
  type IAudioCodecCapProvider,
  PcmSampleFormatSchema,
} from './audio-codec.cap.js'
export { AuthResultSchema, authProviderCapability } from './auth-provider.cap.js'
export {
  ArchiveEntrySchema,
  ArchiveManifestSchema,
  type BackupArchiveEncryption,
  BackupArchiveEncryptionSchema,
  BackupDestinationInfoSchema,
  type BackupEncryptionStatus,
  BackupEncryptionStatusSchema,
  BackupEntrySchema,
  type BackupRun,
  type BackupRunPhase,
  BackupRunPhaseSchema,
  BackupRunSchema,
  type BackupRunState,
  BackupRunStateSchema,
  type BackupTriggerResult,
  BackupTriggerResultSchema,
  backupCapability,
  type IBackupProvider,
  LocationStatSchema,
} from './backup.cap.js'
// Unified broker registry cap — Phase E2a foundation. Long-term
// replaces `mqtt-broker` (kept alongside for now during HA work).
export {
  BrokerAddInputSchema,
  BrokerGetStateInputSchema,
  type BrokerInfo,
  type BrokerInfo as UnifiedBrokerInfo,
  BrokerInfoSchema,
  BrokerInfoSchema as UnifiedBrokerInfoSchema,
  type BrokerProviderInfo,
  BrokerProviderInfoSchema,
  BrokerPublishInputSchema,
  BrokerRegistryStatusSchema,
  type BrokerStatus as UnifiedBrokerStatus,
  BrokerStatusEnum,
  BrokerSubscribeInputSchema,
  BrokerSubscribeResultSchema,
  BrokerTestConnectionResultSchema,
  BrokerUnsubscribeInputSchema,
  brokerCapability,
  type IBrokerProvider,
} from './broker.cap.js'
export {
  cameraPipelineConfigCapability,
  type ICameraPipelineConfigProvider,
} from './camera-pipeline-config.cap.js'
export {
  cameraStreamsCapability,
  type ICameraStreamsProvider,
  type PickedCamStream,
  PickedCamStreamSchema,
  type PickStreamPreferences,
  PickStreamPreferencesSchema,
  type PickStreamRequirements,
  PickStreamRequirementsSchema,
  type StreamCodec,
  StreamCodecSchema,
} from './camera-streams.cap.js'
export {
  emitsCollectionSelector,
  extractNestedAddonId,
  isArrayOutputSchema,
  isCollectionArrayMethod,
  isObjectInput,
  isVoidInput,
  kebabToCamel,
  looseSchema,
  objectInputDeclaresAddonId,
  objectInputDeclaresRequiredDeviceId,
  procedureAuthKey,
  resolveMethodAuth,
} from './cap-router-predicates.js'
// Core types
export type {
  CapabilityDefinition,
  CapabilityEventSchema,
  CapabilityMethodAuth,
  CapabilityMethodCaller,
  CapabilityMethodKind,
  CapabilityMethodOptions,
  CapabilityMethodSchema,
  CapabilityMountHint,
  CapabilityMountKind,
  CapabilityStatusItemArray,
  CapabilityStatusKind,
  CapabilityStatusSchema,
  CapCaller,
  DeviceConfigDerivedFormUi,
  DeviceConfigSpec,
  DeviceConfigUiSpec,
  DeviceConfigWidgetUi,
  DeviceSettingsContribution,
  InferDeviceProxyCap,
  InferEvents,
  InferName,
  InferNativeProvider,
  InferProvider,
  InferRuntimeState,
  CapabilityHistory,
  CapabilityHistoryField,
  CapabilityHistoryItems,
  HistoryUnit,
  ProviderKind,
  RuntimeStateDurability,
  UiContribution,
  UiContributionKind,
  UiContributionRemote,
} from './capability-definition.js'
export {
  DEFAULT_RUNTIME_STATE_DURABILITY,
  HISTORY_DEFAULT_MIN_INTERVAL_MS,
  HISTORY_UNIT_LABELS,
  historyItemFieldPath,
  DEVICE_SETTINGS_CONTRIBUTION_METHODS,
  DEVICE_STATUS_METHOD,
  event,
  expandCapMethods,
  isDeviceConfigCap,
  method,
  optionalMethod,
  PROVIDER_PIN_FIELD,
  resolveCapMount,
} from './capability-definition.js'
export {
  COMPOSER_RUNNER_ID,
  type ComposerApplyInput,
  ComposerApplyInputSchema,
  type ComposerApplyResult,
  ComposerApplyResultSchema,
  type ComposerBlock,
  ComposerBlockSchema,
  type ComposerBlockVerdict,
  ComposerBlockVerdictSchema,
  type ComposerUnreadableBlock,
  ComposerUnreadableBlockSchema,
  composerCapability,
  type IComposerProvider,
  type UnreleasedClaim,
  UnreleasedClaimSchema,
} from './composer.cap.js'
export {
  CORE_BLOCK_ADDON_PREFIX,
  CORE_BLOCKS_ADDON_ID,
  type CompositionBlockInput,
  CompositionBlockInputSchema,
  type CompositionBlockPatch,
  type CompositionCustomizationRead,
  CompositionCustomizationReadSchema,
  type CompositionGetRead,
  CompositionGetReadSchema,
  type CompositionListRead,
  CompositionListReadSchema,
  type CompositionStateRead,
  CompositionStateReadSchema,
  type CompositionView,
  CompositionViewSchema,
  type CoreBlock,
  type CoreBlockCompileInput,
  CoreBlockCompileInputSchema,
  type CoreBlockCompileResult,
  CoreBlockCompileResultSchema,
  type CoreBlockFiles,
  CoreBlockFilesSchema,
  type CoreBlockInput,
  CoreBlockInputFieldsSchema,
  CoreBlockInputSchema,
  type CoreBlockPlacement,
  CoreBlockPlacementSchema,
  CoreBlockSchema,
  type CoreBlockSource,
  type CoreBlockSourceKind,
  CoreBlockSourceSchema,
  type CoreBlockStatus,
  CoreBlockStatusSchema,
  coreBlockAddonId,
  coreBlockComposition,
  coreBlockIdFromAddonId,
  coreBlockSourceKind,
  coreBlocksCapability,
  DEFAULT_CORE_BLOCK_ENTRY,
  type ICoreBlocksProvider,
  normalizeCoreBlockWrite,
  resolveCoreBlockEntry,
  resolveCoreBlockFiles,
} from './core-blocks.cap.js'
export * from './custom-actions.js'
export type {
  CustomModelDescriptor,
  ICustomModelRegistryProvider,
  ImportModelBundleInput,
  ImportModelBundleResult,
  ModelBundleFile,
} from './custom-model-registry.cap.js'
export {
  CustomModelDescriptorSchema,
  customModelRegistryCapability,
  ImportModelBundleInputSchema,
  ImportModelBundleResultSchema,
  ModelBundleFileSchema,
} from './custom-model-registry.cap.js'
export {
  type DataStoreEngineInfo,
  dataStoreProviderCapability,
  EngineInfoSchema as DataStoreEngineInfoSchema,
  type IDataStoreProvider,
} from './data-store-provider.cap.js'
export {
  type ArchiveSqliteSnapshot,
  ArchiveSqliteSnapshotSchema,
  DATABASE_SNAPSHOT_PARTIAL_SUFFIX,
  DATABASE_SNAPSHOT_SUFFIX,
  DATABASE_SNAPSHOT_TIMEOUT_MS,
  type DatabaseSnapshotRequest,
  DatabaseSnapshotRequestSchema,
  type DatabaseSnapshotResult,
  DatabaseSnapshotResultSchema,
  type DatabaseSnapshotTable,
  DatabaseSnapshotTableSchema,
  type DatabaseSnapshotTargets,
  DatabaseSnapshotTargetsSchema,
  type DatabaseSnapshotWritten,
  DatabaseSnapshotWrittenSchema,
  databaseSnapshotCapability,
  type IDatabaseSnapshotProvider,
} from './database-snapshot.cap.js'
export { CALLER_STAMPED_CAPABILITIES, withoutCallerStamp } from './caller-stamp.js'
export {
  type IStorageAdminProvider,
  type StorageKind,
  StorageKindSchema,
  type StorageTable,
  StorageTableSchema,
  storageAdminCapability,
} from './storage-admin.cap.js'
export {
  type DeclareKindResult,
  DeclareKindResultSchema,
  type IRecordsProvider,
  type RecordInput,
  RecordInputSchema,
  type RecordQueryInput,
  RecordQueryInputSchema,
  type RecordQueryResult,
  RecordQueryResultSchema,
  type RecordView,
  RecordViewSchema,
  type RecordWhere,
  RecordWhereSchema,
  type RecordWhereValue,
  RecordIdSchema,
  RecordBodySchema,
  RecordSecretRefsSchema,
  type RecordTransactOp,
  RecordTransactOpSchema,
  recordsCapability,
} from './records.cap.js'
export {
  type EntryKindInfo,
  EntryKindInfoSchema,
  type EntryView,
  EntryViewSchema,
  type IRecordEntriesProvider,
  recordEntriesCapability,
} from './record-entries.cap.js'
export {
  type IKeychainProvider,
  KEYCHAIN_MAX_REFS_PER_CALL,
  type KeychainResolveEntry,
  KeychainResolveEntrySchema,
  type KeychainResolveResult,
  KeychainResolveResultSchema,
  type KeychainSecretMeta,
  KeychainSecretMetaSchema,
  type KeychainState,
  KeychainStateSchema,
  type KeychainUnavailableReason,
  KeychainUnavailableReasonSchema,
  keychainCapability,
} from './keychain.cap.js'
export {
  DEVICE_HISTORY_ENERGY_KEY,
  DEVICE_HISTORY_QUERY_MANY_MAX_ITEMS,
  DEVICE_HISTORY_ORPHAN_DELETE_MAX,
  DEVICE_HISTORY_ORPHAN_LIST_MAX,
  type DeviceHistoryOrphanDeleteEntry,
  DeviceHistoryOrphanDeleteRefusalSchema,
  type DeviceHistoryOrphanList,
  type DeviceHistoryOrphanReason,
  DeviceHistoryOrphanReasonSchema,
  type DeviceHistoryOrphanSeries,
  type DeviceHistoryTierRows,
  type DeviceHistoryStatus,
  DeviceHistoryStatusSchema,
  type DeviceHistoryIngestResult,
  type DeviceHistoryKind,
  DeviceHistoryKindSchema,
  type DeviceHistoryProducerKind,
  DeviceHistoryProducerKindSchema,
  type DeviceHistoryQueryManyEntry,
  type DeviceHistoryQueryManyItem,
  type DeviceHistoryQueryResult,
  type DeviceHistoryQueryPoint,
  type DeviceHistoryRefusalReason,
  DeviceHistoryRefusalReasonSchema,
  type DeviceHistoryResolution,
  DeviceHistoryResolutionSchema,
  type DeviceHistorySeriesInfo,
  type DeviceHistorySubject,
  DeviceHistorySubjectSchema,
  type IDeviceHistoryProvider,
  deviceHistoryCapability,
} from './device-history.cap.js'
export {
  type DeviceCaStatus,
  DeviceCaStatusSchema,
  type DeviceCertificateSettings,
  DeviceCertificateSettingsSchema,
  deviceCredentialsCapability,
  type IDeviceCredentialsProvider,
} from './device-credentials.cap.js'
export {
  type HttpsLeafInfo,
  HttpsLeafInfoSchema,
  type INodeCertificatesProvider,
  type MeshLeafInfo,
  MeshLeafInfoSchema,
  type NodeHttpsState,
  NodeHttpsStateSchema,
  nodeCertificatesCapability,
} from './node-certificates.cap.js'
export {
  type IKeychainAdminProvider,
  KEYCHAIN_RESET_CONFIRMATION,
  type KeychainAdminSecret,
  KeychainAdminSecretSchema,
  type KeychainAuditAction,
  KeychainAuditActionSchema,
  type KeychainAuditEntry,
  KeychainAuditEntrySchema,
  type KeychainKeySource,
  type KeychainKeySourceKind,
  KeychainKeySourceKindSchema,
  KeychainKeySourceSchema,
  KEYCHAIN_RESET_TRIGGER_ACTOR,
  type KeychainResetRecord,
  KeychainResetRecordSchema,
  type KeychainSecretUsage,
  KeychainSecretUsageSchema,
  type KeychainStatus,
  KeychainStatusSchema,
  keychainAdminCapability,
  type SystemHeldSecretName,
  SystemHeldSecretNameSchema,
} from './keychain-admin.cap.js'
export type {
  DecoderHwAccelConfig,
  HwAccelChoice,
  IDecoderCapProvider,
} from './decoder.cap.js'
export {
  DEFAULT_DECODER_HWACCEL_CONFIG,
  decoderCapability,
  HWACCEL_OPTIONS,
} from './decoder.cap.js'
export {
  detectionPipelineCapability,
  type IDetectionPipelineProvider,
} from './detection-pipeline.cap.js'
export {
  type AdminLinkTarget,
  AdminLinkTargetEnum,
  type DeviceAdminLink,
  DeviceAdminLinkSchema,
  deviceAdminLinkCapability,
  type IDeviceAdminLinkProvider,
} from './device-admin-link.cap.js'
export {
  buildDeviceAdminUrl,
  type DeviceAdminBase,
  type DeviceAdminBaseRefusal,
  type DeviceAdminBaseResult,
  type DeviceAdminScheme,
  type DeviceAdminUrlParts,
  type DeviceAdminUrlRefusal,
  type DeviceAdminUrlResult,
  parseAdminBase,
} from './device-admin-link-url.js'
// Generic device-adoption cap.
export {
  AdoptInputSchema as AdoptionAdoptInputSchema,
  type AdoptionFilter,
  AdoptionFilterSchema,
  type AdoptionStatus,
  AdoptionStatusSchema,
  AdoptResultSchema as AdoptionAdoptResultSchema,
  CandidateQueryFilterSchema,
  deviceAdoptionCapability,
  GetCandidateInputSchema as AdoptionGetCandidateInputSchema,
  type IDeviceAdoptionProvider,
  ListCandidatesInputSchema as AdoptionListCandidatesInputSchema,
  ListCandidatesOutputSchema as AdoptionListCandidatesOutputSchema,
  ReleaseInputSchema as AdoptionReleaseInputSchema,
} from './device-adoption.cap.js'
export type { IDeviceExportProvider } from './device-export.cap.js'
export {
  DeviceExportStatusSchema,
  deviceExportCapability,
  ExportSetupFieldSchema,
  ExportSetupSchema,
  ExposedDeviceSchema,
  ExposeInputSchema as DeviceExportExposeInputSchema,
  UnexposeInputSchema as DeviceExportUnexposeInputSchema,
} from './device-export.cap.js'
export type {
  ExtensionCandidate,
  ExtensionCandidates,
  ExtensionSetResult,
  ExtensionSetSlotInput,
  ExtensionSlotActivation,
  ExtensionSlotRefInput,
  ExtensionSlotRow,
  ExtensionSlotSource,
  ExtensionSlotState,
  ExtensionSlotUnreachable,
  ExtensionSource,
  ExtensionSourceAvailability,
  ExtensionSourceHealth,
  IDeviceExtensionProvider,
} from './device-extension.cap.js'
export {
  deviceExtensionCapability,
  EXTENSION_SLOT_LISTING_METHOD,
  EXTENSION_SLOT_REF_SEPARATOR,
  ExtensionCandidateSchema,
  ExtensionCandidatesSchema,
  ExtensionSetResultSchema,
  ExtensionSetSlotInputSchema,
  ExtensionSlotActivationSchema,
  ExtensionSlotRefInputSchema,
  ExtensionSlotRowSchema,
  ExtensionSlotSourceSchema,
  ExtensionSlotStateSchema,
  ExtensionSlotUnreachableSchema,
  ExtensionSourceAvailabilitySchema,
  ExtensionSourceHealthSchema,
  ExtensionSourceSchema,
  unreachableExtensionSlotRow,
} from './device-extension.cap.js'
export type {
  CleanupDeletedDevicesResult,
  DeviceInfo,
  DeviceManagerApplyInitialMetaInput,
  DeviceTombstone,
  OrphanDeviceData,
} from './device-manager.cap.js'
export {
  CleanupDeletedDevicesResultSchema,
  ConfigEntrySchema,
  DEVICE_CHILDREN_BATCH_MAX,
  DEVICE_TOMBSTONE_RETENTION_MS,
  DeviceInfoSchema,
  DeviceTombstoneSchema,
  OrphanDeviceDataSchema,
  deviceManagerCapability,
  type IDeviceManagerProvider,
  LINKED_DEVICES_SLOT,
  type LinkedDevice,
  LinkedDeviceSchema,
  type LinkedDevicesMode,
  LinkedDevicesModeSchema,
  type LinkedDevicesSlotValue,
  LinkedDevicesSlotValueSchema,
  type MigrateDeviceResult,
  MigrateDeviceResultSchema,
  type MigrateSwitchOutcome,
  MigrateSwitchOutcomeSchema,
  type MigrateSwitchReport,
  MigrateSwitchReportSchema,
  type WrapperActivationRead,
  WrapperActivationReadSchema,
} from './device-manager.cap.js'
// ── Providers & Integrations ─────────────────────────────────────────
export {
  DiscoveredDeviceSchema,
  deviceProviderCapability,
  ProviderStatusSchema,
} from './device-provider.cap.js'
export {
  type ClaimOutcome,
  ClaimOutcomeSchema,
  type ClaimsListing,
  ClaimsListingSchema,
  deviceStateCapability,
  type FieldClaim,
  type FieldClaimMode,
  FieldClaimModeSchema,
  FieldClaimSchema,
} from './device-state.cap.js'
export type {
  EmbeddingFailedModel,
  EmbeddingFailedRequirement,
  EmbeddingModelFailure,
  EmbeddingRefusal,
  EmbeddingRefusalCode,
  EmbeddingTower,
  IEmbeddingEncoderProvider,
} from './embedding-encoder.cap.js'
export {
  EMBEDDING_MODEL_FAILED,
  EMBEDDING_REQUIREMENTS_FAILED,
  EMBEDDING_REQUIREMENTS_UNAVAILABLE,
  EmbeddingFailedModelSchema,
  EmbeddingFailedRequirementSchema,
  EmbeddingInfoSchema,
  EmbeddingRefusalCodeSchema,
  EmbeddingResultSchema,
  EmbeddingTowerSchema,
  embeddingEncoderCapability,
  embeddingModelFailedError,
  embeddingModelFailedOf,
  embeddingRefusalOf,
  embeddingRequirementsFailedError,
  embeddingRequirementsUnavailableError,
  isEmbeddingModelFailed,
} from './embedding-encoder.cap.js'
export type {
  DeviceDataEntry,
  DeviceRemovedInput,
  DeviceRemovedResult,
  IDeviceRemovalHookProvider,
} from './device-removal-hook.cap.js'
export {
  DeviceDataEntrySchema,
  DeviceRemovedInputSchema,
  DeviceRemovedResultSchema,
  deviceRemovalHookCapability,
} from './device-removal-hook.cap.js'
export type {
  FailureContribution,
  IFailureContributionProvider,
} from './failure-contribution.cap.js'
export {
  FailureContributionSchema,
  FailureReasonCountSchema,
  failureContributionCapability,
} from './failure-contribution.cap.js'
export {
  filesystemBrowseCapability,
  type IFilesystemBrowseProvider,
} from './filesystem-browse.cap.js'
export {
  AUTOMATIC_HUB_ADDRESS_FLAGS,
  checkRoleAddress,
  HUB_ADDRESS_ROLES,
  type HubAddressCheck,
  type HubAddressFlags,
  type HubAddressRole,
  type HubAddressRoleResolution,
  type HubAddressRoles,
  type HubAddressSource,
  type HubAppConnectionsResolution,
  HUB_MDNS_QUERY_NAME,
  HUB_MDNS_ROLE,
  HUB_MDNS_SERVICE_TYPE,
  HUB_MDNS_TXT_KEYS,
  AGENT_MDNS_QUERY_NAME,
  AGENT_MDNS_SERVICE_TYPE,
  AGENT_MDNS_TXT_KEYS,
  hubAddressHostname,
  isDefaultAppConnectionEndpoint,
  isSingleHubAddressRole,
  PUBLIC_ENDPOINT_HTTP_REASON,
  resolveAppConnections,
  resolveHubAddressRoles,
  resolveInternalAddress,
  resolveNotificationTapAddress,
  resolvePublicEndpoint,
  SINGLE_HUB_ADDRESS_ROLES,
  type SingleHubAddressRole,
  selectAppConnectionEndpoints,
  validateCustomAddress,
} from './hub-address.js'
export { addonCatalogHref } from './addon-catalog-href.js'
export {
  type HfModelResolution,
  HfModelResolutionSchema,
  type ILlmProvider,
  type LlmDefault,
  LlmDefaultSchema,
  type LlmDefaultSelector,
  LlmDefaultSelectorSchema,
  LLM_PROFILE_KIND_PATTERN,
  type LlmListModelsErrorCode,
  LlmListModelsErrorCodeSchema,
  type LlmListModelsInput,
  LlmListModelsInputSchema,
  type LlmListModelsResult,
  LlmListModelsResultSchema,
  type LlmModelFeatures,
  LlmModelFeaturesSchema,
  type LlmModelInfo,
  LlmModelInfoSchema,
  type LlmProfile,
  type LlmProfileField,
  LlmProfileFieldSchema,
  type LlmProfileKind,
  type LlmProfileKindDescriptor,
  LlmProfileKindDescriptorSchema,
  LlmProfileKindSchema,
  LlmProfileSchema,
  type LlmProviderConfig,
  LlmProviderConfigSchema,
  type LlmProviderWidget,
  LlmProviderWidgetSchema,
  type LlmRuntimeNode,
  LlmRuntimeNodeSchema,
  type LlmUsageRollup,
  LlmUsageRollupSchema,
  llmCapability,
  type ManagedModelCatalogEntry,
  ManagedModelCatalogEntrySchema,
} from './llm.cap.js'
export {
  type RawSecretMigrationInput,
  RawSecretMigrationInputSchema,
  type RawSecretMigrationReport,
  RawSecretMigrationReportSchema,
} from './raw-secret-migration.js'
export {
  type AppleFmAvailability,
  AppleFmAvailabilitySchema,
  type AppleFmUnavailableReason,
  AppleFmUnavailableReasonSchema,
  type ILlmRuntimeProvider,
  type LlmDownloadProgress,
  LlmDownloadProgressSchema,
  type LlmNodeModel,
  LlmNodeModelSchema,
  type LlmRuntimeAppleCompleteInput,
  LlmRuntimeAppleCompleteInputSchema,
  type LlmRuntimeCancelInput,
  LlmRuntimeCancelInputSchema,
  type LlmRuntimeCompleteInput,
  LlmRuntimeCompleteInputSchema,
  type LlmRuntimeDiskUsage,
  LlmRuntimeDiskUsageSchema,
  type LlmRuntimeStatus,
  LlmRuntimeStatusSchema,
  llmRuntimeCapability,
  type ManagedModelExtraFile,
  ManagedModelExtraFileSchema,
  type ManagedModelRef,
  ManagedModelRefSchema,
  type ManagedRuntimeConfig,
  ManagedRuntimeConfigSchema,
} from './llm-runtime.cap.js'
export {
  type LlmErrorCode,
  LlmErrorCodeSchema,
  type LlmGenerateBaseInput,
  LlmGenerateBaseInputSchema,
  type LlmGenerateErr,
  LlmGenerateErrSchema,
  type LlmGenerateOk,
  LlmGenerateOkSchema,
  type LlmGenerateResult,
  LlmGenerateResultSchema,
  type LlmImage,
  LlmImageSchema,
  type LlmRefusalSource,
  LlmRefusalSourceSchema,
  type LlmRetryPolicy,
  LlmRetryPolicySchema,
  LlmTimeoutDefaults,
  type LlmUsage,
  LlmUsageSchema,
} from './llm-shared.js'
export type {
  ILoadContributionProvider,
  LoadContribution,
  LoadContributionAttribution,
  LoadContributionRole,
} from './load-contribution.cap.js'
export {
  LOAD_CONTRIBUTION_ATTRIBUTIONS,
  LOAD_CONTRIBUTION_ROLES,
  LoadContributionSchema,
  loadContributionCapability,
} from './load-contribution.cap.js'
export type { ILogChannelsProvider, LogChannelApplyResult } from './log-channels.cap.js'
export { LogChannelApplyResultSchema, logChannelsCapability } from './log-channels.cap.js'
export {
  LogEntrySchema,
  LogLevelSchema,
  LogReadQuerySchema,
  LogReadEntrySchema,
  LogReadResultSchema,
  LogReadCapabilitiesSchema,
  logDestinationCapability,
} from './log-destination.cap.js'
export type {
  LogReadQuery,
  LogReadEntry,
  LogReadResult,
  LogReadCapabilities,
} from './log-destination.cap.js'
export type {
  ILoginMethodProvider,
  LoginMethodContribution,
  LoginStage,
  PasskeyLoginMethod,
  RedirectLoginMethod,
  WidgetLoginMethod,
} from './login-method.cap.js'
export {
  LoginMethodContributionSchema,
  LoginStageEnum,
  loginMethodCapability,
  PasskeyLoginMethodSchema,
  RedirectLoginMethodSchema,
  WidgetLoginMethodSchema,
} from './login-method.cap.js'
export {
  type IMetricsProvider,
  metricsProviderCapability,
  SystemMetricsSchema,
} from './metrics-provider.cap.js'
export type {
  IModelConvertProvider,
  ModelConvertInput,
} from './model-convert.cap.js'
export {
  ModelConvertInputSchema,
  modelConvertCapability,
} from './model-convert.cap.js'
export type {
  IModelDistributorProvider,
  ModelDistributeInput,
  ModelDistributeResult,
} from './model-distributor.cap.js'
export {
  ModelDistributeInputSchema,
  ModelDistributeResultSchema,
  modelDistributorCapability,
} from './model-distributor.cap.js'
export type {
  IMotionDetectionProvider,
  MotionAnalysisResult,
  MotionRegion,
} from './motion-detection.cap.js'
// ── Detection ────────────────────────────────────────────────────────
export {
  MotionAnalysisResultSchema,
  MotionRegionSchema,
  motionDetectionCapability,
} from './motion-detection.cap.js'
export type {
  BrokerConnectionDetails,
  BrokerInfo as MqttBrokerInfo,
  BrokerStatus as MqttBrokerLiveStatus,
  IMqttBrokerProvider,
} from './mqtt-broker.cap.js'
export {
  AddBrokerInputSchema,
  BrokerConnectionDetailsSchema,
  BrokerInfoSchema as MqttBrokerInfoSchema,
  MqttBrokerStatusSchema,
  mqttBrokerCapability,
  StartEmbeddedInputSchema,
} from './mqtt-broker.cap.js'
export type {
  NetworkAccessStatus,
  NetworkEndpoint,
  NetworkTunnelStartedData,
} from './network-access.cap.js'
export {
  NetworkAccessStatusSchema,
  NetworkEndpointSchema,
  NetworkTunnelStartedDataSchema,
  networkAccessCapability,
} from './network-access.cap.js'
export {
  type Attachment,
  type AttachmentMediaType,
  AttachmentMediaTypeSchema,
  AttachmentSchema,
  type DiscoveredTarget,
  DiscoveredTargetSchema,
  type INotificationOutputProvider,
  type NotificationAction,
  type NotificationActionIcon,
  NotificationActionIconSchema,
  NotificationActionSchema,
  type NotificationFormat,
  NotificationFormatSchema,
  NotificationSchema,
  notificationOutputCapability,
  type ProbeTargetConfigResult,
  ProbeTargetConfigResultSchema,
  type RenderedAs,
  RenderedAsSchema,
  type SendResult,
  SendResultSchema,
  type Target,
  type TargetKind,
  type TargetKindCaps,
  TargetKindCapsSchema,
  type TargetKindLevel,
  TargetKindLevelSchema,
  TargetKindSchema,
  TargetSchema,
  type TestResult,
  TestResultSchema,
} from './notification-output.cap.js'
export {
  consumableLowPercentOf,
  type INotificationRulesProvider,
  isRetiredClearKey,
  NC_ALARM_DELAY_MAX_SEC,
  NC_ALARM_NONBLOCKING_MAX,
  NC_ALARM_SENSORS_MAX,
  NC_ALARM_SYSTEM_EVENT_KINDS,
  NC_ALARM_TRIGGERED_MAX_SEC,
  NC_AUDIO_DBFS_FLOOR,
  NC_AUTHORABLE_SYSTEM_EVENT_KINDS,
  NC_LEGACY_SYSTEM_EVENT_KINDS,
  NC_BATTERY_CONSUMABLE_SYSTEM_EVENT_KINDS,
  NC_CLIP_POST_ROLL_DEFAULT_SEC,
  NC_CLIP_PRE_ROLL_DEFAULT_SEC,
  NC_CLIP_RETENTION_MAX_SEC,
  NC_CONDITION_CATALOG,
  NC_CONFIRM_DEFAULT_MAX_IMAGE_PX,
  NC_CONFIRM_DEFAULT_TIMEOUT_MS,
  NC_CONFIRM_MAX_TIMEOUT_MS,
  NC_CONFIRM_MIN_TIMEOUT_MS,
  NC_CONSUMABLE_LOW_PERCENT_DEFAULT,
  NC_CONSUMABLE_LOW_PERCENT_MAX,
  NC_CONSUMABLE_SYSTEM_EVENT_KINDS,
  NC_DEFAULT_SNOOZE_MINUTES,
  NC_GROUPING_DEFAULT_SEC,
  NC_GROUPING_MAX_SEC,
  NC_GROUPING_MIN_SEC,
  NC_HISTORY_LIMIT_DEFAULT,
  NC_HISTORY_LIMIT_MAX,
  NC_MAX_PER_TRACK_IMMEDIATE,
  NC_RULE_CLEARABLE_KEYS,
  NC_RULE_RETIRED_CLEAR_KEYS,
  NC_SNOOZE_MAX_MINUTES,
  type NcActionBinding,
  NcActionBindingSchema,
  type NcAlarmBlocking,
  type NcAlarmBlockingEdit,
  NcAlarmBlockingEditSchema,
  NcAlarmBlockingSchema,
  type NcAlarmConfig,
  NcAlarmConfigSchema,
  type NcAlarmCreateProfileInput,
  NcAlarmCreateProfileInputSchema,
  type NcAlarmModeCoverage,
  NcAlarmModeCoverageSchema,
  type NcAlarmModeDelays,
  type NcAlarmModeDelaysEdit,
  NcAlarmModeDelaysEditSchema,
  NcAlarmModeDelaysSchema,
  type NcAlarmModeDeviceList,
  NcAlarmModeDeviceListSchema,
  type NcAlarmNonBlocking,
  type NcAlarmNonBlockingEdit,
  NcAlarmNonBlockingEditSchema,
  NcAlarmNonBlockingSchema,
  type NcAlarmPostTriggeredAction,
  NcAlarmPostTriggeredActionSchema,
  type NcAlarmProfileIdInput,
  NcAlarmProfileIdInputSchema,
  type NcAlarmProfileMeta,
  NcAlarmProfileMetaSchema,
  type NcAlarmProfilesView,
  NcAlarmProfilesViewSchema,
  type NcAlarmRenameProfileInput,
  NcAlarmRenameProfileInputSchema,
  type NcAlarmSecureOnArmEdit,
  NcAlarmSecureOnArmEditSchema,
  type NcAlarmSecureOnArmOff,
  NcAlarmSecureOnArmOffSchema,
  type NcAlarmSensorReading,
  NcAlarmSensorReadingSchema,
  type NcAlarmSensorState,
  NcAlarmSensorStateSchema,
  type NcAlarmSensors,
  type NcAlarmSensorsInput,
  NcAlarmSensorsInputSchema,
  NcAlarmSensorsSchema,
  type NcAlarmSettings,
  type NcAlarmSettingsPatch,
  NcAlarmSettingsPatchSchema,
  NcAlarmSettingsSchema,
  type NcAlarmSkippedDevice,
  NcAlarmSkippedDeviceSchema,
  type NcAlarmSkipReason,
  NcAlarmSkipReasonSchema,
  type NcAudioCondition,
  NcAudioConditionSchema,
  type NcClipRetentionAsk,
  NcClipRetentionAskSchema,
  type NcClipRetentionPlan,
  NcClipRetentionPlanSchema,
  type NcConditionDescriptor,
  NcConditionDescriptorSchema,
  type NcConditions,
  NcConditionsSchema,
  type NcConfirm,
  type NcConfirmExpect,
  NcConfirmExpectSchema,
  NcConfirmSchema,
  type NcCrossing,
  NcCrossingSchema,
  type NcDelivery,
  NcDeliverySchema,
  type NcDeviceStateCondition,
  NcDeviceStateConditionSchema,
  type NcHistoryEntry,
  NcHistoryEntrySchema,
  type NcHistoryFilter,
  NcHistoryFilterSchema,
  type NcHistoryRecordKind,
  NcHistoryRecordKindSchema,
  type NcHistoryStatus,
  NcHistoryStatusSchema,
  type NcHistorySubject,
  NcHistorySubjectSchema,
  type NcHookBindings,
  NcHookBindingsSchema,
  type NcLegacyRuleActionSequence,
  NcLegacyRuleActionSequenceSchema,
  type NcLinkedCameraMode,
  NcLinkedCameraModeSchema,
  type NcMediaFrame,
  NcMediaFrameSchema,
  type NcMediaImage,
  NcMediaImageSchema,
  type NcMediaPolicy,
  NcMediaPolicySchema,
  type NcOccupancyCondition,
  NcOccupancyConditionSchema,
  type NcPlateMatcher,
  NcPlateMatcherSchema,
  type NcRule,
  type NcRuleAction,
  NcRuleActionSchema,
  type NcRuleActionSequence,
  NcRuleActionSequenceSchema,
  type NcRuleActions,
  NcRuleActionsSchema,
  type NcRuleClearableKey,
  NcRuleClearableKeySchema,
  type NcRuleInput,
  NcRuleInputSchema,
  NcRuleKindSchema,
  type NcRuleLastRun,
  NcRuleLastRunSchema,
  type NcRuleLastRuns,
  NcRuleLastRunsSchema,
  type NcRuleNotificationButton,
  NcRuleNotificationButtonSchema,
  type NcRulePatch,
  NcRulePatchSchema,
  NcRuleSchema,
  type NcRuleTarget,
  NcRuleTargetSchema,
  type NcRuleUpdateInput,
  NcRuleUpdateInputSchema,
  type NcSceneCondition,
  NcSceneConditionSchema,
  type NcSchedule,
  NcScheduleSchema,
  type NcScheduleWindow,
  NcScheduleWindowSchema,
  type NcSensorTransition,
  NcSensorTransitionSchema,
  type NcSharedSequence,
  type NcSharedSequenceInput,
  NcSharedSequenceInputSchema,
  NcSharedSequenceSchema,
  type NcSnooze,
  type NcSnoozeInput,
  NcSnoozeInputSchema,
  NcSnoozeSchema,
  type NcSnoozeScope,
  NcSnoozeScopeSchema,
  type NcSnoozeSuppressed,
  NcSnoozeSuppressedSchema,
  type NcStateSummaryPreview,
  type NcStateSummaryPreviewRow,
  NcStateSummaryPreviewRowSchema,
  NcStateSummaryPreviewSchema,
  type NcStateSummaryPreviewSection,
  NcStateSummaryPreviewSectionSchema,
  type NcStateSummarySectionId,
  NC_STATE_SUMMARY_SECTION_IDS,
  NcStateSummarySectionIdSchema,
  type NcStateSummarySplit,
  NcStateSummarySplitSchema,
  type NcSystemEventCondition,
  NcSystemEventConditionSchema,
  type NcSystemEventDelivery,
  type NcSystemEventDeliveryMode,
  NcSystemEventDeliveryModeSchema,
  NcSystemEventDeliverySchema,
  type NcSystemEventKind,
  NcSystemEventKindSchema,
  type NcTemplateFamily,
  NcTemplateFamilySchema,
  type NcTemplateField,
  NcTemplateFieldSchema,
  type NcTemplatePreview,
  type NcTemplatePreviewInput,
  NcTemplatePreviewInputSchema,
  NcTemplatePreviewSchema,
  type NcTemplateVarContext,
  NcTemplateVarContextSchema,
  type NcTemplateVarDescriptor,
  NcTemplateVarDescriptorSchema,
  type NcTemplateVarGroup,
  NcTemplateVarGroupSchema,
  type NcTemplateVarKind,
  NcTemplateVarKindSchema,
  type NcTestResult,
  NcTestResultSchema,
  type NcThrottle,
  type NcThrottleGranularity,
  NcThrottleGranularitySchema,
  NcThrottleSchema,
  type NcZoneCondition,
  NcZoneConditionSchema,
  notificationRulesCapability,
} from './notification-rules.cap.js'
export {
  type IOauthIntegrationProvider,
  type OauthIntegrationDescriptor,
  OauthIntegrationDescriptorSchema,
  oauthIntegrationCapability,
} from './oauth-integration.cap.js'
export {
  type IOidcConnectionsProvider,
  type OidcConnection,
  OidcConnectionSchema,
  type OidcConnectionUpdateInput,
  OidcConnectionUpdateInputSchema,
  oidcConnectionsCapability,
} from './oidc-connections.cap.js'
// analysis-pipeline + analysis-data-persistence caps removed in P12b —
// addon-pipeline-analytics owns post-detection refinement end-to-end
// (Track + per-kind events + media) via its own single cap. See
// pipeline-analytics.cap.ts. track-trail cap removed in P12a — trails
// are `track.positions[]` on the Track schema.
export {
  AnalyticsLtsSeriesSchema,
  type AudioEvent,
  type AudioEventDraft,
  AudioEventSchema,
  type DetectionSource,
  DetectionSourceSchema,
  EVENT_DENSITY_BATCH_MAX,
  type EventDensityBucket,
  EventDensityBucketSchema,
  type EventDensityForDevice,
  EventDensityForDeviceSchema,
  type EventKind,
  type EventKindCategory,
  EventKindCategorySchema,
  type EventKindDescriptor,
  EventKindDescriptorSchema,
  type EventKindIcon,
  EventKindIconSchema,
  EventKindSchema,
  type EventKindsForDevice,
  EventKindsForDeviceSchema,
  type EventMediaKindBreakdown,
  type EventMediaKindFootprint,
  type EventPruneCounts,
  type EventStoreDeviceFootprint,
  type EventStoreFootprint,
  type IPipelineAnalyticsProvider,
  type KeyEvent,
  KeyEventSchema,
  type KeyEventsForDevice,
  type LabelAttribution,
  LabelAttributionSchema,
  type LabelTier,
  LabelTierSchema,
  LTS_SCOPE_CLASS_SEPARATOR,
  type LtsBucket,
  LtsBucketSchema,
  MAX_TRACK_DEBUG_NOTE_LEN,
  type MediaFile,
  type MediaFileBytes,
  type MediaFileInfo,
  MediaFileInfoSchema,
  type MediaFileKind,
  MediaFileKindEnum,
  type MediaFileRef,
  MediaFileRefSchema,
  MediaFileSchema,
  type MotionEvent,
  type MotionEventDraft,
  MotionEventSchema,
  type ObjectEvent,
  type ObjectEventDraft,
  ObjectEventSchema,
  occupancyScope,
  parseOccupancyScope,
  pipelineAnalyticsCapability,
  type RebuildObjectEmbeddingsRefusal,
  RebuildObjectEmbeddingsRefusalSchema,
  type RecentTracksPage,
  RecentTracksPageSchema,
  type RecentTracksQuery,
  RecentTracksQueryInput,
  type RetrainBoxReview,
  RetrainBoxReviewSchema,
  type RetrainDismissed,
  RetrainDismissedSchema,
  type RetrainFrameReview,
  RetrainFrameReviewSchema,
  type RetrainOrigin,
  RetrainOriginSchema,
  type RetrainReviewStatus,
  RetrainReviewStatusSchema,
  type RetrainAnnotation,
  type RetrainAnnotationDraft,
  RetrainAnnotationDraftSchema,
  RetrainAnnotationKindSchema,
  RetrainAnnotationSchema,
  type RetrainAnnotationSource,
  RetrainAnnotationSourceSchema,
  type RetrainArchiveResult,
  RetrainArchiveResultSchema,
  type RetrainArchiveTarget,
  RetrainArchiveTargetSchema,
  type RetrainAssistResult,
  RetrainAssistResultSchema,
  RetrainAssistSubjectSchema,
  RetrainCopyRefusalSchema,
  type RetrainExportFilter,
  RetrainExportFilterSchema,
  type RetrainExportLayout,
  RetrainExportLayoutSchema,
  type AddRetrainFrameFromRecordingResult,
  AddRetrainFrameFromRecordingResultSchema,
  type RetrainDatasetSelection,
  RetrainDatasetSelectionSchema,
  type RetrainDatasetStats,
  RetrainDatasetStatsSchema,
  type RetrainDatasetVersion,
  RetrainDatasetVersionSchema,
  type RetrainTrainingCorpusResolveResult,
  RetrainTrainingCorpusResolveResultSchema,
  type RetrainTrainingCorpusSelection,
  RetrainTrainingCorpusSelectionSchema,
  type RetrainAssistProfile,
  RetrainAssistProfileSchema,
  type RetrainLlmAssistResult,
  RetrainLlmAssistResultSchema,
  type RetrainLlmProposal,
  RetrainLlmProposalSchema,
  type RetrainLlmReview,
  RetrainLlmReviewSchema,
  type RetrainCollection,
  type RetrainCollectionCreateResult,
  RetrainCollectionCreateResultSchema,
  type RetrainCollectionRenameResult,
  RetrainCollectionRenameResultSchema,
  RetrainCollectionSchema,
  type RetrainCorpusFilter,
  RetrainCorpusFilterSchema,
  type RetrainCorpusKpi,
  RetrainCorpusKpiSchema,
  type RetrainCorpusKpiCameraRow,
  RetrainCorpusKpiCameraRowSchema,
  type RetrainCorpusPage,
  RetrainCorpusPageSchema,
  type RetrainCorpusPageFrame,
  RetrainCorpusPageFrameSchema,
  type RetrainFrame,
  type RetrainFrameCandidate,
  RetrainFrameCandidateSchema,
  type RetrainFrameList,
  RetrainFrameListSchema,
  type RetrainFrameOrigin,
  RetrainFrameOriginSchema,
  RetrainFrameSchema,
  type RetrainFrameSelection,
  RetrainFrameSelectionSchema,
  type RetrainFrameWorkState,
  RetrainFrameWorkStateSchema,
  type RetrainMacroClass,
  RetrainMacroClassSchema,
  type RetrainPipelineBox,
  RetrainPipelineBoxSchema,
  type RetrainStatus,
  RetrainStatusSchema,
  type RetrainTrack,
  RetrainTrackSchema,
  type RetrainTransitionResult,
  RetrainTransitionResultSchema,
  type ScoredObjectEvent,
  ScoredObjectEventSchema,
  type SensorEvent,
  SensorEventSchema,
  type Track,
  type TrackCascadeCounts,
  TrackCascadeCountsSchema,
  type TrackEnvelope,
  TrackEnvelopeSchema,
  TrackedDetectionSchema,
  type TrackFlags,
  type TrackFlagsPatch,
  TrackFlagsPatchSchema,
  TrackFlagsSchema,
  type TrackPlacement,
  TrackPlacementSchema,
  type TrackProjection,
  TrackProjectionSchema,
  TrackSchema,
  type TrackSource,
  TrackSourceSchema,
  type TrackState,
  TrackStateSchema,
  type TrackZoneFilter,
  TrackZoneFilterSchema,
  type TrainingExportDeviceTotals,
  TrainingExportDeviceTotalsSchema,
  type TrainingExportSummary,
  TrainingExportSummarySchema,
  type ZoneCrossing,
  type ZoneCrossingDirection,
  ZoneCrossingDirectionSchema,
  ZoneCrossingSchema,
} from './pipeline-analytics.cap.js'
export type {
  EffectiveTuning,
  EffectiveTuningInput,
  NativeCropRef,
  PipelineStepInputOutput,
  PipelineValidationIssue,
  PipelineValidationResult,
  SuppliedRootOutput,
} from './pipeline-executor.cap.js'
export {
  EffectiveTuningSchema,
  ModelSubstitutionSchema,
  NativeCropRefSchema,
  PipelineDefaultStepSchema,
  PipelineEngineChoiceSchema,
  PipelineRunResultBridge,
  PipelineStepInputSchema,
  PipelineValidationIssueSchema,
  PipelineValidationResultSchema,
  pipelineExecutorCapability,
  SuppliedRootOutputSchema,
} from './pipeline-executor.cap.js'
export type {
  CameraAssignmentStatus,
  CameraAudioStatus,
  CameraBrokerProfile,
  CameraBrokerStatus,
  CameraDecoderStatus,
  CameraDetectionPhase,
  CameraDetectionProvisioning,
  CameraDetectionProvisioningState,
  CameraDetectionStatus,
  CameraMotionStatus,
  CameraRecordingMode,
  CameraRecordingStatus,
  CameraSourceStatus,
  CameraDetectionSource,
  CameraSourceStream,
  CameraStatus,
  CameraStatusDegradation,
  CameraStatusDegradationReason,
  CameraStatusStage,
  ClusterModelChoice,
  ClusterModelChoiceUnreadableReason,
  DiskReconcileJob,
  InferenceDeviceExclusionReason,
  IngestOwner,
  NodeInferenceDevice,
  NodeInferenceDevices,
  OccupancyLookAnswer,
  OccupancyLookRefusal,
  OccupancyLookRequest,
  SetCameraSensorsInput,
} from './pipeline-orchestrator.cap.js'
export {
  AgentLoadSummarySchema,
  CameraAssignmentStatusSchema,
  CameraAudioStatusSchema,
  CameraBrokerProfileSchema,
  CameraBrokerStatusSchema,
  CameraDecoderStatusSchema,
  CameraDetectionSourceSchema,
  CameraDetectionPhaseSchema,
  CameraDetectionProvisioningSchema,
  CameraDetectionProvisioningStateSchema,
  CameraDetectionStatusSchema,
  CameraMotionStatusSchema,
  CameraRecordingModeSchema,
  CameraRecordingStatusSchema,
  CameraSourceStatusSchema,
  CameraSourceStreamSchema,
  CameraStatusDegradationReasonSchema,
  CameraStatusDegradationSchema,
  CameraStatusSchema,
  CameraStatusStageSchema,
  CapabilityBindingsSchema,
  CLUSTER_MODEL_CHOICE_UNREADABLE_REASONS,
  ClusterModelChoiceSchema,
  DiskReconcileJobSchema,
  GlobalMetricsSchema,
  INFERENCE_DEVICE_EXCLUSION_REASONS,
  InferenceDeviceExclusionReasonSchema,
  IngestOwnerSchema,
  OccupancyLookAnswerSchema,
  OccupancyLookRefusalSchema,
  OccupancyLookRequestSchema,
  PipelineAssignmentSchema,
  pipelineOrchestratorCapability,
  SetCameraSensorsInputSchema,
} from './pipeline-orchestrator.cap.js'
export type {
  DetailParent,
  DetailResult,
  MotionSource,
  MotionSources,
  OccupancyBurstRefusal,
  ParkedFrameKind,
  ParkedTrackFrame,
  ParkRefusal,
  ParkTrackFrameResult,
  ReportMotionInput,
  RunDetailSubtreeInput,
  RunDetailSubtreeResult,
  RunnerFrameSource,
  RunnerInferenceDevice,
  RunnerJumpStepProvisioning,
  RunStatelessStepInput,
  RunStatelessStepResult,
  StatelessStepRefusal,
} from './pipeline-runner.cap.js'
export {
  type DetectionSources,
  DetectionSourcesSchema,
  FrameLazyCountersSchema,
  FrameLazyMetricsSchema,
  MOTION_SOURCE_LABELS,
  MotionSourceEnum,
  MotionSourcesSchema,
  motionSourceLabel,
  type NativeCropBbox,
  type NativeCropCapResult,
  NativeCropBboxSchema,
  NativeCropResultSchema,
  OccupancyBurstRefusalSchema,
  ParkedFrameKindSchema,
  ParkedTrackFrameSchema,
  ParkRefusalSchema,
  ParkTrackFrameResultSchema,
  pipelineRunnerCapability,
  ReportMotionInputSchema,
  RunnerCameraConfigSchema,
  RunnerCameraDeviceUIFields,
  RunnerFrameSourceSchema,
  RunnerInferenceDeviceSchema,
  RunnerJumpStepProvisioningSchema,
  RunnerLocalLoadSchema,
  RunnerLocalMetricsSchema,
  type SessionTrigger,
  SessionTriggerSchema,
} from './pipeline-runner.cap.js'
export type {
  AudioClassifyOutcome,
  AudioNotClassifiedReason,
} from './schemas/detection-shared.js'
// ── Shared Schemas ───────────────────────────────────────────────────
export {
  AUDIO_NOT_CLASSIFIED_REASONS,
  AudioChunkInputSchema,
  AudioClassificationLabelSchema,
  AudioClassifyOutcomeSchema,
  AudioLevelSchema,
  BoundingBoxSchema,
  FrameInputSchema,
  SpatialDetectionSchema,
} from './schemas/detection-shared.js'
export {
  CameraMetricsSchema,
  CameraMetricsWithDeviceIdSchema,
  OrchestratorMetricsSchema,
} from './schemas/orchestrator-metrics.js'
export type {
  AudioStreamPick,
  CameraStream,
  CamProfile,
  CamStreamKind,
  DecodedAudioChunkWire,
  ProfileRtspEntry,
  ProfileSlot,
  ProfileSlotStatus,
  SubscribeAudioChunksInput,
  SubscribeAudioChunksResult,
} from './schemas/streaming-shared.js'
export {
  AudioChunkFormatSchema,
  AudioStreamPickSchema,
  BrokerStatsSchema,
  BrokerStatusSchema,
  CAM_PROFILE_ORDER,
  CameraStreamSchema,
  CamProfileSchema,
  CamStreamKindSchema,
  CamStreamResolutionSchema,
  DecodedAudioChunkSchema,
  FrameHandleSchema,
  makeProfileBrokerId,
  makeSourceBrokerId,
  ProfileRtspEntrySchema,
  ProfileSlotSchema,
  ProfileSlotStatusSchema,
  parseProfileBrokerId,
  StreamSourceEntrySchema,
  StreamSourceSchema,
  SubscribeAudioChunksInputSchema,
  SubscribeAudioChunksResultSchema,
  selectAssignedProfileSlots,
} from './schemas/streaming-shared.js'
export {
  buildEventKindDescriptor,
  EVENT_KIND_BY_CAP,
  EVENTFUL_CAP_NAMES,
  type SensorEventKindDescriptor,
} from './sensor-event-kinds.js'
export {
  type ImageContract,
  ImageContractSchema,
  type ImageContractState,
  ImageContractStateSchema,
  type IServerManagementProvider,
  type RunnerBootCheck,
  RunnerBootCheckSchema,
  type RunnerRefusal,
  RunnerRefusalSchema,
  type ServerBootMode,
  ServerBootModeSchema,
  type ServerPackageStatus,
  ServerPackageStatusSchema,
  type ServerRollbackInfo,
  ServerRollbackInfoSchema,
  type ServerUpdateActionResult,
  ServerUpdateActionResultSchema,
  type ServerUpdateCheckResult,
  ServerUpdateCheckResultSchema,
  type ServerUpdateOutcome,
  ServerUpdateOutcomeSchema,
  type ServerUpdateState,
  ServerUpdateStateSchema,
  serverManagementCapability,
  type UpdateBlocker,
  UpdateBlockerSchema,
  type WrapperEvidence,
  WrapperEvidenceSchema,
  type WrapperIdentity,
  WrapperIdentitySchema,
  type WrapperKind,
  WrapperKindSchema,
} from './server-management.cap.js'
export {
  type BulkRecord,
  BulkRecordSchema,
  type CollectionColumn,
  CollectionColumnSchema,
  type CollectionIndex,
  CollectionIndexSchema,
  DATA_STORE_DATABASES,
  type DataStoreDatabase,
  DataStoreDatabaseSchema,
  type DeclareCollectionInput,
  DeclareCollectionInputSchema,
  type ISettingsStoreProvider,
  type MutationFilter,
  MutationFilterSchema,
  QueryFilterSchema,
  SettingsRecordSchema,
  type SettingsStoreClient,
  settingsStoreCapability,
} from './settings-store.cap.js'
export type { ISmtpProvider } from './smtp-provider.cap.js'
export {
  SendEmailInputSchema,
  SendEmailResultSchema,
  SmtpStatusSchema,
  smtpProviderCapability,
} from './smtp-provider.cap.js'
export {
  type ISnapshotOrchestrator,
  SnapshotImageSchema,
  snapshotCapability,
} from './snapshot.cap.js'
export type { ISsoBridgeProvider } from './sso-bridge.cap.js'
export { SsoBridgeClaimsSchema, ssoBridgeCapability } from './sso-bridge.cap.js'
// ── Infrastructure ───────────────────────────────────────────────────
export {
  type IStorageCapProvider,
  StorageLocationTypeSchema,
  storageCapability,
} from './storage.cap.js'
export {
  type EvictableUsage,
  type EvictResult,
  type IStorageEvictableProvider,
  storageEvictableCapability,
} from './storage-evictable.cap.js'
export {
  type IStorageMigrationProvider,
  storageMigrationCapability,
} from './storage-migration.cap.js'
export {
  type IStorageOccupancyProvider,
  type StorageOccupancyReport,
  StorageOccupancyReportSchema,
  storageOccupancyCapability,
} from './storage-occupancy.cap.js'
export {
  AbortUploadInputSchema as StorageAbortUploadInputSchema,
  BeginDownloadInputSchema as StorageBeginDownloadInputSchema,
  BeginDownloadResultSchema as StorageBeginDownloadResultSchema,
  BeginUploadInputSchema as StorageBeginUploadInputSchema,
  BeginUploadResultSchema as StorageBeginUploadResultSchema,
  EndDownloadInputSchema as StorageEndDownloadInputSchema,
  FinalizeUploadInputSchema as StorageFinalizeUploadInputSchema,
  type IStorageProviderImpl,
  ProviderInfoSchema as StorageProviderInfoSchema,
  ReadChunkInputSchema as StorageReadChunkInputSchema,
  storageProviderCapability,
  TestLocationResultSchema as StorageTestLocationResultSchema,
  WriteChunkInputSchema as StorageWriteChunkInputSchema,
} from './storage-provider.cap.js'
export type {
  AudioCodecTarget,
  BrokerAudioClient,
  BrokerClients,
  LiveViewerCount,
  BrokerConsumerAttribution,
  BrokerConsumerKind,
  BrokerEncodedClient,
  BrokerRtspClient,
  GetStreamWithCodecInput,
  PlaceholderReason,
  RtpSource,
  VideoCodecTarget,
} from './stream-broker.cap.js'
// ── Streaming ────────────────────────────────────────────────────────
export {
  BrokerAudioClientSchema,
  BrokerClientsSchema,
  LiveViewerCountSchema,
  BrokerConsumerAttributionSchema,
  BrokerConsumerKindSchema,
  BrokerEncodedClientSchema,
  BrokerRtspClientSchema,
  type EgressEncode,
  EgressEncodeSchema,
  type EgressRateControl,
  EgressRateControlSchema,
  type EgressTranscode,
  type EgressTranscodeRequest,
  EgressTranscodeRequestSchema,
  EgressTranscodeSchema,
  type EventMediaArtifact,
  EventMediaArtifactSchema,
  type EventMediaCoverage,
  EventMediaCoverageSchema,
  type EventMediaKind,
  EventMediaKindSchema,
  type EventMediaProduction,
  EventMediaProductionSchema,
  GetStreamWithCodecInputSchema,
  PlaceholderReasonSchema,
  RtpSourceSchema,
  RtspRestreamEntrySchema,
  type StreamBrokerClient,
  type StreamFormat,
  StreamFormatSchema,
  streamBrokerCapability,
} from './stream-broker.cap.js'
export {
  type IStreamSignalsProvider,
  type StreamSignal,
  StreamSignalSchema,
  type StreamSignalsStatus,
  StreamSignalsStatusSchema,
  streamSignalsCapability,
} from './stream-signals.cap.js'
export {
  type ITerminalSessionProvider,
  type TerminalInstanceInfo,
  TerminalInstanceInfoSchema,
  type TerminalLegacyCamera,
  TerminalLegacyCameraSchema,
  type TerminalOutputBatch,
  TerminalOutputBatchSchema,
  type TerminalOutputEvent,
  TerminalOutputEventSchema,
  type TerminalProfileInfo,
  TerminalProfileInfoSchema,
  type TerminalSessionInfo,
  TerminalSessionInfoSchema,
  terminalSessionCapability,
} from './terminal-session.cap.js'
export type { ITurnProvider } from './turn-provider.cap.js'
export { TurnServerSchema, turnProviderCapability } from './turn-provider.cap.js'
export type { IUserPasskeysProvider, PasskeySummary } from './user-passkeys.cap.js'
export { PasskeySummarySchema, userPasskeysCapability } from './user-passkeys.cap.js'
export type { IVectorStoreProvider } from './vector-store.cap.js'
export {
  isVectorIndexDimConflict,
  VECTOR_INDEX_DIM_CONFLICT,
  VectorDeclareIndexInputSchema,
  VectorDeleteByFilterInputSchema,
  VectorDeleteInputSchema,
  VectorDeleteResultSchema,
  type VectorFilter,
  VectorFilterSchema,
  VectorGetInputSchema,
  VectorGetResultSchema,
  type VectorItem,
  VectorItemSchema,
  type VectorMatch,
  VectorMatchSchema,
  type VectorMetadata,
  VectorMetadataSchema,
  type VectorMetric,
  VectorMetricSchema,
  VectorQueryInputSchema,
  VectorQueryResultSchema,
  VectorStatsInputSchema,
  VectorStatsResultSchema,
  VectorUpsertInputSchema,
  VectorUpsertResultSchema,
  vectorIndexDimConflictError,
  vectorStoreCapability,
} from './vector-store.cap.js'
export type {
  Clip,
  ClipBytes,
  ClipBytesOffer,
  ClipPlayback,
  ClipPlaybackOptions,
  ClipSource,
  ClipSourceAvailability,
  ClipStillDisposition,
  ClipStillRefusalCode,
  ClipStreamAudio,
  ClipStreamAudioReason,
  ClipStreamDial,
  ClipWake,
  IVideoclipsProvider,
} from './videoclips.cap.js'
export {
  CLIP_BROKER_PACED_RATES,
  CLIP_PLAYBACK_OPTIONS,
  CLIP_REALTIME_SOURCE_RATES,
  CLIP_REASON_HEADER_MAX,
  CLIP_STILL_DISPOSITION_HEADER,
  CLIP_STILL_REASON_CODE_HEADER,
  CLIP_STILL_REASON_HEADER,
  CLIP_STREAM_SOURCE_RATES,
  CLIP_STREAM_TRANSPORT_HEADER,
  ClipBytesOfferSchema,
  ClipBytesSchema,
  ClipPlaybackOptionsSchema,
  ClipPlaybackSchema,
  ClipSchema,
  ClipSourceAvailabilitySchema,
  ClipSourceSchema,
  ClipStillDispositionSchema,
  ClipStillRefusalCodeSchema,
  ClipStreamAudioReasonSchema,
  ClipStreamAudioSchema,
  ClipStreamDialSchema,
  ClipWakeSchema,
  clipReasonHeaderValue,
  MAX_CLIP_EVENT_IDS,
  MAX_CLIP_LABELS,
  VIDEOCLIPS_MAX_OFFER_BYTES,
  VIDEOCLIPS_MAX_READ_BYTES,
  videoclipsCapability,
} from './videoclips.cap.js'
export {
  buildViewerLink,
  CAMSTACK_APP_LINK_ORIGIN,
  HUB_VIEWER_MOUNT,
  isAppLinkBase,
  type NotificationLinkEndpoint,
  pickAppLinkHub,
  toAppLinkHubOrigin,
  type ViewerDestination,
  type ViewerLinkBase,
  type ViewerLinkForm,
  type ViewerLinkInput,
  viewerLinkBaseOf,
} from './viewer-link-url.js'
export type { IViewerUiProvider } from './viewer-ui.cap.js'
export { viewerUiCapability } from './viewer-ui.cap.js'
export {
  type IWebrtcSessionProvider,
  WEBRTC_CLIMB_HOLD_CODES,
  WEBRTC_TRY_BLOCKERS,
  type WebrtcClientHints,
  type WebrtcClimbHold,
  type WebrtcClimbHoldCode,
  WebrtcClimbHoldSchema,
  type WebrtcLadderDecision,
  WebrtcLadderDecisionSchema,
  type WebrtcSessionDebug,
  WebrtcSessionDebugSchema,
  type WebrtcStreamChoice,
  WebrtcStreamChoiceSchema,
  type WebrtcStreamTarget,
  WebrtcStreamTargetSchema,
  type WebrtcTierFailure,
  WebrtcTierFailureSchema,
  type WebrtcTryBlocker,
  webrtcClientHintsSchema,
  webrtcSessionCapability,
} from './webrtc-session.cap.js'

// scene-intelligence cap removed in P12a — no provider was ever registered
// and no admin UI/addon consumer. If scene queries come back, reintroduce
// as part of the future embedding addon.

export {
  type AccessoriesStatus,
  AccessoriesStatusSchema,
  accessoriesCapability,
  type IAccessoriesProvider,
} from './accessories.cap.js'
export {
  AddonAutoUpdateSchema,
  AddonListItemSchema,
  AutoUpdateSettingsSchema,
  addonsCapability,
  type BulkUpdateItem,
  type BulkUpdateItemStatus,
  type BulkUpdatePhase,
  type BulkUpdateState,
  CustomActionInputSchema,
  type IAddonsProvider,
  InstalledPackageSchema,
  LogStreamEntrySchema,
  type AddonSearchResult,
  type PackageInstallation,
  PackageInstallationSchema,
  type PackageInstallations,
  PackageInstallationsSchema,
  PackageUpdateSchema,
  PackageVersionInfoSchema,
  SearchResultSchema,
  type UninstallNodeOutcome,
  UninstallNodeOutcomeSchema,
  type UninstallNodeResult,
  UninstallNodeResultSchema,
  type UninstallPackageResult,
  UninstallPackageResultSchema,
} from './addons.cap.js'
export {
  type AirQualitySensorStatus,
  AirQualitySensorStatusSchema,
  airQualitySensorCapability,
  type IAirQualitySensorProvider,
} from './air-quality-sensor.cap.js'
export {
  type AlarmArmMode,
  AlarmArmModeSchema,
  type AlarmPanelStatus,
  AlarmPanelStatusSchema,
  type AlarmState,
  AlarmStateSchema,
  alarmPanelCapability,
  type IAlarmPanelProvider,
} from './alarm-panel.cap.js'
export {
  type AmbientLightSensorStatus,
  AmbientLightSensorStatusSchema,
  ambientLightSensorCapability,
  type IAmbientLightSensorProvider,
} from './ambient-light-sensor.cap.js'
export {
  type AudioClassSummary,
  AudioClassSummarySchema,
  type AudioMetricsHistory,
  type AudioMetricsHistoryPoint,
  AudioMetricsHistoryPointSchema,
  AudioMetricsHistorySchema,
  type AudioMetricsSnapshot,
  AudioMetricsSnapshotSchema,
  audioMetricsCapability,
  type IAudioMetricsProvider,
} from './audio-metrics.cap.js'
export {
  type AutomationControlStatus,
  AutomationControlStatusSchema,
  automationControlCapability,
  type IAutomationControlProvider,
} from './automation-control.cap.js'
export {
  type BatteryStatus,
  BatteryStatusSchema,
  batteryCapability,
  type IBatteryProvider,
} from './battery.cap.js'
export {
  type BinaryStatus,
  BinaryStatusSchema,
  binaryCapability,
  type IBinaryProvider,
} from './binary.cap.js'
export {
  type BrightnessStatus,
  BrightnessStatusSchema,
  brightnessCapability,
  type IBrightnessProvider,
} from './brightness.cap.js'
// HA-targeted actuator caps (Phase C4 — fire-only button)
export { buttonCapability, type IButtonProvider } from './button.cap.js'
export type {
  CalendarEvent,
  CalendarInfo,
  CalendarListEventsInput,
  CalendarLocalSpan,
  CalendarSourceKind,
  ICalendarSourceProvider,
} from './calendar-source.cap.js'
export {
  CalendarEventSchema,
  CalendarInfoSchema,
  CalendarListEventsInputSchema,
  CalendarSourceKindSchema,
  calendarEventLocalSpan,
  calendarEventOnLocalDay,
  calendarSourceCapability,
} from './calendar-source.cap.js'
export type {
  CalendarColor,
  CalendarEntry,
  CalendarPreferenceEntry,
  CalendarPreferences,
  CalendarSetPreferenceInput,
  ICalendarsProvider,
} from './calendars.cap.js'
export {
  CalendarColorSchema,
  CalendarEntrySchema,
  CalendarPreferenceEntrySchema,
  CalendarPreferencesSchema,
  CalendarSetPreferenceInputSchema,
  calendarsCapability,
} from './calendars.cap.js'
export {
  type CameraCredentials,
  CameraCredentialsSchema,
  type CameraCredentialsStatus,
  CameraCredentialsStatusSchema,
  cameraCredentialsCapability,
  type ICameraCredentialsProvider,
} from './camera-credentials.cap.js'
export {
  cameraGridLayoutCapability,
  type GridLayoutCell,
  type GridLayoutPatch,
  GridLayoutPatchSchema,
  type GridLayoutView,
  GridLayoutViewSchema,
  type GridNormalizedRect,
  type GridProfileOffer,
  type ICameraGridLayoutProvider,
  type ICameraGridLayoutSettingsProvider,
} from './camera-grid-layout.cap.js'
export {
  type CarbonMonoxideStatus,
  CarbonMonoxideStatusSchema,
  carbonMonoxideCapability,
  type ICarbonMonoxideProvider,
} from './carbon-monoxide.cap.js'
export {
  type ClimateControlStatus,
  ClimateControlStatusSchema,
  climateControlCapability,
  type HvacMode,
  HvacModeSchema,
  type IClimateControlProvider,
} from './climate-control.cap.js'
// HA-targeted actuator caps (Phase C1)
export {
  type ColorHsvTriplet,
  type ColorInput,
  type ColorRgbTriplet,
  type ColorStatus,
  ColorStatusSchema,
  colorCapability,
  type IColorProvider,
} from './color.cap.js'
// Pre-creation credential validation, declared by the integration provider.
export {
  CONNECTION_TEST_TIMEOUT_MS,
  ConnectionTestDescriptorSchema,
  ConnectionTestInputSchema,
  type ConnectionTestOutcome,
  ConnectionTestOutcomeSchema,
  connectionTestCapability,
  type IConnectionTestProvider,
} from './connection-test.cap.js'
export {
  type ConnectivityStatus,
  ConnectivityStatusSchema,
  connectivityCapability,
  type IConnectivityProvider,
} from './connectivity.cap.js'
export {
  type ConsumableItem,
  ConsumableItemSchema,
  type ConsumableForm,
  ConsumableFormSchema,
  consumableFormOf,
  type ConsumableKind,
  ConsumableKindSchema,
  type ConsumableLevel,
  ConsumableLevelSchema,
  type ConsumableStatus,
  ConsumableStatusSchema,
  consumableKindOf,
  type ConsumableRemaining,
  ConsumableRemainingSchema,
  type ConsumableRemainingKind,
  ConsumableRemainingKindSchema,
  type ConsumablesStatus,
  ConsumablesStatusSchema,
  consumablesCapability,
  type IConsumablesProvider,
} from './consumables.cap.js'
// HA-targeted binary sensor cap family (Phase B1)
export {
  type ContactStatus,
  ContactStatusSchema,
  contactCapability,
  type IContactProvider,
} from './contact.cap.js'
// HA-targeted actuator caps (Phase C3)
export {
  type ControlKind,
  ControlKindSchema,
  type ControlSetValueInput,
  type ControlStatus,
  ControlStatusSchema,
  controlCapability,
  type IControlProvider,
} from './control.cap.js'
// HA-targeted actuator caps (Phase C2)
export {
  type CoverState,
  CoverStateSchema,
  type CoverStatus,
  CoverStatusSchema,
  coverCapability,
  type ICoverProvider,
} from './cover.cap.js'
// ── Vendor-neutral camera-config caps (D14 deviceConfig archetype) ──
export {
  type DayNightMode,
  DayNightModeSchema,
  type DayNightOptions,
  DayNightOptionsSchema,
  type DayNightSettingsPatch,
  DayNightSettingsPatchSchema,
  type DayNightStatus,
  DayNightStatusSchema,
  dayNightCapability,
  type IDayNightProvider,
} from './day-night.cap.js'
export {
  type DeviceDiscoveryStatus,
  DeviceDiscoveryStatusSchema,
  type DiscoveredChildDevice,
  DiscoveredChildDeviceSchema,
  type DiscoveredChildStatus,
  DiscoveredChildStatusSchema,
  deviceDiscoveryCapability,
  type IDeviceDiscoveryNativeProvider,
  type IDeviceDiscoveryProvider,
} from './device-discovery.cap.js'
export {
  deviceOpsCapability,
  type IDeviceOpsProvider,
  type RawStateResult,
  RawStateResultSchema,
} from './device-ops.cap.js'
export {
  displayPaletteCapability,
  type IDisplayPaletteProvider,
} from './display-palette.cap.js'
export {
  type DeviceStatus,
  DeviceStatusSchema,
  deviceStatusCapability,
  type IDeviceStatusProvider,
} from './device-status.cap.js'
export {
  type DishwasherAccess,
  DishwasherAccessSchema,
  type DishwasherAvailability,
  DishwasherAvailabilitySchema,
  type DishwasherOperationState,
  DishwasherOperationStateSchema,
  type DishwasherOptionDescriptor,
  DishwasherOptionDescriptorSchema,
  type DishwasherOptions,
  DishwasherOptionsSchema,
  type DishwasherProgram,
  DishwasherProgramSchema,
  type DishwasherState,
  DishwasherStateSchema,
  type DishwasherStatus,
  DishwasherStatusSchema,
  type DishwasherValue,
  DishwasherValueSchema,
  dishwasherCapability,
  type IDishwasherProvider,
} from './dishwasher.cap.js'
export {
  DOORBELL_RISE_DEBOUNCE_MS,
  type DoorbellPressEvent,
  DoorbellPressEventSchema,
  type DoorbellStatus,
  DoorbellStatusSchema,
  doorbellCapability,
  type IDoorbellProvider,
} from './doorbell.cap.js'
export {
  type EnumSensorDateTimeFormat,
  EnumSensorDateTimeFormatSchema,
  type EnumSensorStatus,
  EnumSensorStatusSchema,
  enumSensorCapability,
  type IEnumSensorProvider,
} from './enum-sensor.cap.js'
export {
  type EventEmitterStatus,
  EventEmitterStatusSchema,
  type EventFire,
  EventFireSchema,
  eventEmitterCapability,
  type IEventEmitterProvider,
} from './event-emitter.cap.js'
export {
  type FaceCluster,
  type FaceInfo,
  type FaceSortDirection,
  type FaceSortField,
  faceGalleryCapability,
  type Identity,
  type IdentitySampleAudit,
  type IdentitySampleAuditRow,
  type IdentitySampleInfo,
  type IFaceGalleryProvider,
  type ListRecentFacesInput,
  type SuggestFaceClustersInput,
} from './face-gallery.cap.js'
export {
  type FanControlStatus,
  FanControlStatusSchema,
  type FanDirection,
  FanDirectionSchema,
  fanControlCapability,
  type IFanControlProvider,
} from './fan-control.cap.js'
export {
  type FeatureProbeStatus,
  FeatureProbeStatusSchema,
  featureProbeCapability,
  type IFeatureProbeProvider,
} from './feature-probe.cap.js'
export {
  type FloodStatus,
  FloodStatusSchema,
  floodCapability,
  type IFloodProvider,
} from './flood.cap.js'
export { type GasStatus, GasStatusSchema, gasCapability, type IGasProvider } from './gas.cap.js'
export {
  type GroupStatus,
  GroupStatusSchema,
  groupStatusCapability,
  type IGroupStatusProvider,
} from './group-status.cap.js'
export {
  type HeatingValveStatus,
  HeatingValveStatusSchema,
  heatingValveCapability,
  type IHeatingValveProvider,
} from './heating-valve.cap.js'
export {
  type HumidifierStatus,
  HumidifierStatusSchema,
  humidifierCapability,
  type IHumidifierProvider,
} from './humidifier.cap.js'
export {
  type HumiditySensorStatus,
  HumiditySensorStatusSchema,
  humiditySensorCapability,
  type IHumiditySensorProvider,
} from './humidity-sensor.cap.js'
export {
  type IImageProvider,
  type ImageStatus,
  ImageStatusSchema,
  imageCapability,
} from './image.cap.js'
export {
  type BacklightMode,
  BacklightModeSchema,
  type ExposureMode,
  ExposureModeSchema,
  type IImageSettingsProvider,
  type ImageRotate,
  ImageRotateSchema,
  type ImageSettingsOptions,
  ImageSettingsOptionsSchema,
  type ImageSettingsPatch,
  ImageSettingsPatchSchema,
  type ImageSettingsStatus,
  ImageSettingsStatusSchema,
  imageSettingsCapability,
  type WhiteBalanceMode,
  WhiteBalanceModeSchema,
} from './image-settings.cap.js'
export {
  AvailableIntegrationTypeSchema,
  CreateIntegrationInputSchema,
  DeleteIntegrationResultSchema,
  type IIntegrationsProvider,
  IntegrationLiteSchema,
  type IntegrationTestConnectionResult,
  type IntegrationTestConnectionStatus,
  IntegrationWithStateSchema,
  integrationsCapability,
  TestConnectionResultSchema,
  TestConnectionStatusEnum,
  UpdateIntegrationInputSchema,
} from './integrations.cap.js'
export {
  type IIntercomProvider,
  type IntercomAbility,
  IntercomAbilitySchema,
  type IntercomStatus,
  IntercomStatusSchema,
  intercomCapability,
} from './intercom.cap.js'
export {
  type DeviceCodeSeverity,
  DeviceCodeSeveritySchema,
  type ILawnMowerControlProvider,
  type LawnMowerActivity,
  LawnMowerActivitySchema,
  type LawnMowerControlStatus,
  LawnMowerControlStatusSchema,
  lawnMowerControlCapability,
} from './lawn-mower-control.cap.js'
// ── Local network (hub-only host interface enumeration) ────────────
export {
  type AdvertisedLocalPort,
  type ConnectionEndpoint,
  type HubAddressBook,
  type HubAddresses,
  HubAddressRoleSchema,
  type HubAddressRow,
  type HubAddressSnapshot,
  type ILocalNetworkProvider,
  type LocalInterface,
  localNetworkCapability,
  type NotificationEndpoint,
} from './local-network.cap.js'
export {
  type ILockControlProvider,
  type LockControlStatus,
  LockControlStatusSchema,
  type LockState,
  LockStateSchema,
  lockControlCapability,
} from './lock-control.cap.js'
export {
  type MaskGridDims,
  MaskGridDimsSchema,
  type MaskGridShape,
  MaskGridShapeSchema,
  type MaskLineShape,
  MaskLineShapeSchema,
  type MaskPoint,
  MaskPointSchema,
  type MaskPolygonShape,
  MaskPolygonShapeSchema,
  type MaskPolygonVertices,
  MaskPolygonVerticesSchema,
  type MaskRectShape,
  MaskRectShapeSchema,
  type MaskShape,
  type MaskShapeKind,
  MaskShapeKindSchema,
  MaskShapeSchema,
} from './mask-shape.js'
export {
  type IMediaPlayerProvider,
  type MediaInfo,
  type MediaPlayerRepeat,
  MediaPlayerRepeatSchema,
  type MediaPlayerState,
  MediaPlayerStateSchema,
  type MediaPlayerStatus,
  MediaPlayerStatusSchema,
  mediaPlayerCapability,
} from './media-player.cap.js'
// ── Mesh networks (Tailscale / Headscale / ZeroTier) ────────────────
//
// Per-provider access from the admin UI uses the `mesh-network`
// collection cap's generic per-`addonId` routing — there is no
// singleton facade cap.
export {
  type IMeshNetworkProvider,
  type MeshEndpoint,
  type MeshPeer,
  MeshPeerSchema,
  type MeshStatus,
  MeshStatusSchema,
  meshNetworkCapability,
} from './mesh-network.cap.js'
export {
  type IMotionProvider,
  MOTION_CLOSE_AFTER_MS,
  MOTION_SPAN_TIMEOUT_MS,
  type MotionOnMotionChangedData,
  MotionOnMotionChangedDataSchema,
  type MotionStatus,
  MotionStatusSchema,
  motionCapability,
} from './motion.cap.js'
export {
  type IMotionTriggerProvider,
  type MotionTriggerRuntimeState,
  MotionTriggerRuntimeStateSchema,
  type MotionTriggerStatus,
  MotionTriggerStatusSchema,
  motionTriggerCapability,
} from './motion-trigger.cap.js'
export {
  type IMotionZonesProvider,
  type MotionZoneOptions,
  MotionZoneOptionsSchema,
  type MotionZonePatch,
  MotionZonePatchSchema,
  type MotionZoneRegion,
  MotionZoneRegionSchema,
  type MotionZoneStatus,
  MotionZoneStatusSchema,
  motionZonesCapability,
} from './motion-zones.cap.js'
export {
  type INativeObjectDetectionProvider,
  type NativeDetection,
  NativeDetectionSchema,
  type NativeObjectClass,
  NativeObjectClassEnum,
  type NativeObjectDetectionOptions,
  NativeObjectDetectionOptionsSchema,
  type NativeObjectDetectionRuntimeState,
  NativeObjectDetectionRuntimeStateSchema,
  type NativeObjectDetectionSettingsPatch,
  NativeObjectDetectionSettingsPatchSchema,
  type NativeObjectDetectionStatus,
  NativeObjectDetectionStatusSchema,
  type NativeObjectGeometry,
  NativeObjectGeometryEnum,
  nativeObjectDetectionCapability,
} from './native-object-detection.cap.js'
export {
  type INavigationProvider,
  NAVIGATION_ACTION_CATALOG,
  NAVIGATION_LIGHT_LEVEL_MAX,
  NAVIGATION_LIGHT_LEVEL_MIN,
  type NavigationActionEntry,
  NavigationActionEntrySchema,
  type NavigationActionId,
  NavigationActionIdSchema,
  type NavigationEntryKind,
  NavigationEntryKindSchema,
  type NavigationFeatures,
  NavigationFeaturesSchema,
  type NavigationLightMode,
  NavigationLightModeSchema,
  type NavigationMode,
  NavigationModeSchema,
  type NavigationMoveCommand,
  NavigationMoveCommandSchema,
  type NavigationPoint,
  NavigationPointSchema,
  type NavigationRuntimeState,
  NavigationRuntimeStateSchema,
  type NavigationStatus,
  NavigationStatusSchema,
  navigationCapability,
} from './navigation.cap.js'
export {
  type INetworkLinkProvider,
  NETWORK_LINK_TYPES,
  NETWORK_LINK_UNKNOWN,
  type NetworkLinkStatus,
  NetworkLinkStatusSchema,
  type NetworkLinkType,
  networkLinkCapability,
  signalPercentFromBars,
  signalPercentFromRssi,
} from './network-link.cap.js'
export {
  ClientNetworkStatsSchema,
  DeviceNetworkStatsSchema,
  type INetworkQualityProvider,
  networkQualityCapability,
  StreamNetworkStatsSchema,
} from './network-quality.cap.js'
export {
  ClusterAddonNodeDeploymentSchema,
  ClusterAddonStatusEntrySchema,
  type INodesProvider,
  type NodeDirectory,
  type NodeDirectoryEntry,
  NodeDirectoryEntrySchema,
  NodeDirectorySchema,
  nodesCapability,
  TopologyNodeSchema,
  TopologyProcessSchema,
  TopologyServiceSchema,
} from './nodes.cap.js'
export {
  type INotifierProvider,
  type NotifierAction,
  type NotifierPriority,
  type NotifierSendInput,
  type NotifierSendResult,
  type NotifierStatus,
  NotifierStatusSchema,
  type NotifierSupports,
  notifierCapability,
} from './notifier.cap.js'
export {
  type INumericSensorProvider,
  type NumericSensorStatus,
  NumericSensorStatusSchema,
  numericSensorCapability,
} from './numeric-sensor.cap.js'
export {
  type IOsdProvider,
  type OsdOverlay,
  type OsdOverlayKind,
  OsdOverlayKindEnum,
  OsdOverlayPatchSchema,
  OsdOverlaySchema,
  type OsdPosition,
  OsdPositionEnum,
  type OsdStatus,
  OsdStatusSchema,
  osdCapability,
} from './osd.cap.js'
export {
  type IOsdManagerProvider,
  type OsdNamedTemplate,
  OsdNamedTemplateSchema,
  type OsdRenderOutcome,
  OsdRenderOutcomeEnum,
  type OsdRenderResult,
  OsdRenderResultSchema,
  type OsdSlotBinding,
  OsdSlotBindingSchema,
  type OsdSlotView,
  OsdSlotViewSchema,
  type OsdSource,
  type OsdSourceOption,
  OsdSourceOptionSchema,
  OsdSourceSchema,
  type OsdSourceValueType,
  OsdSourceValueTypeEnum,
  type OsdTemplateBinding,
  OsdTemplateBindingSchema,
  type OsdTemplateFormat,
  OsdTemplateFormatSchema,
  type OsdTemplatePick,
  OsdTemplatePickSchema,
  type OsdTemplateTokenKind,
  OsdTemplateTokenKindSchema,
  osdManagerCapability,
} from './osd-manager.cap.js'
export {
  type IPetFeederProvider,
  PET_FEEDER_MANUAL_FEED_MAX,
  PET_FEEDER_MANUAL_FEED_MIN,
  type PetFeederStatus,
  PetFeederStatusSchema,
  petFeederCapability,
} from './pet-feeder.cap.js'
export {
  type IPlateGalleryProvider,
  type PlateInfo,
  plateGalleryCapability,
  type Vehicle,
  type VehicleSampleInfo,
} from './plate-gallery.cap.js'
// ── Platform probe (per-node hardware + inference backend scoring) ─
export {
  type AcceleratorRescan,
  type HardwareDecodeAccels,
  type HardwareEncoderId,
  type HardwareEncoderProbe,
  type HardwareEncoders,
  type IPlatformProbeProvider,
  platformProbeCapability,
} from './platform-probe.cap.js'
// HA-targeted multi-metric + generic sensor caps (Phase B3)
export {
  type IPowerMeterProvider,
  type PowerMeterStatus,
  PowerMeterStatusSchema,
  powerMeterCapability,
} from './power-meter.cap.js'
export {
  type GpsLocation,
  type IPresenceProvider,
  type PresenceStatus,
  PresenceStatusSchema,
  presenceCapability,
} from './presence.cap.js'
export {
  type IPressureSensorProvider,
  type PressureSensorStatus,
  PressureSensorStatusSchema,
  pressureSensorCapability,
} from './pressure-sensor.cap.js'
export {
  type IPrivacyMaskProvider,
  type PrivacyMaskOptions,
  PrivacyMaskOptionsSchema,
  type PrivacyMaskPatch,
  PrivacyMaskPatchSchema,
  type PrivacyMaskRegion,
  PrivacyMaskRegionSchema,
  type PrivacyMaskShape,
  PrivacyMaskShapeSchema,
  type PrivacyMaskStatus,
  PrivacyMaskStatusSchema,
  privacyMaskCapability,
  summarisePrivacyAudio,
} from './privacy-mask.cap.js'
// ── Device-Scoped Camera Caps ───────────────────────────────────────
export {
  type IPtzProvider,
  type PtzHomePreset,
  PtzHomePresetSchema,
  type PtzHomeReturn,
  PtzHomeReturnSchema,
  PtzMoveCommandSchema,
  type PtzOptions,
  PtzOptionsSchema,
  PtzPositionSchema,
  type PtzPreset,
  type PtzPresetFunction,
  PtzPresetFunctionSchema,
  PtzPresetSchema,
  type PtzStatus,
  PtzStatusSchema,
  ptzCapability,
} from './ptz.cap.js'
export {
  type IPtzAutotrackProvider,
  type PtzAutotrackRuntimeState,
  PtzAutotrackRuntimeStateSchema,
  type PtzAutotrackSettings,
  PtzAutotrackSettingsSchema,
  type PtzAutotrackStatus,
  PtzAutotrackStatusSchema,
  type PtzAutotrackTargetOption,
  PtzAutotrackTargetOptionSchema,
  ptzAutotrackCapability,
} from './ptz-autotrack.cap.js'
export {
  type IRunningStateProvider,
  type RunningStateSource,
  RunningStateSourceSchema,
  type RunningStateStatus,
  RunningStateStatusSchema,
  runningStateCapability,
} from './running-state.cap.js'
export { type IRebootProvider, rebootCapability } from './reboot.cap.js'
export {
  type IRecordingProvider,
  RECORDING_SOURCE_CAMSTACK,
  RECORDING_SOURCE_CAMSTACK_ADDON,
  type RecordingAvailability,
  RecordingAvailabilitySchema,
  type RecordingDays,
  RecordingDaysSchema,
  type RecordingManifest,
  RecordingManifestSchema,
  type RecordingPlayback,
  RecordingPlaybackSchema,
  RecordingRangeSchema,
  type RecordingRead,
  RecordingReadSchema,
  type RecordingSource,
  type RecordingSourceAvailability,
  RecordingSourceAvailabilitySchema,
  type RecordingSourceOptions,
  RecordingSourceOptionsSchema,
  RecordingSourceSchema,
  recordingCapability,
} from './recording.cap.js'
export {
  type IRecordingArchiveProvider,
  type LocateSegmentResult,
  LocateSegmentResultSchema,
  RECORDING_TIMELINE_BATCH_MAX,
  type ReadGopBytesResult,
  ReadGopBytesResultSchema,
  type ReadSegmentBytesResult,
  ReadSegmentBytesResultSchema,
  type ReadWindowBytesResult,
  ReadWindowBytesResultSchema,
  type RecordingAvailabilityForDevice,
  RecordingAvailabilityForDeviceSchema,
  type RecordingDaysForDevice,
  RecordingDaysForDeviceSchema,
  type RecordingDeviceUsage,
  RecordingDeviceUsageSchema,
  type RecordingLocationUsage,
  RecordingLocationUsageSchema,
  type RecordingRebalanceInput,
  RecordingRebalanceInputSchema,
  type RecordingRebalanceMove,
  RecordingRebalanceMoveSchema,
  type RecordingRebalancePlan,
  RecordingRebalancePlanSchema,
  type RecordingRebalanceSkip,
  type RecordingRebalanceSkipReason,
  RecordingRebalanceSkipReasonSchema,
  RecordingRebalanceSkipSchema,
  type RecordingStatus,
  RecordingStatusSchema,
  type RecordingStorageUsage,
  RecordingStorageUsageSchema,
  recordingArchiveCapability,
} from './recording-archive.cap.js'
export {
  type ClipExportFailure,
  ClipExportFailureSchema,
  clipExportFailure,
  clipExportFailureOf,
  EXPORT_DENSE_MAX_RANGES,
  type ExportBytes,
  ExportBytesSchema,
  type ExportClipSubject,
  ExportClipSubjectSchema,
  type ExportDense,
  type ExportDenseRange,
  ExportDenseRangeSchema,
  ExportDenseSchema,
  type ExportDownload,
  ExportDownloadSchema,
  type ExportFootageSubject,
  ExportFootageSubjectSchema,
  type ExportOptions,
  ExportOptionsSchema,
  type ExportRecord,
  ExportRecordSchema,
  ExportSpeedSchema,
  type ExportState,
  ExportStateSchema,
  type ExportSubject,
  ExportSubjectSchema,
  ExportTimelapseSchema,
  exportSubjectOf,
  type IRecordingExportProvider,
  RECORDING_EXPORT_MAX_READ_BYTES,
  recordingExportCapability,
  resolveCreateExportSubject,
  resolveExportProfiles,
} from './recording-export.cap.js'
export {
  type IRecordingOnboardProvider,
  type OnboardAllowedValues,
  type OnboardFieldSupport,
  OnboardFieldSupportSchema,
  type OnboardRecordTrack,
  OnboardRecordTrackSchema,
  type OnboardScheduleSupport,
  OnboardScheduleSupportSchema,
  type OnboardStorage,
  OnboardStorageSchema,
  type OnboardStorageVolume,
  OnboardStorageVolumeSchema,
  type RecordingOnboardOptions,
  RecordingOnboardOptionsSchema,
  type RecordingOnboardPatch,
  RecordingOnboardPatchSchema,
  type RecordingOnboardStatus,
  RecordingOnboardStatusSchema,
  type RecordTrigger,
  RecordTriggerSchema,
  type RecordWindow,
  RecordWindowSchema,
  recordingOnboardCapability,
} from './recording-onboard.cap.js'
export {
  DAY_NAMES,
  DAYS_PER_WEEK,
  dayOfWeekToIndex,
  describeOnboardClamp,
  describeOnboardRefusal,
  formatMinutes,
  HOURS_PER_DAY,
  MINUTES_PER_DAY,
  minutesToTimeOfDay,
  timeOfDayToMinutes,
  WEEKLY_MASK_LENGTH,
  weeklyMaskIndex,
  weeklyMaskIsUniform,
  weeklyMaskToWindows,
  windowsToWeeklyMask,
} from './recording-onboard-rules.js'
export {
  type IRecordingSignalProvider,
  type RecordingSignalRuntimeState,
  RecordingSignalRuntimeStateSchema,
  type RecordingSignalStatus,
  RecordingSignalStatusSchema,
  recordingSignalCapability,
} from './recording-signal.cap.js'
export {
  RESERVED_COLLECTION_SOURCES,
  type ReservedCollectionSource,
  reservedSourceOwner,
} from './reserved-collection-sources.js'
export {
  type ISceneMonitorProvider,
  SCENE_CONDITIONS,
  SCENE_CONFIRM_DEFAULT_MAX_IMAGE_PX,
  SCENE_CONFIRM_DEFAULT_TIMEOUT_MS,
  SCENE_DEFAULT_ANCHOR_THRESHOLD,
  SCENE_DEFAULT_CHECK_INTERVAL_SEC,
  SCENE_DEFAULT_OBSERVATION_SPACING_SEC,
  SCENE_DEFAULT_QUIET_SECONDS,
  SCENE_DEFAULT_UNCOVERED_POLICY,
  SCENE_DIVERGED,
  SCENE_RESET_RECAPTURES,
  type SceneCheck,
  SceneCheckSchema,
  type SceneCondition,
  SceneConditionSchema,
  type SceneConfirm,
  SceneConfirmSchema,
  type SceneMonitor,
  SceneMonitorSchema,
  type SceneMonitorState,
  SceneMonitorStateSchema,
  type SceneMonitorStatus,
  type SceneMonitorStatusForDevice,
  SceneMonitorStatusForDeviceSchema,
  SceneMonitorStatusSchema,
  type SceneReference,
  SceneReferenceSchema,
  type SceneUnavailable,
  SceneUnavailableSchema,
  type SceneUncoveredPolicy,
  SceneUncoveredPolicySchema,
  type SceneVerdict,
  SceneVerdictSchema,
  sceneMonitorCapability,
} from './scene-monitor.cap.js'
export {
  type PackageLlmVerdict,
  PackageLlmVerdictSchema,
} from './schemas/package-llm-verdict.js'
export {
  type ZoneRule,
  type ZoneRuleMode,
  ZoneRuleModeEnum,
  ZoneRuleSchema,
  type ZoneRules,
  ZoneRulesArraySchema,
} from './schemas/zone-rule.js'
export {
  type IScriptRunnerProvider,
  type ScriptRunnerStatus,
  ScriptRunnerStatusSchema,
  scriptRunnerCapability,
} from './script-runner.cap.js'
export {
  type ISmokeProvider,
  type SmokeStatus,
  SmokeStatusSchema,
  smokeCapability,
} from './smoke.cap.js'
export {
  type CamStreamDescriptor,
  CamStreamDescriptorSchema,
  type IStreamCatalogProvider,
  type StreamCatalogState,
  streamCatalogCapability,
} from './stream-catalog.cap.js'
export {
  type IStreamParamsProvider,
  type StreamParamsOptions,
  StreamParamsOptionsSchema,
  type StreamParamsStatus,
  StreamParamsStatusSchema,
  type StreamProfile,
  StreamProfileConfigSchema,
  StreamProfileOptionsSchema,
  type StreamProfilePatch,
  StreamProfilePatchSchema,
  StreamProfileSchema,
  streamParamsCapability,
} from './stream-params.cap.js'
export {
  buildStreamParamsConfigSchema,
  parseStreamParamsFormPatch,
  STREAM_PROFILE_META,
  type StreamProfileMeta,
} from './stream-params-config-schema.js'
export {
  type ISwitchProvider,
  type SwitchStatus,
  SwitchStatusSchema,
  switchCapability,
} from './switch.cap.js'
// ── Core/Server Caps (Phase E — formerly hand-written core routers) ─
export {
  type DiagnosticId,
  DiagnosticIdSchema,
  type DiagnosticWindow,
  type DiagnosticWindowPatch,
  DiagnosticWindowPatchSchema,
  DiagnosticWindowSchema,
  FeatureManifestSchema,
  type GetLoggingSettingsInput,
  GetLoggingSettingsInputSchema,
  HealthStatusSchema,
  type ISystemProvider,
  type LogChannelWindowPatch,
  LogChannelWindowPatchSchema,
  type LogChannelWindowState,
  LogChannelWindowStateSchema,
  type LoggingEffective,
  LoggingEffectiveSchema,
  type LoggingExplicit,
  LoggingExplicitSchema,
  type LoggingLevelLayer,
  LoggingLevelLayerSchema,
  type LoggingLevelSource,
  LoggingLevelSourceSchema,
  type LoggingScopeKind,
  LoggingScopeKindSchema,
  type LoggingSettingsPatch,
  LoggingSettingsPatchSchema,
  type LoggingSettingsState,
  LoggingSettingsStateSchema,
  NetworkAddressSchema,
  type ReportedFailureContribution,
  ReportedFailureContributionSchema,
  type ReportedLoadContribution,
  ReportedLoadContributionSchema,
  type RequestCensusGroup,
  RequestCensusGroupSchema,
  type RequestCensusProcedure,
  RequestCensusProcedureSchema,
  type RequestCensusSnapshot,
  RequestCensusSnapshotSchema,
  type RequestCensusStatus,
  RequestCensusStatusSchema,
  type SetLoggingSettingsInput,
  SetLoggingSettingsInputSchema,
  type SetSiteLocationInput,
  SetSiteLocationInputSchema,
  type SiteLocation,
  SiteLocationSchema,
  type SiteLocationSource,
  SiteLocationSourceSchema,
  type SiteLocationStatus,
  SiteLocationStatusSchema,
  systemCapability,
  type TransportPlane,
  type TransportPlaneCounts,
  TransportPlaneCountsSchema,
  TransportPlaneSchema,
} from './system.cap.js'
export {
  type ITamperProvider,
  type TamperStatus,
  TamperStatusSchema,
  tamperCapability,
} from './tamper.cap.js'
// HA-targeted numeric single-metric sensor caps (Phase B2)
export {
  type ITemperatureSensorProvider,
  type TemperatureSensorStatus,
  TemperatureSensorStatusSchema,
  temperatureSensorCapability,
} from './temperature-sensor.cap.js'
export { type IToastProvider, ToastSchema, toastCapability } from './toast.cap.js'
export {
  type IUpdateProvider,
  type UpdateStatus,
  UpdateStatusSchema,
  updateCapability,
} from './update.cap.js'
// ── User Management ─────────────────────────────────────────────────
export {
  CreateUserInputSchema,
  ExternalIdentityKeySchema,
  ExternalIdentitySchema,
  type IUserManagementProvider,
  UpdateUserInputSchema,
  UserSummarySchema,
  userManagementCapability,
} from './user-management.cap.js'
export {
  type IVacuumControlProvider,
  type VacuumControlStatus,
  VacuumControlStatusSchema,
  type VacuumState,
  VacuumStateSchema,
  vacuumControlCapability,
} from './vacuum-control.cap.js'
export {
  type IValveProvider,
  type ValveState,
  ValveStateSchema,
  type ValveStatus,
  ValveStatusSchema,
  valveCapability,
} from './valve.cap.js'
export {
  type IVibrationProvider,
  type VibrationStatus,
  VibrationStatusSchema,
  vibrationCapability,
} from './vibration.cap.js'
export {
  type IWaterHeaterProvider,
  type WaterHeaterStatus,
  WaterHeaterStatusSchema,
  waterHeaterCapability,
} from './water-heater.cap.js'
// Read-only display caps (HA weather / image)
export {
  type IWeatherProvider,
  type WeatherStatus,
  WeatherStatusSchema,
  weatherCapability,
} from './weather.cap.js'
export {
  type CameraOccupancySnapshot,
  type CameraOccupancySnapshotForDevice,
  CameraOccupancySnapshotForDeviceSchema,
  type HistoryPoint,
  HistoryPointSchema,
  type HistoryResolution,
  HistoryResolutionEnum,
  type IZoneAnalyticsProvider,
  type PerScopeBreakdown,
  PerScopeBreakdownSchema,
  type StationaryObject,
  StationaryObjectSchema,
  type ZoneScopeBreakdown,
  ZoneScopeBreakdownSchema,
  zoneAnalyticsCapability,
} from './zone-analytics.cap.js'
export {
  type IZoneRulesProvider,
  type ZoneRuleStage,
  ZoneRuleStageEnum,
  zoneRulesCapability,
} from './zone-rules.cap.js'
export {
  type IZonesProvider,
  type PolygonPoint,
  PolygonPointSchema,
  type Zone,
  type ZoneKind,
  ZoneKindEnum,
  ZoneSchema,
  zonesCapability,
} from './zones.cap.js'

export type {
  ITrainingCloudProvider,
  ProviderJobState,
  ProviderJobStatus,
  TrainerSourceRef,
  TrainingCredentialCheck,
  TrainingGpuOption,
  TrainingLogLine,
  TrainingProviderDefaults,
  TrainingProviderDescriptor,
  TrainingProviderEntry,
  TrainingProviderType,
  TrainingProviderUpdateEntryInput,
  TrainingRegionOption,
} from './training-provider.cap.js'
export {
  ProviderJobStateSchema,
  ProviderJobStatusSchema,
  TrainerSourceRefSchema,
  TrainingCredentialCheckSchema,
  TrainingGpuOptionSchema,
  TrainingLogLineSchema,
  TrainingProviderDefaultsSchema,
  TrainingProviderDescriptorSchema,
  TrainingProviderEntrySchema,
  TrainingProviderTypeSchema,
  TrainingProviderUpdateEntryInputSchema,
  TrainingRegionOptionSchema,
  trainingProviderCapability,
} from './training-provider.cap.js'
export type {
  ITrainingOrchestrator,
  TrainingAcceleratorRef,
  TrainingBaseModel,
  TrainingCanary,
  TrainingCanaryTarget,
  TrainingCorpusSelection,
  TrainingFailureReason,
  TrainingJob,
  TrainingJobPlan,
  TrainingJobRequest,
  TrainingJobState,
  TrainingPreset,
  TrainingProgressPoint,
  TrainingRefusalReason,
  TrainingSplitPlan,
} from './training.cap.js'
export {
  TrainingAcceleratorRefSchema,
  TrainingBaseModelSchema,
  TrainingCanarySchema,
  TrainingCanaryTargetSchema,
  TrainingCorpusSelectionSchema,
  TrainingFailureReasonSchema,
  TrainingJobPlanSchema,
  TrainingJobRequestSchema,
  TrainingJobSchema,
  TrainingJobStateSchema,
  TrainingPresetSchema,
  TrainingProgressPointSchema,
  TrainingRefusalReasonSchema,
  TrainingSplitPlanSchema,
  trainingCapability,
} from './training.cap.js'

import type { IReadinessRegistry } from '../interfaces/readiness.js'
import type { accessoriesCapability } from './accessories.cap.js'
import type { addonPagesCapability } from './addon-pages.cap.js'
import type { addonPagesSourceCapability } from './addon-pages-source.cap.js'
import type { addonRoutesCapability } from './addon-routes.cap.js'
// ── Strongly-typed readiness registry ───────────────────────────────
//
// `CapabilityName` is the exhaustive union of every registered capability's
// `.name` literal. Passing it to `IReadinessRegistry<CapabilityName>` means
// the compiler rejects any unknown string (e.g. a stale 'detection-pipeline'
// instead of 'pipeline-executor') at call sites.
import type { addonSettingsCapability } from './addon-settings.cap.js'
import type { addonWidgetsCapability } from './addon-widgets.cap.js'
import type { addonWidgetsSourceCapability } from './addon-widgets-source.cap.js'
import type { addonsCapability } from './addons.cap.js'
import type { adminUiCapability } from './admin-ui.cap.js'
import type { airQualitySensorCapability } from './air-quality-sensor.cap.js'
import type { alarmPanelCapability } from './alarm-panel.cap.js'
import type { alertsCapability } from './alerts.cap.js'
import type { ambientLightSensorCapability } from './ambient-light-sensor.cap.js'
import type { audioAnalysisCapability } from './audio-analysis.cap.js'
import type { audioAnalyzerCapability } from './audio-analyzer.cap.js'
import type { audioCodecCapability } from './audio-codec.cap.js'
import type { audioMetricsCapability } from './audio-metrics.cap.js'
import type { authProviderCapability } from './auth-provider.cap.js'
import type { automationControlCapability } from './automation-control.cap.js'
import type { backupCapability } from './backup.cap.js'
import type { batteryCapability } from './battery.cap.js'
import type { binaryCapability } from './binary.cap.js'
import type { brightnessCapability } from './brightness.cap.js'
import type { brokerCapability } from './broker.cap.js'
import type { buttonCapability } from './button.cap.js'
import type { calendarSourceCapability } from './calendar-source.cap.js'
import type { calendarsCapability } from './calendars.cap.js'
import type { cameraCredentialsCapability } from './camera-credentials.cap.js'
import type { cameraGridLayoutCapability } from './camera-grid-layout.cap.js'
import type { cameraPipelineConfigCapability } from './camera-pipeline-config.cap.js'
import type { cameraStreamsCapability } from './camera-streams.cap.js'
import type { carbonMonoxideCapability } from './carbon-monoxide.cap.js'
import type { climateControlCapability } from './climate-control.cap.js'
import type { colorCapability } from './color.cap.js'
import type { composerCapability } from './composer.cap.js'
import type { connectionTestCapability } from './connection-test.cap.js'
import type { connectivityCapability } from './connectivity.cap.js'
import type { consumablesCapability } from './consumables.cap.js'
import type { contactCapability } from './contact.cap.js'
import type { controlCapability } from './control.cap.js'
import type { coreBlocksCapability } from './core-blocks.cap.js'
import type { coverCapability } from './cover.cap.js'
import type { customModelRegistryCapability } from './custom-model-registry.cap.js'
import type { dataStoreProviderCapability } from './data-store-provider.cap.js'
import type { databaseSnapshotCapability } from './database-snapshot.cap.js'
import type { storageAdminCapability } from './storage-admin.cap.js'
import type { recordsCapability } from './records.cap.js'
import type { recordEntriesCapability } from './record-entries.cap.js'
import type { deviceHistoryCapability } from './device-history.cap.js'
import type { keychainCapability } from './keychain.cap.js'
import type { keychainAdminCapability } from './keychain-admin.cap.js'
import type { deviceCredentialsCapability } from './device-credentials.cap.js'
import type { nodeCertificatesCapability } from './node-certificates.cap.js'
import type { dayNightCapability } from './day-night.cap.js'
import type { decoderCapability } from './decoder.cap.js'
import type { detectionPipelineCapability } from './detection-pipeline.cap.js'
import type { deviceAdminLinkCapability } from './device-admin-link.cap.js'
import type { deviceAdoptionCapability } from './device-adoption.cap.js'
import type { deviceDiscoveryCapability } from './device-discovery.cap.js'
import type { deviceExportCapability } from './device-export.cap.js'
import type { deviceExtensionCapability } from './device-extension.cap.js'
import type { deviceManagerCapability } from './device-manager.cap.js'
import type { deviceOpsCapability } from './device-ops.cap.js'
import type { displayPaletteCapability } from './display-palette.cap.js'
import type { deviceProviderCapability } from './device-provider.cap.js'
import type { deviceStateCapability } from './device-state.cap.js'
import type { deviceStatusCapability } from './device-status.cap.js'
import type { deviceRemovalHookCapability } from './device-removal-hook.cap.js'
import type { dishwasherCapability } from './dishwasher.cap.js'
import type { doorbellCapability } from './doorbell.cap.js'
import type { embeddingEncoderCapability } from './embedding-encoder.cap.js'
import type { enumSensorCapability } from './enum-sensor.cap.js'
import type { eventEmitterCapability } from './event-emitter.cap.js'
import type { faceGalleryCapability } from './face-gallery.cap.js'
import type { failureContributionCapability } from './failure-contribution.cap.js'
import type { fanControlCapability } from './fan-control.cap.js'
import type { featureProbeCapability } from './feature-probe.cap.js'
import type { filesystemBrowseCapability } from './filesystem-browse.cap.js'
import type { floodCapability } from './flood.cap.js'
import type { gasCapability } from './gas.cap.js'
import type { groupStatusCapability } from './group-status.cap.js'
import type { heatingValveCapability } from './heating-valve.cap.js'
import type { humidifierCapability } from './humidifier.cap.js'
import type { humiditySensorCapability } from './humidity-sensor.cap.js'
import type { imageCapability } from './image.cap.js'
import type { imageSettingsCapability } from './image-settings.cap.js'
import type { integrationsCapability } from './integrations.cap.js'
import type { intercomCapability } from './intercom.cap.js'
import type { lawnMowerControlCapability } from './lawn-mower-control.cap.js'
import type { llmCapability } from './llm.cap.js'
import type { llmRuntimeCapability } from './llm-runtime.cap.js'
import type { loadContributionCapability } from './load-contribution.cap.js'
import type { localNetworkCapability } from './local-network.cap.js'
import type { lockControlCapability } from './lock-control.cap.js'
import type { logChannelsCapability } from './log-channels.cap.js'
import type { logDestinationCapability } from './log-destination.cap.js'
import type { loginMethodCapability } from './login-method.cap.js'
import type { mediaPlayerCapability } from './media-player.cap.js'
import type { meshNetworkCapability } from './mesh-network.cap.js'
import type { metricsProviderCapability } from './metrics-provider.cap.js'
import type { modelConvertCapability } from './model-convert.cap.js'
import type { modelDistributorCapability } from './model-distributor.cap.js'
import type { motionCapability } from './motion.cap.js'
import type { motionDetectionCapability } from './motion-detection.cap.js'
import type { motionTriggerCapability } from './motion-trigger.cap.js'
import type { motionZonesCapability } from './motion-zones.cap.js'
import type { mqttBrokerCapability } from './mqtt-broker.cap.js'
import type { nativeObjectDetectionCapability } from './native-object-detection.cap.js'
import type { navigationCapability } from './navigation.cap.js'
import type { networkAccessCapability } from './network-access.cap.js'
import type { networkLinkCapability } from './network-link.cap.js'
import type { networkQualityCapability } from './network-quality.cap.js'
import type { nodesCapability } from './nodes.cap.js'
import type { notificationOutputCapability } from './notification-output.cap.js'
import type { notificationRulesCapability } from './notification-rules.cap.js'
import type { notifierCapability } from './notifier.cap.js'
import type { numericSensorCapability } from './numeric-sensor.cap.js'
import type { oauthIntegrationCapability } from './oauth-integration.cap.js'
import type { oidcConnectionsCapability } from './oidc-connections.cap.js'
import type { osdCapability } from './osd.cap.js'
import type { osdManagerCapability } from './osd-manager.cap.js'
import type { petFeederCapability } from './pet-feeder.cap.js'
import type { pipelineAnalyticsCapability } from './pipeline-analytics.cap.js'
import type { pipelineExecutorCapability } from './pipeline-executor.cap.js'
import type { pipelineOrchestratorCapability } from './pipeline-orchestrator.cap.js'
import type { pipelineRunnerCapability } from './pipeline-runner.cap.js'
import type { plateGalleryCapability } from './plate-gallery.cap.js'
import type { platformProbeCapability } from './platform-probe.cap.js'
import type { powerMeterCapability } from './power-meter.cap.js'
import type { presenceCapability } from './presence.cap.js'
import type { pressureSensorCapability } from './pressure-sensor.cap.js'
import type { privacyMaskCapability } from './privacy-mask.cap.js'
import type { ptzCapability } from './ptz.cap.js'
import type { ptzAutotrackCapability } from './ptz-autotrack.cap.js'
import type { runningStateCapability } from './running-state.cap.js'
import type { rebootCapability } from './reboot.cap.js'
import type { recordingCapability } from './recording.cap.js'
import type { recordingArchiveCapability } from './recording-archive.cap.js'
import type { recordingExportCapability } from './recording-export.cap.js'
import type { recordingOnboardCapability } from './recording-onboard.cap.js'
import type { recordingSignalCapability } from './recording-signal.cap.js'
import type { sceneMonitorCapability } from './scene-monitor.cap.js'
import type { scriptRunnerCapability } from './script-runner.cap.js'
import type { serverManagementCapability } from './server-management.cap.js'
import type { settingsStoreCapability } from './settings-store.cap.js'
import type { smokeCapability } from './smoke.cap.js'
import type { smtpProviderCapability } from './smtp-provider.cap.js'
import type { snapshotCapability } from './snapshot.cap.js'
import type { ssoBridgeCapability } from './sso-bridge.cap.js'
import type { storageCapability } from './storage.cap.js'
import type { storageEvictableCapability } from './storage-evictable.cap.js'
import type { storageMigrationCapability } from './storage-migration.cap.js'
import type { storageOccupancyCapability } from './storage-occupancy.cap.js'
import type { storageProviderCapability } from './storage-provider.cap.js'
import type { streamBrokerCapability } from './stream-broker.cap.js'
import type { streamCatalogCapability } from './stream-catalog.cap.js'
import type { streamParamsCapability } from './stream-params.cap.js'
import type { streamSignalsCapability } from './stream-signals.cap.js'
import type { switchCapability } from './switch.cap.js'
import type { systemCapability } from './system.cap.js'
import type { tamperCapability } from './tamper.cap.js'
import type { temperatureSensorCapability } from './temperature-sensor.cap.js'
import type { terminalSessionCapability } from './terminal-session.cap.js'
import type { toastCapability } from './toast.cap.js'
import type { turnProviderCapability } from './turn-provider.cap.js'
import type { updateCapability } from './update.cap.js'
import type { userManagementCapability } from './user-management.cap.js'
import type { userPasskeysCapability } from './user-passkeys.cap.js'
import type { vacuumControlCapability } from './vacuum-control.cap.js'
import type { valveCapability } from './valve.cap.js'
import type { vectorStoreCapability } from './vector-store.cap.js'
import type { vibrationCapability } from './vibration.cap.js'
import type { videoclipsCapability } from './videoclips.cap.js'
import type { viewerUiCapability } from './viewer-ui.cap.js'
import type { waterHeaterCapability } from './water-heater.cap.js'
import type { weatherCapability } from './weather.cap.js'
import type { webrtcSessionCapability } from './webrtc-session.cap.js'
import type { trainingCapability } from './training.cap.js'
import type { trainingProviderCapability } from './training-provider.cap.js'
import type { zoneAnalyticsCapability } from './zone-analytics.cap.js'
import type { zoneRulesCapability } from './zone-rules.cap.js'
import type { zonesCapability } from './zones.cap.js'

type AnyCapability =
  | typeof streamSignalsCapability
  | typeof addonSettingsCapability
  | typeof alertsCapability
  | typeof storageCapability
  | typeof storageMigrationCapability
  | typeof storageProviderCapability
  | typeof storageEvictableCapability
  | typeof storageOccupancyCapability
  | typeof filesystemBrowseCapability
  | typeof backupCapability
  | typeof terminalSessionCapability
  | typeof settingsStoreCapability
  | typeof dataStoreProviderCapability
  | typeof databaseSnapshotCapability
  | typeof storageAdminCapability
  | typeof recordsCapability
  | typeof recordEntriesCapability
  | typeof deviceHistoryCapability
  | typeof keychainCapability
  | typeof keychainAdminCapability
  | typeof deviceCredentialsCapability
  | typeof nodeCertificatesCapability
  | typeof logChannelsCapability
  | typeof logDestinationCapability
  | typeof loadContributionCapability
  | typeof failureContributionCapability
  | typeof deviceRemovalHookCapability
  | typeof adminUiCapability
  | typeof viewerUiCapability
  | typeof ssoBridgeCapability
  | typeof userPasskeysCapability
  | typeof smtpProviderCapability
  | typeof mqttBrokerCapability
  | typeof brokerCapability
  | typeof deviceAdoptionCapability
  | typeof deviceAdminLinkCapability
  | typeof deviceExportCapability
  | typeof addonPagesCapability
  | typeof addonPagesSourceCapability
  | typeof addonWidgetsCapability
  | typeof addonWidgetsSourceCapability
  | typeof customModelRegistryCapability
  | typeof modelDistributorCapability
  | typeof modelConvertCapability
  | typeof addonRoutesCapability
  | typeof streamBrokerCapability
  | typeof decoderCapability
  | typeof webrtcSessionCapability
  | typeof cameraStreamsCapability
  | typeof calendarSourceCapability
  | typeof calendarsCapability
  | typeof motionDetectionCapability
  | typeof pipelineExecutorCapability
  | typeof detectionPipelineCapability
  | typeof cameraPipelineConfigCapability
  | typeof pipelineRunnerCapability
  | typeof pipelineOrchestratorCapability
  | typeof audioAnalyzerCapability
  | typeof audioAnalysisCapability
  | typeof audioCodecCapability
  | typeof embeddingEncoderCapability
  | typeof vectorStoreCapability
  | typeof deviceProviderCapability
  | typeof deviceManagerCapability
  | typeof deviceStateCapability
  | typeof authProviderCapability
  | typeof loginMethodCapability
  | typeof networkAccessCapability
  | typeof turnProviderCapability
  | typeof snapshotCapability
  | typeof llmCapability
  | typeof llmRuntimeCapability
  | typeof notificationOutputCapability
  | typeof composerCapability
  | typeof coreBlocksCapability
  | typeof notificationRulesCapability
  | typeof pipelineAnalyticsCapability
  | typeof metricsProviderCapability
  | typeof ptzCapability
  | typeof ptzAutotrackCapability
  | typeof navigationCapability
  | typeof consumablesCapability
  | typeof connectionTestCapability
  | typeof runningStateCapability
  | typeof rebootCapability
  | typeof deviceDiscoveryCapability
  | typeof brightnessCapability
  | typeof colorCapability
  | typeof climateControlCapability
  | typeof coverCapability
  | typeof valveCapability
  | typeof humidifierCapability
  | typeof waterHeaterCapability
  | typeof weatherCapability
  | typeof imageCapability
  | typeof lockControlCapability
  | typeof vacuumControlCapability
  | typeof petFeederCapability
  | typeof lawnMowerControlCapability
  | typeof fanControlCapability
  | typeof controlCapability
  | typeof notifierCapability
  | typeof mediaPlayerCapability
  | typeof alarmPanelCapability
  | typeof presenceCapability
  | typeof scriptRunnerCapability
  | typeof automationControlCapability
  | typeof motionTriggerCapability
  | typeof zonesCapability
  | typeof zoneRulesCapability
  | typeof trainingCapability
  | typeof trainingProviderCapability
  | typeof zoneAnalyticsCapability
  | typeof audioMetricsCapability
  | typeof motionCapability
  | typeof contactCapability
  | typeof floodCapability
  | typeof smokeCapability
  | typeof carbonMonoxideCapability
  | typeof gasCapability
  | typeof groupStatusCapability
  | typeof tamperCapability
  | typeof vibrationCapability
  | typeof connectivityCapability
  | typeof binaryCapability
  | typeof temperatureSensorCapability
  | typeof heatingValveCapability
  | typeof humiditySensorCapability
  | typeof ambientLightSensorCapability
  | typeof pressureSensorCapability
  | typeof powerMeterCapability
  | typeof airQualitySensorCapability
  | typeof numericSensorCapability
  | typeof enumSensorCapability
  | typeof recordingCapability
  | typeof recordingArchiveCapability
  | typeof recordingExportCapability
  | typeof recordingSignalCapability
  | typeof deviceOpsCapability
  | typeof displayPaletteCapability
  | typeof platformProbeCapability
  | typeof localNetworkCapability
  | typeof meshNetworkCapability
  | typeof userManagementCapability
  | typeof systemCapability
  | typeof networkQualityCapability
  | typeof toastCapability
  | typeof nodesCapability
  | typeof serverManagementCapability
  | typeof integrationsCapability
  | typeof addonsCapability
  | typeof oauthIntegrationCapability
  | typeof oidcConnectionsCapability
  | typeof streamParamsCapability
  | typeof streamCatalogCapability
  | typeof motionZonesCapability
  | typeof cameraGridLayoutCapability
  | typeof sceneMonitorCapability
  | typeof privacyMaskCapability
  | typeof dayNightCapability
  | typeof recordingOnboardCapability
  | typeof imageSettingsCapability
  | typeof osdCapability
  | typeof osdManagerCapability
  | typeof accessoriesCapability
  | typeof batteryCapability
  | typeof networkLinkCapability
  | typeof buttonCapability
  | typeof cameraCredentialsCapability
  | typeof deviceStatusCapability
  | typeof doorbellCapability
  | typeof eventEmitterCapability
  | typeof faceGalleryCapability
  | typeof featureProbeCapability
  | typeof intercomCapability
  | typeof nativeObjectDetectionCapability
  | typeof plateGalleryCapability
  | typeof switchCapability
  | typeof updateCapability
  | typeof videoclipsCapability
  | typeof deviceExtensionCapability
  | typeof dishwasherCapability

export type CapabilityName = AnyCapability['name']

export type ITypedReadinessRegistry = IReadinessRegistry<CapabilityName>
