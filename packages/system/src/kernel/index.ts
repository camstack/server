// Addon loading
export type { RegisteredAddon } from './addon-loader.js'
export { AddonLoader } from './addon-loader.js'
export { AddonEngineManager } from './addon-engine-manager.js'
export type { AddonInstallerConfig, InstallSource, InstalledPackage } from './addon-installer.js'
export { AddonInstaller } from './addon-installer.js'
export type { AddonVersionMove, AddonVersionReason } from './addon-version-policy.js'
export {
  ADDON_VERSION_REASON_HUB,
  ADDON_VERSION_REASON_REGISTRY_LATEST,
  decideAddonVersionMove,
} from './addon-version-policy.js'
export type { AddonInstallSource, AddonManifestEntry, AddonManifestFile } from './addon-manifest.js'
export { AddonManifest } from './addon-manifest.js'
export type {
  AddonDirCandidate,
  QuarantinedEntry,
  ResidueQuarantineResult,
  ResidueReason,
  ResidueVerdict,
} from './addon-residue.js'
export {
  QUARANTINE_DIRNAME,
  classifyAddonDir,
  quarantineAddonResidue,
  selectAddonResidue,
} from './addon-residue.js'

// Shared filesystem utilities
export {
  copyDirRecursive,
  ensureDir,
  stripCamstackDeps,
  copyExtraFileDirs,
  ensureLibraryBuilt,
  installPackageFromNpm,
  isSourceNewer,
} from './fs-utils.js'

// Workspace detection
export { detectWorkspacePackagesDir } from './workspace-detect.js'

// Restart coordination — framework live-update primitives
// Spec: docs/superpowers/specs/2026-05-14-framework-live-update-design.md
export {
  RESTART_MARKER_FILE,
  clearPendingRestart,
  getRestartMarkerPath,
  readPendingRestart,
  scheduleSelfRestart,
  writePendingRestart,
} from './restart-coordinator.js'
export type {
  PendingRestartMarker,
  RestartKind,
  ScheduleSelfRestartOptions,
} from './restart-coordinator.js'

// Capability
export { CapabilityHandle, CapabilityUnavailableError } from './capability-handle.js'
export { CapabilityRegistry } from './capability-registry.js'
// BIG PLAN 2 — runtime cap-router builder (construction moved off @camstack/server).
export { buildCapRouters, builderMountedCapNames } from './cap-router-builder.js'
export type {
  CapRouterPrimitives,
  CapRouterServices,
  CapProviderGetter,
  RemoteProxyFactory,
  ProcedureBuilder,
  ProcedureResolverArgs,
} from './cap-router-builder.js'
// The claimed-status overlay (D663, S3): the registry's per-device resolvers
// and the child→child transport ask the same question through these.
export { overlayGetStatus, UNCLAIMED } from './status-overlay.js'
export type { ClaimedStatusResolver, StatusOverlay, StatusOverlayAnswer } from './status-overlay.js'
export { describeProviderKindDrift } from './provider-kind-drift.js'
export type { ProviderKindHint } from './provider-kind-drift.js'
export type {
  CapabilityRouter,
  CapabilityRouterFactory,
  ConfigReader,
  PersistedPreferenceReplay,
  ProviderOwnerToken,
} from './capability-registry.js'
export { CustomActionRegistry, type CustomActionEntry } from './custom-action-registry.js'
export { INFRA_CAPABILITIES, isInfraCapability } from './infra-capabilities.js'
export type { InfraCapability } from './infra-capabilities.js'
export {
  isolatedBuiltinPhase,
  partitionIsolatedBuiltinIds,
  runHubAddonBoot,
  waitUntilReady,
} from './isolated-builtin-phase.js'
export type {
  IsolatedBuiltinPhase,
  IsolatedBuiltinWaves,
  CapabilityName,
  WaitUntilReadyOptions,
  HubAddonBootSteps,
} from './isolated-builtin-phase.js'
export { createDoorSettingsView } from './settings-door-view.js'

// Config
export { ConfigManager } from './config-manager.js'
export type {
  ISettingsStore,
  KernelAddonSettingsView,
  SystemSettingsPreload,
} from './config-manager.js'
export { SettingsReadUnavailableError, isSettingsReadUnavailable } from './settings-read-error.js'
export type { SettingsReadRefusal } from './settings-read-error.js'
export { storeMayAnswer, STORE_READABLE_BOOTSTRAP_KEYS } from './system-settings-policy.js'
export { bootstrapSchema, RUNTIME_DEFAULTS, DEFAULT_DATA_PATH } from './config-schema.js'
export type { BootstrapConfig, AppConfig, ServerMode } from './config-schema.js'

export type { AddonSettingsView } from './config-manager.js'

// Device registry
export { DeviceRegistry } from './device-registry.js'

// Storage-location registry — aggregates per-addon `storageLocations`
// declarations into a single read-only registry. Consumed by the
// storage-orchestrator builtin to seed default locations.
export { buildStorageLocationRegistry } from './storage-location-registry.js'
export type { StorageLocationRegistry } from './storage-location-registry.js'

// Moleculer service mesh
export {
  createAgentTransport,
  createBroker,
  deriveAgentListenPort,
  getBrokerTlsTransporter,
} from './moleculer/broker-factory.js'
export type { AgentTransport, BrokerConfig } from './moleculer/broker-factory.js'
export {
  buildTransporter,
  connectBrokerTransport,
  currentBrokerTransporter,
  disconnectBrokerTransport,
  installBrokerTransporter,
  isInstalledTransporter,
} from './moleculer/broker-transport-swap.js'
export type { PendingTransporter } from './moleculer/broker-transport-swap.js'
export {
  caFingerprint,
  caFingerprintCompact,
  describeMeshLeaf,
  dropProcessPeer,
  emitProcessNodeRegistered,
  onProcessNodeRegistered,
  getProcessMeshCertificateRegistry,
  getProcessPeerLeaf,
  MESH_NODE_CERTIFICATES_COLLECTION,
  MESH_NODE_CERTIFICATES_COLUMNS,
  MeshCertificateRegistry,
  getProcessMeshTlsListenerState,
  openMeshTlsWhenRevocationsLoaded,
  RENEWAL_ABANDONED,
  setProcessMeshTlsListenerState,
  renewMeshCertificate,
  revokeMeshCertificate,
  setProcessMeshCertificateRegistry,
  createMeshCsrPem,
  exportMeshPrivateKeyPem,
  getProcessNodeMeshTransport,
  isProcessVerifiedMeshPeer,
  setProcessMeshPeerTransportLookup,
  generateMeshCa,
  generateMeshKeyPair,
  getProcessMeshCaState,
  issueMeshLeafForNode,
  issueMeshLeafFromCsr,
  loadMeshCa,
  MESH_CA_FIELD,
  MESH_CA_KEY_REF,
  MESH_CA_SETTINGS_KEY,
  MeshCaKeeper,
  MeshCrl,
  processMeshCrl,
  requireProcessMeshCa,
  setProcessMeshTlsEnabler,
  TlsTcpTransporter,
  DEFAULT_HUB_TLS_TCP_PORT,
  MESH_TLS_PORT_HELLO_FIELD,
} from './moleculer/mesh-mtls/index.js'
export type {
  MeshCertificateRecord,
  MeshLeafDescription,
  MeshLog,
  MeshPeerLeaf,
  MeshPeers,
  MeshRegistrations,
  MeshTlsListenerState,
  NodeMeshClient,
  RenewMeshResult,
  RevokeMeshResult,
  MeshCaSigner,
  MeshPeerTransportLookup,
  MeshTransport,
  MeshTlsMaterial,
  VerifiedMeshPeer,
} from './moleculer/mesh-mtls/index.js'
// D857 — agent pairing (hub-initiated, six digits confirmed on both sides).
export * from './moleculer/mesh-mtls/pairing/index.js'
export { type AddonDeploySource, isAddonDeploySource } from './moleculer/addon-deploy-source.js'
export {
  createAddonService,
  validateProviderRegistrations,
} from './moleculer/addon-service-factory.js'
export { createCoreCapService, CORE_CAP_SERVICE_NAME } from './moleculer/core-cap-service.js'
export type {
  CoreCapAction,
  CoreCapCallOrigin,
  CoreCapServiceOptions,
} from './moleculer/core-cap-service.js'
export {
  createAddonContext,
  createUdsAddonContext,
  setHubConnected,
  adaptBrokerToCluster,
  registerEventBusService,
  setNodeEventInterest,
  getMoleculerEventStats,
  subscribePassthrough,
  getBrokerEventBus,
  clusterEventTopic,
  EVENT_TOPIC_PREFIX,
} from './moleculer/addon-context-factory.js'
export { asBrokerLike } from './moleculer/event-bus.js'
export type { BrokerLike } from './moleculer/event-bus.js'
export type { MoleculerEventStats } from './moleculer/addon-context-factory.js'
// The REGIME the cross-node counters were produced under. A suppressed count
// means "nothing was dropped" under `filter` and "nothing WOULD have been
// dropped" under `shadow`; the hub runs `shadow`, so the two readings are not
// interchangeable and the mode has to travel with the number.
export { HubLogForwarder } from './moleculer/hub-log-forwarder.js'
export type { AddonContextOptions } from './moleculer/addon-context-factory.js'
export { createHubService } from './moleculer/hub-service.js'
export { HubNodeRegistry } from './moleculer/node-registry.js'
export type {
  CallFn,
  NodeRootPackageInfo,
  RegisteredAddonManifest,
  RegisteredNativeCap,
  RegisterNodeParams,
  RegisterNodeResult,
  NodeCapEntry,
  NodeNativeCapEntry,
} from './moleculer/node-registry.js'
export { callRegisterNodeWithRetry, buildNodeManifest } from './moleculer/register-node-client.js'
export type {
  RegisterNodeBroker,
  CallRegisterNodeOptions,
} from './moleculer/register-node-client.js'
// D857 — mesh identity: the certificate is the node identity; the gates only read it.
export {
  AgentMeshIdentityGate,
  isRemoteForbiddenAction,
  isRemoteForbiddenOnAgent,
  MeshIdentityGate,
  meshErrorType,
  MESH_ACTION_FORBIDDEN_TYPE,
  MESH_NODE_UNAUTHENTICATED_TYPE,
} from './moleculer/mesh-identity.js'
export type {
  AgentMeshIdentityGateDeps,
  MeshCallGate,
  MeshCallVerdict,
  MeshIdentityGateDeps,
  PeerVerifier,
} from './moleculer/mesh-identity.js'
export {
  createMeshAccessMiddleware,
  stripForgedIdentity,
} from './moleculer/mesh-access-middleware.js'
export type { MeshAccessMiddlewareOptions } from './moleculer/mesh-access-middleware.js'
// D848 — an agent's events are written to the hub only.
export { createAgentEventScope, isPeerEventPacket } from './moleculer/agent-event-scope.js'
export type {
  AgentEventScope,
  AgentEventScopeOptions,
  AgentEventScopeStats,
  OutboundPacket,
  TransitPublish,
} from './moleculer/agent-event-scope.js'
// D821, D857 — agent UI remote unlock tickets (ES256 by the mesh CA → agent session).
export {
  AGENT_DASHBOARD_ORIGINS_FIELD,
  AGENT_UI_UNLOCK_TYP,
  AGENT_UI_UNLOCK_USE,
  AGENT_UI_UNLOCK_TTL_MS,
  AGENT_UI_UNLOCK_VERSION,
  isAllowedAgentDashboardReturnTo,
  mintAgentUiUnlockTicket,
  parseAgentDashboardOrigins,
  UnlockTicketJtiStore,
  verifyAgentUiUnlockTicket,
} from './moleculer/agent-ui-unlock.js'
export type {
  AgentUiUnlockPayload,
  MintAgentUiUnlockTicketInput,
  VerifyAgentUiUnlockTicketOptions,
} from './moleculer/agent-ui-unlock.js'
export { serializeTypedArrays } from './moleculer/typed-array-serde.js'
export {
  createReadinessService,
  createReadinessServiceForRegistry,
  AGENT_READINESS_SERVICE_NAME,
} from './moleculer/readiness-service.js'
export type { ReadinessServiceDeps } from './moleculer/readiness-service.js'
export {
  getOrInitReadinessRegistry,
  getOrInitReadinessRegistryForClient,
} from './moleculer/readiness-context.js'
export type { UdsReadinessClient } from './moleculer/readiness-context.js'
export { createStreamProbeBrokerService } from './moleculer/stream-probe-service.js'
export type { StreamProbeBrokerDeps } from './moleculer/stream-probe-service.js'
export {
  resolveHwAccel,
  createKernelHwAccel,
  probePlatform,
} from './hwaccel/hwaccel-resolver.js'
export type { PlatformSignals } from './hwaccel/hwaccel-resolver.js'
export {
  createKernelInferenceEngine,
  mapSignalsToInferenceHardware,
} from './inference/inference-resolver.js'
export { localSupportedPythonRuntimes } from './inference/local-python-runtimes.js'

// Addon-safe binary/tool dependency manager (IAddonDepsManager).
export { AddonDepsManager } from './deps/addon-deps-manager.js'
export { installManifestPythonDeps } from './deps/manifest-python-deps.js'
export { installManifestSystemDeps } from './deps/manifest-system-deps.js'
export type {
  InstallManifestSystemDepsOptions,
  SystemPackageManager,
} from './deps/manifest-system-deps.js'
export { installManifestNativeDeps } from './deps/manifest-native-deps.js'
export {
  AddonHealthMonitor,
  HEALTH_MONITOR_TICK_MS,
  HEALTH_MONITOR_GRACE_PERIOD_MS,
  HEALTH_MONITOR_RETRY_INTERVALS_MS,
} from './addon-health-monitor.js'
export type {
  AddonHealthPhase,
  AddonHealthState,
  AddonHealthSnapshot,
  AddonHealthMonitorOptions,
} from './addon-health-monitor.js'
export type { HubServiceDeps } from './moleculer/hub-service.js'
export {
  createBrokerDeviceManagerApi,
  buildNativeCapProxy,
  mountNativeCapService,
  NATIVE_PROVIDER_SERVICE_INFIX,
} from './moleculer/device-cap-proxy.js'
export type { WorkerDeviceManagerOptions } from './moleculer/device-cap-proxy.js'
export { getWorkerDeviceRegistry } from './moleculer/addon-context-factory.js'
export {
  localProviderLink,
  brokerTransportLink,
  deviceCapResolverLink,
  ipcParentLink,
  buildLinkChain,
  brokerCallForCap,
} from './moleculer/trpc-links.js'
export type { LocalProviderResolver, BrokerCapCallOpts } from './moleculer/trpc-links.js'
export { createProcessService } from './moleculer/process-service.js'
export type { ProcessInfo } from './moleculer/process-service.js'
export { AddonRefusedError, findAddonRefusal } from './addon-refused-error.js'
export type { RunnerRefusalReport } from './moleculer/runner-refusal.js'
export { signalAllRunnerGroups } from './moleculer/runner-process-group.js'
export {
  CapUsageRegistry,
  getCapUsageRegistry,
  PARENT_ROUTED_PROVIDER_ADDON_ID,
  __resetCapUsageRegistryForTests,
} from './moleculer/cap-usage-registry.js'
export type {
  CapUsageCallRecord,
  CapUsageEdge,
  CapUsageRegistryOptions,
  CapUsageStats,
} from './moleculer/cap-usage-registry.js'
// $addonHost — REMOVED (Sprint 6). Settings are now per-addon via
// createAddonService settings.* actions + addon-settings singleton cap.
// The `addon-host-service.ts` file itself was deleted as dead code.
export { createScopedProcessManager } from './moleculer/process-context.js'
export type { IAddonProcessManager } from '@camstack/types'
export { callWithServiceDiscovery } from './moleculer/resilient-cap-call.js'
export type { ServiceDiscoveryBroker } from './moleculer/resilient-cap-call.js'

// Generic utilities — also exported from @camstack/types so addons can import without @camstack/kernel
export { RingBuffer } from './utils/ring-buffer.js'

// Local UDS transport library
export * from './transport/index.js'

// Readiness protocol — re-exported from @camstack/types for convenience.
// Spec: docs/superpowers/specs/2026-04-19-system-readiness-design.md
export {
  ReadinessRegistry,
  ReadinessTimeoutError,
  readinessKey,
  scopeKey,
  emitDownForOwnedCaps,
} from '@camstack/types'
export type {
  ReadinessHandler,
  ReadinessTransition,
  AwaitReadyOptions,
  ReadinessRegistryOptions,
} from '@camstack/types'

// Lifecycle management — job engine for addon updates
// Spec: docs/superpowers/sdd/task-5-brief.md
export { JobJournal } from './lifecycle/job-journal.js'
export { StagingArea } from './lifecycle/staging-area.js'
export { LifecycleJobEngine } from './lifecycle/lifecycle-job-engine.js'
export type { ApplyAddonUpdateFn, EmitFn } from './lifecycle/lifecycle-job-engine.js'
export type { TarballFetcher, ExtractFn } from './lifecycle/staging-area.js'
