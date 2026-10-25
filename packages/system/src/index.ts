// Cap-derived runtime VALUE symbols. With `bundleTypesMainEntry` (see
// vite.config.ts), the bare `@camstack/types` entry is inlined into system's
// dist, so these resolve to system's OWN bundled copy — one authoritative
// instance. The hub imports them from `@camstack/system` so a
// `camstack deploy packages/system` refreshes the capability surface with no
// server image, and `@camstack/types` is never deployed to the hub.
export {
  ALL_CAPABILITY_DEFINITIONS,
  addonSettingsCapability,
  DEVICE_SETTINGS_CONTRIBUTION_METHODS,
  DEVICE_STATUS_METHOD,
  expandCapMethods,
  isArrayOutputSchema,
  isCollectionArrayMethod,
  METHOD_ACCESS_MAP,
} from '@camstack/types'
export type { PlatformInfo } from '@camstack/types/node'
// Infrastructure utilities live in `@camstack/types/node` since 2026-05
// (lifted from `@camstack/system` to break the kernel ↔ core dependency
// cycle, then moved off the root types entry so browser bundlers don't
// traverse `node:fs`). Re-exported here for backward compatibility with
// existing consumers (`@camstack/server`, addon dynamic imports).
export {
  buildBinaryPath,
  downloadBinary,
  ensureBinary,
  ensureFfmpeg,
  ensurePython,
  findInPath,
  getFfmpegDownloadUrl,
  getPlatformInfo,
  getPythonDownloadUrl,
  installPythonPackages,
  installPythonRequirements,
  PYTHON_VERSION,
} from '@camstack/types/node'
export type { DirectCallerOptions } from './addon/addon-api-factory.js'
// Addon API Factory
export { AddonApiFactory } from './addon/addon-api-factory.js'
// Addon routes
export { AddonRouteRegistry } from './addon-routes/addon-route-registry.js'
export type { AuthConfigReader, ReauthClaims, TokenPayload } from './auth/auth-manager.js'
// Auth
export { AuthManager } from './auth/auth-manager.js'
export { scopesAllowAddon, scopesAllowDeviceCap } from './auth/scope-matcher.js'
export type { TokenExpiryResult } from './auth/token-expiry.js'
export { parseTokenExpiry } from './auth/token-expiry.js'
export type {
  CreateLoginSessionInput,
  LoginSessionCheck,
  LoginSessionMethod,
  LoginSessionRecord,
  LoginSessionRefresh,
  LoginSessionRevocation,
  LoginSessionSummary,
} from './auth/login-session-manager.js'
export { LoginSessionManager, REFRESH_TOKEN_PREFIX } from './auth/login-session-manager.js'
export { onSessionsRevoked } from './auth/session-revocation-bus.js'
export type {
  SessionsRevokedEvent,
  SessionsRevokedListener,
} from './auth/session-revocation-bus.js'
export { DeviceCaStore } from './auth/device-ca-store.js'
export {
  DEVICE_CA_KEY_REF,
  type DeviceCaSigner,
  generateDeviceCa,
  issueDeviceLeaf,
  loadDeviceCa,
  verifyDeviceLeaf,
  verifyDeviceSignature,
} from './auth/device-ca.js'
export {
  type AuthenticatedDevice,
  DeviceCredentialManager,
  type DeviceCredentialRecord,
  type DeviceCredentialState,
  PREVIOUS_LEAF_GRACE_MS,
  type DeviceCheckRefusal,
  type IssuedDeviceCertificate,
} from './auth/device-credential-manager.js'
export { AuthAuditLog } from './auth/auth-audit-log.js'
export type { AuthAuditAction, AuthAuditEvent, AuthAuditRecord } from './auth/auth-audit-log.js'
export type { CidrMatcher, ParsedCidr, ParsedCidrList } from './auth/cidr.js'
export { createCidrMatcher, normalizeIp, parseCidrList, readCidrSetting } from './auth/cidr.js'
export type {
  AuthAuditInternal,
  DeviceCredentialsInternal,
  LinkExternalIdentityInput,
  LoginSessionsInternal,
  SetPasswordInput,
  UserManagementInternal,
  UserPreferencesInternal,
} from './auth/user-management-internal.js'
export {
  type PreferencesLimitReason,
  preferencesLimitReasonOf,
} from './builtins/local-auth/user-preferences-store.js'
export {
  attachUserManagementInternal,
  getUserManagementInternal,
  USER_MANAGEMENT_INTERNAL,
} from './auth/user-management-internal.js'
export type { UserRecord, UserStorageAccess } from './auth/user-manager.js'
export {
  FIRST_BOOT_ADMIN_PASSWORD,
  FIRST_BOOT_ADMIN_USERNAME,
  UserManager,
} from './auth/user-manager.js'
export type { JwtSigningKeySource, JwtSigningKeyState } from './auth/jwt-signing-key.js'
export {
  getProcessJwtSigningKeyState,
  JWT_SIGNING_KEY_REF,
  JwtSigningKeyUnavailableError,
  processJwtSigningKey,
  staticJwtSigningKey,
  SYSTEM_SECRET_OWNER,
} from './auth/jwt-signing-key.js'
export { AlertCenterAddon } from './builtins/alerts/index.js'
export { CalendarsAddon } from './builtins/calendars/index.js'
export { ComposerAddon } from './builtins/composer/index.js'
export { ConsoleDestination, ConsoleLoggingAddon } from './builtins/console-logging/index.js'
export { CoreBlocksAddon } from './builtins/core-blocks/index.js'
export { DeviceManagerAddon } from './builtins/device-manager/index.js'
/**
 * The per-device wrapper activation (D556). Exported because it is the
 * OPERATOR-FACING verb and the only writer of the registry's per-device source
 * projection — a spec that proves "activate, then list" must be able to drive
 * the real one, not a re-implementation of it.
 */
export {
  // The ONE predicate that reads the deny set — it carries the pre-re-key
  // migration rule (an addon id denies every source that addon serves here,
  // D555), so the row path in `server/backend` asks it rather than spelling
  // half the rule again.
  setWrapperActive,
  type WrapperActivationDeps,
  type WrapperActivationInput,
} from './builtins/device-manager/device-source-activation.js'
export { HubForwarderAddon, HubForwarderDestination } from './builtins/hub-forwarder/index.js'
export { LivenessMonitorAddon } from './builtins/liveness-monitor/index.js'
export { LocalAuthAddon } from './builtins/local-auth/index.js'
export type { LokiConfig, LokiStatus } from './builtins/loki-logging/index.js'
export { LokiDestination, LokiLoggingAddon } from './builtins/loki-logging/index.js'
export { default as NativeMetricsAddon } from './builtins/native-metrics/native-metrics.addon.js'
export { default as DeviceHistoryAddon } from './builtins/device-history/device-history.addon.js'
export { NativeMetricsProvider } from './builtins/native-metrics/native-metrics-provider.js'
export type { DeviceRow } from './builtins/sqlite-storage/index.js'
// Builtin providers — default implementations that register through CapabilityRegistry
// and CAN be replaced by external addons.
export {
  ConfigStore,
  DeviceStore,
  FilesystemStorageAddon,
  FilesystemStorageProvider,
  SqliteSettingsAddon,
  SqliteSettingsBackend,
} from './builtins/sqlite-storage/index.js'
export type {
  ListLocationsFilter,
  StorageProviderLookup,
} from './builtins/storage-orchestrator/index.js'
export {
  StorageOrchestratorAddon,
  StorageOrchestratorService,
} from './builtins/storage-orchestrator/index.js'
export { SystemConfigAddon } from './builtins/system-config/index.js'
export { WinstonDestination, WinstonLoggingAddon } from './builtins/winston-logging/index.js'
export { ModelDownloadService } from './download/model-download-service.js'
export type {
  DownloadProgressCallback,
  ModelRevisionAdoption,
  RevisionWeightFile,
} from './download/model-downloader.js'
export {
  adoptModelRevisions,
  collectModelFiles,
  deleteModelFromDisk,
  downloadFile,
  downloadModel,
  ensureModel,
  fetchJson,
  getModelFilePath,
  isModelDownloaded,
  resolveFormatRevision,
  revisionWeightUrl,
} from './download/model-downloader.js'
export { EventBus } from './events/event-bus.js'
export type {
  EventFilter,
  EventSource,
  SystemEvent,
} from './events/system-event-bus.js'
// Events (system-level event bus with ring buffer)
export { SystemEventBus } from './events/system-event-bus.js'
export type {
  FeatureConfigReader,
  FeatureFlag,
  FeatureManifest,
} from './feature/feature-manager.js'
// Feature
export { FeatureManager } from './feature/feature-manager.js'
export type {
  AuthenticatedFileServerOptions,
  ByteRange,
  FileResolveResult,
  FileServerHandle,
  FileServerTokenVerifier,
} from './http/authenticated-file-server.js'
// Authenticated data-plane file-server (shared host primitive: CORS + Range +
// scoped token). Used by the recorder playback server; reusable by the scrub
// track / clip export. See `feedback_check_caps_before_bespoke_servers`.
export {
  contentTypeFor,
  createAuthenticatedFileServer,
  parseRangeHeader,
  parseTokenizedUrl,
  resolveFilePath,
} from './http/authenticated-file-server.js'
export type { DataPlaneEligibility, DataPlaneMatch } from './http/data-plane-registry.js'
// Addon data-plane (hub reverse-proxy → addon's own listener). The hub uses the
// registry + proxy; addons that serve files use the ready-made file handler.
export { canServeDataPlane, DataPlaneRegistry } from './http/data-plane-registry.js'
export type { FileDataPlaneOptions } from './http/file-data-plane.js'
export { createFileDataPlaneHandler } from './http/file-data-plane.js'
export {
  allFamiliesListenHost,
  applyLanHttp,
  bindPendingLanHttp,
  closeLanHttp,
  DEFAULT_LAN_HTTP_PORT,
  readLanHttpState,
  registerLanHttpHandler,
} from './http/lan-http-bind.js'
export type { ReverseProxyOptions } from './http/reverse-proxy.js'
export { proxyToUpstream } from './http/reverse-proxy.js'
export type {
  ChildFanoutDelta,
  ChildFanoutRegistry,
  ChildFanoutSample,
  CrossNodeEventStats,
  EventPlaneCounters,
  EventPlaneReader,
  EventPlaneSources,
  EventPlaneWindow,
} from './kernel/event-plane-report.js'
export {
  createEventPlaneMeter,
  createEventPlaneReader,
  diffEventPlane,
  EVENT_PLANE_TOP_N,
  formatEventPlane,
} from './kernel/event-plane-report.js'
export type {
  SocketPeerDelta,
  SocketPeerSample,
  SocketPlaneBaseline,
  SocketPlaneCounters,
  SocketPlaneMeter,
  SocketPlaneReader,
  SocketPlaneRegistry,
  SocketPlaneRegistryChild,
  SocketPlaneSources,
  SocketPlaneWindow,
} from './kernel/socket-plane-report.js'
export {
  createSocketPlaneMeter,
  createSocketPlaneReader,
  diffSocketPlane,
  EMPTY_SOCKET_PLANE_BASELINE,
  formatSocketPlane,
  readSocketQueues,
  SOCKET_PLANE_TOP_N,
  SOCKET_QUEUE_TOP_N,
} from './kernel/socket-plane-report.js'
export type { SocketPeerQueue, SocketQueueReading } from './kernel/socket-plane-report.js'
export type { MeshPeerQueue, MeshQueueReader } from './kernel/moleculer/mesh-queue-report.js'
export {
  createMeshQueueReader,
  formatMeshQueue,
  MESH_QUEUE_TOP_N,
} from './kernel/moleculer/mesh-queue-report.js'
export type {
  OutboundQueueGate,
  OutboundQueueGateOptions,
  OutboundQueueReading,
  OutboundQueueVerdict,
} from './kernel/outbound-queue-watch.js'
export {
  createOutboundQueueGate,
  formatOutboundQueueVerdict,
  OUTBOUND_QUEUE_COOLDOWN_MS,
  OUTBOUND_QUEUE_SUSTAIN_MS,
  OUTBOUND_QUEUE_THRESHOLD_BYTES,
} from './kernel/outbound-queue-watch.js'
export type {
  HeapDiagnosticDeps,
  HeapDiagnosticRequest,
  HeapSpaceReader,
  HeapSpaceUsage,
} from './kernel/heap-spaces.js'
export {
  DECISIVE_HEAP_SPACES,
  emitHeapDiagnosticReport,
  formatHeapSpaces,
  HEAP_SPACE_REPORT_MIN_MB,
  heapSpaceField,
  readHeapSpaces,
  selectReportedSpaces,
} from './kernel/heap-spaces.js'
export type {
  ArrayBufferCensus,
  ArrayBufferCensusContext,
  ArrayBufferCensusGate,
  ArrayBufferCensusGateOptions,
  ArrayBufferCensusReport,
  ArrayBufferCensusVerdict,
  ArrayBufferExactSize,
  ArrayBufferSizeBucket,
} from './kernel/array-buffer-census.js'
export {
  ARRAY_BUFFER_CENSUS_COOLDOWN_MS,
  ARRAY_BUFFER_CENSUS_SUSTAIN_MS,
  ARRAY_BUFFER_CENSUS_THRESHOLD_MB,
  ARRAY_BUFFER_RELEASE_MIN_DROP_RATIO,
  createArrayBufferCensusGate,
  createInspectorArrayBufferCensus,
  formatArrayBufferCensus,
  isArrayBufferCensusReport,
} from './kernel/array-buffer-census.js'
export type {
  ArrayBufferCensusProbe,
  DeferredHeapWatchSink,
  HeapReclaimer,
  HeapReclaimOptions,
  HeapSample,
  HeapWatchProbes,
  HeapWatchSink,
  LoopDelayMeter,
  LoopDelaySample,
  RssBreakdown,
  RssBudgetOptions,
  RssBudgetState,
  RssGrowthShape,
  RunnerHeapWatchOptions,
} from './kernel/heap-watch.js'
export {
  buildHeapSample,
  createDeferredHeapWatchSink,
  createLoopDelayMeter,
  createV8Reclaimer,
  HEAP_RECLAIM_MIN_INTERVAL_MS,
  HEAP_RECLAIM_STEADY_STATE_INTERVAL_MS,
  HEAP_RECLAIM_TRIGGER_MB,
  HEAP_WATCH_INTERVAL_MS,
  HEAP_WATCH_WARN_RATIO,
  HUB_MAIN_HEAP_WATCH_LABEL,
  HUB_MAIN_RSS_BUDGET_MB,
  HUB_RSS_BUDGET_ENV,
  hubMainRssBudget,
  describeRss,
  nextRssBudgetState,
  parseRssBudgetMb,
  reclaimIntervalMs,
  RSS_BUDGET_REANNOUNCE_MIN_MS,
  RSS_BUDGET_RELEASE_RATIO,
  RUNNER_HEAP_WATCH_INTERVAL_MS,
  RUNNER_RSS_BUDGET_ENV,
  shouldReclaim,
  startHeapWatch,
  startRunnerHeapWatch,
  strandedMb,
  ZERO_LOOP_DELAY,
} from './kernel/heap-watch.js'
// Event-loop stall attribution. Lives here — not in an addon bundle — because
// FOUR processes now need it (detection-pipeline, recorder, pipeline-analytics
// and hub-main) and they do not share a bundle; a per-bundle copy is how two
// diagnostics drift into disagreeing about the same freeze. See D417.
export type { StallVerdict } from './kernel/event-loop-stall-monitor.js'
export {
  attributeStall,
  STALL_REPORT_MS,
  STALL_TICK_MS,
  startEventLoopStallMonitor,
} from './kernel/event-loop-stall-monitor.js'
export type {
  AddonDataPlaneFacility,
  DataPlaneSink,
} from './kernel/moleculer/addon-data-plane-facility.js'
// In-process (co-located hub builtin) data-plane facility — binds a localhost
// listener in the hub process and publishes its endpoints through a sink the hub
// writes straight into the `DataPlaneRegistry`, so a builtin like the snapshot
// wrapper can serve `/addon/<id>/<prefix>/*` exactly like a forked addon.
export { createAddonDataPlaneFacility } from './kernel/moleculer/addon-data-plane-facility.js'
export {
  createAddonPeerBytesFacility,
  hostNodeIdOf,
  type AddonPeerBytesFacility,
  type AddonPeerBytesFacilityArgs,
} from './kernel/moleculer/addon-peer-bytes-facility.js'
export type {
  ElementState,
  ElementStatus,
} from './lifecycle/lifecycle-state-machine.js'
// Lifecycle
export { LifecycleStateMachine } from './lifecycle/lifecycle-state-machine.js'
export { formatLogLine } from './logging/formatter.js'
export type { ILogDestination } from './logging/log-manager.js'
// Logging
export { LogManager } from './logging/log-manager.js'
export {
  isCredentialKeyName,
  redactLogEntry,
  redactLogMeta,
  redactLogText,
} from './logging/log-redactor.js'
export {
  clearPlatformKeychainKey,
  getPlatformKeychainKey,
  type PlatformKeychainKey,
  setPlatformKeychainKey,
} from './builtins/keychain/platform-key-source.js'
export type { LogEntry, LogFilter, LogLevel } from './logging/log-ring-buffer.js'
export { LogRingBuffer } from './logging/log-ring-buffer.js'
export {
  bareAddonOf,
  compileLogFilter,
  type CompiledLogFilter,
  filterIsEmpty,
  levelRank,
  lineContainsText,
  lineMatches,
  originNodeOf,
  type ReadableLine,
} from './logging/log-read-filter.js'
export type { LevelBearing } from './logging/logging-gate.js'
export { DEFAULT_LOG_LEVEL, LoggingGate } from './logging/logging-gate.js'
export {
  __resetLoggingGateForTests,
  getLoggingGate,
} from './logging/logging-gate.singleton.js'
export type { IScopedLogger } from './logging/scoped-logger.js'
export { ScopedLogger } from './logging/scoped-logger.js'
export type {
  ClientNetworkStats,
  DeviceNetworkStats,
  INetworkQualityTracker,
  StreamNetworkStats,
} from './network/network-quality.js'
// Network quality tracking
export { NetworkQualityTracker } from './network/network-quality.js'
export type { NotificationTargetRef } from './notification/notification-service.js'
// Notification
export { NotificationService } from './notification/notification-service.js'
export type { Unsubscribe } from './notification/toast-service.js'
export { ToastService } from './notification/toast-service.js'
export { EngineManagerResolver } from './pipeline/engine-manager-resolver.js'
export { PipelineRunner } from './pipeline/pipeline-runner.js'
export type { ValidationIssue, ValidationResult } from './pipeline/pipeline-validator.js'
export { PipelineValidator } from './pipeline/pipeline-validator.js'
export type { PidStats } from './process/resource-monitor.js'
// Process resource monitoring (kept — used by native-metrics and addon-registry)
export { getPidStats, getSinglePidStats } from './process/resource-monitor.js'
// AddonDepsManager moved to @camstack/system (was in @camstack/kernel) so addons can consume it via
// `ctx.deps` without importing @camstack/system directly (the lint rule
// `no-restricted-imports` blocks that boundary).
export { PythonEnvManager } from './python/python-env-manager.js'
export type {
  IReplContextProvider,
  IReplEngine,
  ReplResult,
  ReplScope,
  ReplSessionContext,
} from './repl/interfaces.js'
// REPL engine
export { ReplEngine } from './repl/repl-engine.js'
export type { IStorageBackend } from './storage/fs-storage-backend.js'
export { FsStorageBackend } from './storage/fs-storage-backend.js'
export type { StorageLocationName } from './storage/storage-location-manager.js'
export { StorageLocationManager } from './storage/storage-location-manager.js'
export type {
  IFileStorage,
  IStorageLocation,
  IStorageProvider as ICoreStorageProvider,
  IStructuredStorage,
  QueryFilter,
  StorageRecord,
} from './storage/storage-manager.js'
// Storage
export { StorageManager } from './storage/storage-manager.js'
// TLS
export * from './tls/index.js'
// Agent mDNS advertisement (D857) and the responder behind it.
export {
  AgentMdnsAdvertiser,
  buildAgentAnnouncement,
  type AgentMdnsAdvertiserOptions,
  type AgentMdnsInputs,
} from './builtins/local-network/agent-mdns.js'
export { createCiaoPublisher } from './builtins/local-network/hub-mdns-ciao.js'
export type {
  HubMdnsAnnouncement,
  HubMdnsHandle,
  HubMdnsPublisher,
} from './builtins/local-network/hub-mdns.js'

// Platform scoring lives in `./builtins/platform-probe/` (promoted from
// the standalone @camstack/addon-platform-probe-native package in Phase
// B of the bundles refactor). Exposed as the per-node `platform-probe`
// capability — inference addons consume `ctx.api.platformProbe.*`.

// Integration & Device Registry
export { IntegrationRegistry } from './builtins/sqlite-storage/integration-registry.js'
export type { IntegrationRecordStores } from './builtins/sqlite-storage/integration-registry.js'
export {
  integrationRegistryRecordKinds,
  INTEGRATIONS_LEGACY,
  INTEGRATION_SETTINGS_LEGACY,
} from './builtins/sqlite-storage/integration-record-kinds.js'
export {
  clusterAgentRecordKinds,
  clusterNodeHistoryRecordKind,
  ClusterNodeHistoryBodySchema,
} from './builtins/cluster-agent/record-kinds.js'
export type { ClusterNodeHistoryBody } from './builtins/cluster-agent/record-kinds.js'
export {
  storageOrchestratorRecordKinds,
  STORAGE_DRAIN_STATE_LEGACY,
} from './builtins/storage-orchestrator/record-kinds.js'
export {
  backupOrchestratorRecordKinds,
  backupRecordStoresOf,
  type BackupRecordStores,
} from './builtins/backup-orchestrator/record-kinds.js'
export { readAllRows } from './records/read-all-rows.js'
// The records engine itself, for specs that must run a kind against the REAL
// rules (index order, keyset paging) rather than the in-memory fake.
export {
  RecordsEngine,
  type RecordsEngineOptions,
} from './builtins/sqlite-storage/records/records-engine.js'
// POST-install native-prebuild ENSURE pass an addon install runs on the
// INSTALLED addon dir AFTER `npm install` — bundled-copy first, prebuild-fetch
// fallback, LOUD throw on a residual source-only native. Heals the Mac desktop
// first-boot FATAL where npm re-created `better-sqlite3` source-only.
export {
  type EnsureAddonNativePrebuildsOptions,
  ensureAddonNativePrebuilds,
  type NativeEnsureOutcome,
  type NativeEnsureResult,
} from './kernel/deps/ensure-addon-natives.js'
// Post-install native-prebuild ENSURE step — fetches a traditional native's
// (`better-sqlite3`) prebuild for the running ABI when a staged closure's npm
// install left it source-only (toolchain-less packaged desktop). Injected into
// the shared RootUpdateService staging path so node-root stays zero-dep.
export {
  type EnsureNativePrebuildsOptions,
  ensureNativePrebuilds,
  hasDotNode,
  NATIVE_SCAN_DEPTH,
  type PrebuildFetchFn,
  type PrebuildTarget,
  TRADITIONAL_NATIVE_PACKAGES,
} from './kernel/deps/ensure-native-prebuilds.js'
// npm-bootstrap helper — the ONE working-npm resolver (system → bootstrapped →
// bootstrap). Exposed publicly so the framework-update engine can stage npm on a
// host that ships a bare node binary (packaged Electron agent) with no npm.
export {
  type NpmInvocation,
  type RunNpmOptions,
  buildNpmChildEnv,
  resolveNpmInvocation,
  runNpm,
} from './kernel/deps/npm-command.js'
// Kernel surface — absorbed 2026-06-22 (was @camstack/kernel). The kernel is the
// addon dispatcher (loader, capability registry, config manager, restart
// coordinator, transport). It now ships inside @camstack/system; consumers import
// these from '@camstack/system'.
export * from './kernel/index.js'

/** The token a CHILD uses to say "this method is declared optional and this
 *  provider does not serve it", which the hub turns into `NOT_IMPLEMENTED`.
 *  Crosses a UDS boundary as a plain message, so it is a prefix, not a class. */
export { CAP_METHOD_NOT_IMPLEMENTED } from './kernel/moleculer/child-cap-dispatch.js'

// System backup archives and their encryption (operator decision 2026-10-09):
// the launcher-side restore spec and ops tooling drive the same code the
// backup-orchestrator builtin runs.
export {
  BackupDecryptError,
  BackupKeyFormatError,
  BackupKeyMismatchError,
  generateBackupKeyPair,
  readBackupEncryptionHeader,
} from './builtins/system-backup/backup-encryption.js'
export { SystemBackupService } from './builtins/system-backup/system-backup.service.js'
export {
  BackupKeyRequiredError,
  prepareRestoreArchive,
} from './builtins/backup-orchestrator/restore-archive.js'
export * from './i18n/index.js'
