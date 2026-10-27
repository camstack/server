// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-system-proxy.ts
/* eslint-disable */

import type { InferProvider } from '../capabilities/capability-definition.js'
import { invokeTrpcLeaf, type TrpcDispatchKind } from '../helpers/trpc-leaf.js'
import type { AddonApi } from './addon-api.js'
import type { actionsCapability } from '../capabilities/actions.cap.js'
import type { actionSourceCapability } from '../capabilities/action-source.cap.js'
import type { addonPagesCapability } from '../capabilities/addon-pages.cap.js'
import type { addonsCapability } from '../capabilities/addons.cap.js'
import type { addonSettingsCapability } from '../capabilities/addon-settings.cap.js'
import type { addonWidgetsCapability } from '../capabilities/addon-widgets.cap.js'
import type { alertsCapability } from '../capabilities/alerts.cap.js'
import type { audioAnalyzerCapability } from '../capabilities/audio-analyzer.cap.js'
import type { audioCodecCapability } from '../capabilities/audio-codec.cap.js'
import type { backupCapability } from '../capabilities/backup.cap.js'
import type { brokerCapability } from '../capabilities/broker.cap.js'
import type { calendarsCapability } from '../capabilities/calendars.cap.js'
import type { connectionTestCapability } from '../capabilities/connection-test.cap.js'
import type { coreBlocksCapability } from '../capabilities/core-blocks.cap.js'
import type { decoderCapability } from '../capabilities/decoder.cap.js'
import type { deviceAdoptionCapability } from '../capabilities/device-adoption.cap.js'
import type { deviceCredentialsCapability } from '../capabilities/device-credentials.cap.js'
import type { deviceExportCapability } from '../capabilities/device-export.cap.js'
import type { deviceHistoryCapability } from '../capabilities/device-history.cap.js'
import type { deviceManagerCapability } from '../capabilities/device-manager.cap.js'
import type { deviceProviderCapability } from '../capabilities/device-provider.cap.js'
import type { deviceStateCapability } from '../capabilities/device-state.cap.js'
import type { displayPaletteCapability } from '../capabilities/display-palette.cap.js'
import type { faceGalleryCapability } from '../capabilities/face-gallery.cap.js'
import type { integrationsCapability } from '../capabilities/integrations.cap.js'
import type { keychainAdminCapability } from '../capabilities/keychain-admin.cap.js'
import type { llmCapability } from '../capabilities/llm.cap.js'
import type { localNetworkCapability } from '../capabilities/local-network.cap.js'
import type { meshNetworkCapability } from '../capabilities/mesh-network.cap.js'
import type { metricsProviderCapability } from '../capabilities/metrics-provider.cap.js'
import type { mqttBrokerCapability } from '../capabilities/mqtt-broker.cap.js'
import type { networkAccessCapability } from '../capabilities/network-access.cap.js'
import type { networkQualityCapability } from '../capabilities/network-quality.cap.js'
import type { nodesCapability } from '../capabilities/nodes.cap.js'
import type { notificationOutputCapability } from '../capabilities/notification-output.cap.js'
import type { notificationRulesCapability } from '../capabilities/notification-rules.cap.js'
import type { oidcConnectionsCapability } from '../capabilities/oidc-connections.cap.js'
import type { osdManagerCapability } from '../capabilities/osd-manager.cap.js'
import type { pipelineExecutorCapability } from '../capabilities/pipeline-executor.cap.js'
import type { pipelineOrchestratorCapability } from '../capabilities/pipeline-orchestrator.cap.js'
import type { pipelineRunnerCapability } from '../capabilities/pipeline-runner.cap.js'
import type { plateGalleryCapability } from '../capabilities/plate-gallery.cap.js'
import type { recordEntriesCapability } from '../capabilities/record-entries.cap.js'
import type { recordingArchiveCapability } from '../capabilities/recording-archive.cap.js'
import type { recordingExportCapability } from '../capabilities/recording-export.cap.js'
import type { serverManagementCapability } from '../capabilities/server-management.cap.js'
import type { settingsStoreCapability } from '../capabilities/settings-store.cap.js'
import type { storageCapability } from '../capabilities/storage.cap.js'
import type { storageMigrationCapability } from '../capabilities/storage-migration.cap.js'
import type { streamBrokerCapability } from '../capabilities/stream-broker.cap.js'
import type { systemCapability } from '../capabilities/system.cap.js'
import type { terminalSessionCapability } from '../capabilities/terminal-session.cap.js'
import type { toastCapability } from '../capabilities/toast.cap.js'
import type { trainingCapability } from '../capabilities/training.cap.js'
import type { turnProviderCapability } from '../capabilities/turn-provider.cap.js'
import type { userManagementCapability } from '../capabilities/user-management.cap.js'

/**
 * Cluster-wide facade over every `scope: 'system'` capability. Each entry
 * is a typed namespace exposing only the cap's non-device-bound methods —
 * device-scoped slices already surface on `DeviceProxy`.
 *
 * Consumed by the SDK's `System` class as the source of truth for
 * `system.<cap>.<method>(input)` calls.
 */
export interface SystemProxy {
  readonly actions: Pick<InferProvider<typeof actionsCapability>, 'list' | 'stop' | 'getTraces' | 'create' | 'update' | 'delete' | 'setLinks'>
  readonly actionSource: Pick<InferProvider<typeof actionSourceCapability>, 'listActions' | 'runAction' | 'stopAction'>
  readonly addonPages: Pick<InferProvider<typeof addonPagesCapability>, 'listPages'>
  readonly addons: Pick<InferProvider<typeof addonsCapability>, 'list' | 'getLogs' | 'listPackages' | 'installPackage' | 'installFromWorkspace' | 'isWorkspaceAvailable' | 'listWorkspacePackages' | 'uninstallPackage' | 'listInstallations' | 'reloadPackages' | 'searchAvailable' | 'listUpdates' | 'updatePackage' | 'rollbackPackage' | 'forceRefresh' | 'restartServer' | 'getLastRestart' | 'listFrameworkPackages' | 'listCapabilityProviders' | 'setCapabilityProviderEnabled' | 'getVersions' | 'getPackageDocs' | 'restartAddon' | 'retryLoad' | 'getAutoUpdateSettings' | 'setAutoUpdateSettings' | 'getAddonAutoUpdate' | 'setAddonAutoUpdate' | 'applyAutoUpdateToAll' | 'custom' | 'startJob' | 'getJob' | 'listJobs' | 'cancelJob' | 'onAddonLogs'>
  readonly addonSettings: Pick<InferProvider<typeof addonSettingsCapability>, 'getGlobalSettings' | 'updateGlobalSettings' | 'getIntegrationSettings'>
  readonly addonWidgets: Pick<InferProvider<typeof addonWidgetsCapability>, 'listWidgets'>
  readonly alerts: Pick<InferProvider<typeof alertsCapability>, 'emit' | 'update' | 'list' | 'getUnreadCount' | 'markRead' | 'markAllRead' | 'dismiss'>
  readonly audioAnalyzer: Pick<InferProvider<typeof audioAnalyzerCapability>, 'analyseChunk' | 'classify' | 'attachDevice' | 'isReady' | 'dispose' | 'reprobeAudioEngine'>
  readonly audioCodec: Pick<InferProvider<typeof audioCodecCapability>, 'listSupportedCodecs' | 'canHandle' | 'createDecodeSession' | 'createEncodeSession' | 'closeSession' | 'pushEncodedFrame' | 'pullPcm' | 'pushPcm' | 'pullEncoded' | 'flushEncode' | 'listActiveSessions'>
  readonly backup: Pick<InferProvider<typeof backupCapability>, 'listDestinations' | 'trigger' | 'listRuns' | 'cancel' | 'list' | 'listLocations' | 'getEntries' | 'restore' | 'getEncryption' | 'setupEncryption' | 'disableEncryption' | 'checkBackupKey' | 'delete' | 'listArchives' | 'upsertDestinationPolicy' | 'previewSchedule' | 'listSchedules' | 'listAvailableDatabases' | 'upsertSchedule' | 'deleteSchedule'>
  readonly broker: Pick<InferProvider<typeof brokerCapability>, 'list' | 'get' | 'listProviders' | 'add' | 'remove' | 'testConnection' | 'getSettings' | 'setSettings' | 'getBrokerConfig' | 'getSettingsSchema' | 'testSettings' | 'publish' | 'subscribe' | 'unsubscribe' | 'getState' | 'getStatus'>
  readonly calendars: Pick<InferProvider<typeof calendarsCapability>, 'listCalendars' | 'listEvents' | 'getPreferences' | 'setCalendarPreference'>
  readonly connectionTest: Pick<InferProvider<typeof connectionTestCapability>, 'testSettings' | 'describeTest'>
  readonly coreBlocks: Pick<InferProvider<typeof coreBlocksCapability>, 'list' | 'get' | 'create' | 'update' | 'delete' | 'setEnabled' | 'restart' | 'compile' | 'getBlockSettings' | 'updateBlockSettings' | 'migrateRawSecrets' | 'getTypeDefs' | 'createComposition' | 'updateComposition' | 'getComposition' | 'listCompositions' | 'getCustomization' | 'listComposableCaps' | 'validateComposition' | 'reportAutomationRun' | 'getAutomationRunState' | 'getTraces'>
  readonly decoder: Pick<InferProvider<typeof decoderCapability>, 'getInfo' | 'reprobeHwaccel'>
  readonly deviceAdoption: Pick<InferProvider<typeof deviceAdoptionCapability>, 'listCandidateFilters' | 'listCandidates' | 'getCandidate' | 'refresh' | 'adopt' | 'release' | 'resync'>
  readonly deviceCredentials: Pick<InferProvider<typeof deviceCredentialsCapability>, 'listDeviceCredentials' | 'startEnrollment' | 'revokeDeviceCredential' | 'getDeviceCertificateSettings' | 'setDeviceCertificateSettings' | 'deleteDeviceCredential' | 'getDeviceCaStatus' | 'renameDeviceCredential'>
  readonly deviceExport: Pick<InferProvider<typeof deviceExportCapability>, 'getStatus' | 'listSupportedDeviceKinds' | 'listExposedDevices' | 'exposeDevice' | 'unexposeDevice'>
  readonly deviceHistory: Pick<InferProvider<typeof deviceHistoryCapability>, 'listNodeSeries' | 'queryNode' | 'queryMany' | 'declareSeries' | 'record' | 'recordBuckets' | 'getStatus' | 'listOrphanSeries' | 'deleteOrphanSeries'>
  readonly deviceManager: Pick<InferProvider<typeof deviceManagerCapability>, 'allocateDeviceId' | 'migrateDevice' | 'registerDevice' | 'removeDevice' | 'persistConfig' | 'getRoleDisplayDefaults' | 'setRoleDisplayDefaults' | 'listLocations' | 'addLocation' | 'removeLocation' | 'renameLocation' | 'listLocationIcons' | 'setLocationIcon' | 'listLocationDescriptions' | 'setLocationDescription' | 'listSiteZones' | 'setSiteZone' | 'removeSiteZone' | 'renameSiteZone' | 'setLocationZone' | 'listPersistedByAddon' | 'listAll' | 'getChildren' | 'getChildrenBatch' | 'getLinkedDevicesBatch' | 'listDeletedSince' | 'cleanupDeletedDevicesData' | 'removeByIntegration' | 'getBindingsBatch' | 'getAllBindings' | 'listDeviceIdsByCaps' | 'listWrappersForCap' | 'listBindableCapsForDeviceType' | 'discoverDevices' | 'adoptDevice' | 'getCreationSchema' | 'createDevice' | 'testCreationField' | 'adoptionListCandidateFilters' | 'adoptionListCandidates' | 'adoptionRefresh' | 'adoptionAdopt' | 'adoptionRelease' | 'adoptionStartJob' | 'adoptionListJobs' | 'adoptionCancelJob' | 'adoptionResync' | 'discoveryProviders' | 'discoverAllProviders' | 'discoverProvider' | 'providerCreationType' | 'providerDiscoveryParamsSchema' | 'getDeviceStatusAggregateBatch'>
  readonly deviceProvider: Pick<InferProvider<typeof deviceProviderCapability>, 'start' | 'stop' | 'getStatus' | 'getDevices' | 'reloadDevice' | 'supportsDiscovery' | 'discoverDevices' | 'getDiscoveryParamsSchema' | 'getManualCreationType' | 'adoptDiscoveredDevice' | 'supportsManualCreation' | 'getChildCreationSchema' | 'createDevice' | 'testCreationField'>
  readonly deviceState: Pick<InferProvider<typeof deviceStateCapability>, 'getAllSnapshots' | 'listClaims'>
  readonly displayPalette: Pick<InferProvider<typeof displayPaletteCapability>, 'getPalette' | 'listPresets' | 'setPalette'>
  readonly faceGallery: Pick<InferProvider<typeof faceGalleryCapability>, 'listIdentities' | 'createIdentity' | 'renameIdentity' | 'deleteIdentity' | 'listIdentitySamples' | 'auditIdentitySamples' | 'removeSample' | 'getFaceMedia' | 'assignFace' | 'unassignFace' | 'deleteFace' | 'assignFaces' | 'unassignFaces' | 'suggestFaceClusters'>
  readonly integrations: Pick<InferProvider<typeof integrationsCapability>, 'list' | 'get' | 'getByAddonId' | 'create' | 'update' | 'delete' | 'getSettings' | 'setSettings' | 'getAvailableTypes' | 'testConnection'>
  readonly keychainAdmin: Pick<InferProvider<typeof keychainAdminCapability>, 'status' | 'listSecrets' | 'listAudit' | 'reveal' | 'setSystemSecret' | 'importSecret' | 'deleteOrphans' | 'rotateMasterKey' | 'purgeRetiredKeys' | 'downloadRecoveryKey' | 'resetKeychain' | 'resetReport' | 'acknowledgeReset'>
  readonly llm: Pick<InferProvider<typeof llmCapability>, 'generate' | 'generateVision' | 'cancel' | 'listProfileKinds' | 'listProfiles' | 'upsertProfile' | 'migrateRawSecrets' | 'deleteProfile' | 'testProfile' | 'listModels' | 'getDefaults' | 'setDefault' | 'getUsage' | 'listModelCatalog' | 'listRuntimeNodes' | 'listNodeModels' | 'resolveModelRef' | 'installModel' | 'deleteModel' | 'getRuntimeStatus' | 'startRuntime' | 'stopRuntime'>
  readonly localNetwork: Pick<InferProvider<typeof localNetworkCapability>, 'list' | 'getPreferred' | 'getConnectionEndpoints' | 'getNotificationEndpoint' | 'setNotificationEndpoint' | 'getViewerEndpoints' | 'setViewerEndpoints' | 'getAddresses' | 'addCustomAddress' | 'removeCustomAddress' | 'setAddressRole' | 'getHubAddresses' | 'getAllowedAddresses' | 'setAllowedAddresses' | 'resetAllowlistToBestMatch' | 'getTlsStatus' | 'regenerateCertificate' | 'uploadCertificate' | 'downloadCa' | 'useStoredUploadedCertificate' | 'revertToGeneratedCertificate'>
  readonly meshNetwork: Pick<InferProvider<typeof meshNetworkCapability>, 'getStatus' | 'join' | 'startLogin' | 'leave' | 'logout' | 'listPeers' | 'testConnection'>
  readonly metricsProvider: Pick<InferProvider<typeof metricsProviderCapability>, 'collectSnapshot' | 'getCached' | 'getCurrent' | 'getDiskSpace' | 'getGpuInfo' | 'getCpuTemperature' | 'getProcessStats' | 'listAddonInstances' | 'getAddonStats' | 'listNodeProcesses' | 'getLoadSeries'>
  readonly mqttBroker: Pick<InferProvider<typeof mqttBrokerCapability>, 'listBrokers' | 'getBrokerConfig' | 'addBroker' | 'removeBroker' | 'testConnection' | 'startEmbeddedBroker' | 'stopEmbeddedBroker' | 'getStatus'>
  readonly networkAccess: Pick<InferProvider<typeof networkAccessCapability>, 'start' | 'stop' | 'getEndpoint' | 'getStatus' | 'listEndpoints'>
  readonly networkQuality: Pick<InferProvider<typeof networkQualityCapability>, 'getAllStats'>
  readonly nodes: Pick<InferProvider<typeof nodesCapability>, 'topology' | 'directory' | 'deployAddon' | 'undeployAddon' | 'restartAddon' | 'restartProcess' | 'restartNode' | 'shutdownNode' | 'renameNode' | 'clusterAddonStatus' | 'getCapUsageGraph' | 'getNodeAddons' | 'setProcessLogLevel' | 'executeQuery'>
  readonly notificationOutput: Pick<InferProvider<typeof notificationOutputCapability>, 'listTargetKinds' | 'listTargets' | 'getTarget' | 'discoverTargets' | 'probeTargetConfig' | 'send' | 'testTarget' | 'upsertTarget' | 'deleteTarget' | 'setTargetEnabled'>
  readonly notificationRules: Pick<InferProvider<typeof notificationRulesCapability>, 'listRules' | 'getRule' | 'createRule' | 'updateRule' | 'deleteRule' | 'setRuleEnabled' | 'listSequences' | 'getSequence' | 'createSequence' | 'updateSequence' | 'deleteSequence' | 'getClipRetentionAsks' | 'listDeviceMutes' | 'testRule' | 'previewStateSummary' | 'getConditionCatalog' | 'getTemplateCatalog' | 'previewTemplate' | 'getHistory' | 'getRuleLastRuns' | 'resolveArtifactUrl' | 'listSnoozes' | 'createSnooze' | 'cancelSnooze' | 'getAlarmConfig' | 'setAlarmConfig' | 'createAlarmProfile' | 'renameAlarmProfile' | 'deleteAlarmProfile' | 'activateAlarmProfile' | 'getAlarmSensors'>
  readonly oidcConnections: Pick<InferProvider<typeof oidcConnectionsCapability>, 'connectionFormSchema' | 'listConnections' | 'createConnection' | 'updateConnection' | 'deleteConnection'>
  readonly osdManager: Pick<InferProvider<typeof osdManagerCapability>, 'getConditionSupport' | 'copyDeviceConfiguration' | 'listTemplates' | 'upsertTemplate' | 'deleteTemplate'>
  readonly pipelineExecutor: Pick<InferProvider<typeof pipelineExecutorCapability>, 'getAvailableEngines' | 'getSelectedEngine' | 'getEngineProvisioning' | 'getVideoPipelineSteps' | 'setVideoPipelineSteps' | 'getInferenceDeviceHealth' | 'rearmInferenceDevice' | 'getSchema' | 'getOrchestratorConfigSchema' | 'validatePipeline' | 'getCapabilities' | 'getAddonModels' | 'downloadModel' | 'deleteModel' | 'cacheFrameInPool' | 'inferCached' | 'uncacheFrame' | 'getEffectiveTuning' | 'listLoadedEngines' | 'spinEngine' | 'killEngine' | 'listReferenceImages' | 'getReferenceImage' | 'getReferenceAudioFiles' | 'getReferenceAudio' | 'getAudioCapabilities' | 'runAudioTest' | 'getDetectionConfigSchema'>
  readonly pipelineOrchestrator: Pick<InferProvider<typeof pipelineOrchestratorCapability>, 'requestOccupancyLook' | 'pauseForStorageMigration' | 'resumeForStorageMigration' | 'rebalance' | 'getPipelineAssignments' | 'getAgentLoad' | 'getClusterModelChoice' | 'getGlobalMetrics' | 'getCapabilityBindings' | 'setCapabilityBinding' | 'getIngestOwner' | 'getAudioNodeLoad' | 'getAudioAssignments' | 'getAgentSettings' | 'listAgentSettings' | 'removeAgentSettings' | 'setAgentMaxCameras' | 'setAgentCapabilities' | 'setAgentDecodeLimits' | 'setAgentReachableHost' | 'setAgentInferenceDevices' | 'setNodeStepSettings' | 'getNodeInferenceDevices' | 'forgetInferenceDevice' | 'resetNodePipelineDefaults' | 'planAutoTune' | 'applyAutoTune' | 'setLoadBalancingShares' | 'getPlacementStats' | 'suggestShares' | 'getEffectiveShares' | 'setShareSource' | 'getNodeBenchmarkPreflight' | 'startNodeBenchmark' | 'getNodeBenchmarkStatus' | 'abortNodeBenchmark' | 'getNodeBenchmarkCandidates' | 'listNodeBenchmarkResults' | 'deleteNodeBenchmarkResult' | 'getCameraStatuses' | 'setCameraSensors' | 'reconcileFromDisk' | 'getReconcileFromDiskStatus'>
  readonly pipelineRunner: Pick<InferProvider<typeof pipelineRunnerCapability>, 'attachCamera' | 'reportMotion' | 'getLocalLoad' | 'getLocalMetrics' | 'getAllCameraMetrics' | 'getLocalCameras' | 'getNativeCrop' | 'runStatelessStep' | 'startNodeBench' | 'getNodeBenchStatus' | 'abortNodeBench'>
  readonly plateGallery: Pick<InferProvider<typeof plateGalleryCapability>, 'getPlateMedia' | 'searchPlates' | 'suggestPlateClusters' | 'correctPlateText' | 'deletePlate' | 'listVehicles' | 'createVehicle' | 'renameVehicle' | 'deleteVehicle' | 'listVehicleSamples' | 'removeVehicleSample' | 'assignPlate' | 'unassignPlate' | 'assignPlates' | 'unassignPlates'>
  readonly recordEntries: Pick<InferProvider<typeof recordEntriesCapability>, 'listEntryKinds' | 'listEntries' | 'putEntry' | 'deleteEntry'>
  readonly recordingArchive: Pick<InferProvider<typeof recordingArchiveCapability>, 'getAvailabilityBatch' | 'getDaysWithRecordingsBatch' | 'getStorageUsage' | 'listOpsLog' | 'pauseForStorageMigration' | 'resumeForStorageMigration' | 'refreshStorageLocationsForMigration' | 'startStorageMigrationMove' | 'getStorageMigrationMoveStatus' | 'cancelStorageMigrationMove' | 'relocateFootage' | 'listRelocateJobs' | 'getRelocateResidue' | 'reconcileLedgerAgainstDisk' | 'cancelRelocateJob' | 'planStorageRebalance' | 'startStorageRebalance' | 'getPlacement' | 'setDevicePlacement'>
  readonly recordingExport: Pick<InferProvider<typeof recordingExportCapability>, 'createExport' | 'getExport' | 'cancelExport' | 'deleteExport' | 'getDownloadUrl' | 'readExportBytes'>
  readonly serverManagement: Pick<InferProvider<typeof serverManagementCapability>, 'getServerPackageStatus' | 'checkServerUpdate' | 'applyServerUpdate' | 'rollbackServerUpdate' | 'restartServer'>
  readonly settingsStore: Pick<InferProvider<typeof settingsStoreCapability>, 'get' | 'set' | 'query' | 'upsert' | 'upsertMany' | 'insert' | 'insertMany' | 'transact' | 'update' | 'delete' | 'deleteWhere' | 'updateWhere' | 'count' | 'aggregate' | 'histogram' | 'isEmpty' | 'declareCollection'>
  readonly storage: Pick<InferProvider<typeof storageCapability>, 'resolve' | 'write' | 'read' | 'exists' | 'list' | 'delete' | 'getAvailableSpace' | 'beginUpload' | 'writeChunk' | 'finalizeUpload' | 'abortUpload' | 'beginDownload' | 'readChunk' | 'endDownload' | 'listLocations' | 'listLocationDeclarations' | 'upsertLocation' | 'deleteLocation' | 'listDrainProgress' | 'testLocation' | 'listProviders' | 'testConfig'>
  readonly storageMigration: Pick<InferProvider<typeof storageMigrationCapability>, 'plan' | 'start' | 'status' | 'cancel' | 'movers' | 'moverClearance' | 'residue' | 'drain' | 'cleanupStart' | 'cleanupStatus' | 'cleanupCancel' | 'history'>
  readonly streamBroker: Pick<InferProvider<typeof streamBrokerCapability>, 'fetchEventMedia' | 'listAllCameraStreams' | 'listAllProfileSlots' | 'getBrokerStats' | 'probeStream' | 'listClients' | 'getLiveViewerCounts' | 'killClient' | 'getStreamUrl' | 'getStreamWithCodec' | 'releaseStreamWithCodec' | 'acquireEgressTranscode' | 'releaseEgressTranscode' | 'subscribeAudioChunks' | 'pullAudioChunks' | 'unsubscribeAudioChunks' | 'setPreBufferDuration' | 'getPreBufferInfo' | 'getRtspPort' | 'getAllRtspEntries' | 'getRtspEntry' | 'regenerateRtspToken' | 'setRtspEnabled' | 'isRtspEnabled'>
  readonly system: Pick<InferProvider<typeof systemCapability>, 'info' | 'health' | 'featureFlags' | 'networkAddresses' | 'getRetentionConfig' | 'setRetentionConfig' | 'forceRetentionCleanup' | 'getSiteLocation' | 'setSiteLocation' | 'detectSiteLocation' | 'getRequestCensus' | 'getLoadContributions' | 'getFailureContributions' | 'getLoggingSettings' | 'setLoggingSettings'>
  readonly terminalSession: Pick<InferProvider<typeof terminalSessionCapability>, 'listProfiles' | 'listInstances' | 'createInstance' | 'updateInstance' | 'deleteInstance' | 'setInstanceEnabled' | 'listLegacyCameras' | 'adoptLegacyMonitor' | 'listSessions' | 'openSession' | 'resize' | 'pullOutput' | 'writeInput' | 'close'>
  readonly toast: Pick<InferProvider<typeof toastCapability>, 'onToast'>
  readonly training: Pick<InferProvider<typeof trainingCapability>, 'listBaseModels' | 'planJob' | 'startJob' | 'startJobBatch' | 'listJobs' | 'getJob' | 'cancelJob' | 'getJobResult' | 'listCanaryTargets' | 'registerResult' | 'canaryResult' | 'rollbackCanary' | 'discardResult'>
  readonly turnProvider: Pick<InferProvider<typeof turnProviderCapability>, 'getTurnServers'>
  readonly userManagement: Pick<InferProvider<typeof userManagementCapability>, 'listUsers' | 'createUser' | 'updateUser' | 'deleteUser' | 'resetPassword' | 'setUserScopes' | 'validateCredentials' | 'setupTotp' | 'confirmTotp' | 'disableTotp' | 'getTotpStatus' | 'migrateRawSecrets' | 'verifyTotp' | 'oauthIssueCode' | 'oauthExchangeCode' | 'oauthRefresh' | 'oauthVerifyAccessToken' | 'listExternalIdentities' | 'findUserByExternalIdentity' | 'unlinkExternalIdentity' | 'listOauthSessions' | 'revokeOauthSession'>
}

/**
 * Build a `SystemProxy` that dispatches every namespace method through
 * the existing system-cap tRPC procedures (`api.<capProp>.<method>.{query,mutate,subscribe}`).
 *
 * Pure function — no caching, no live state. The caller (typically
 * `System`) owns the `AddonApi` instance and disposes the proxy by
 * dropping the reference.
 */
export function createSystemProxy(api: AddonApi): SystemProxy {
  type Kind = TrpcDispatchKind

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function dispatch(capProp: string, method: string, kind: Kind, input?: unknown, push?: unknown): any {
    return invokeTrpcLeaf(api, capProp, method, kind, input, push)
  }

  const actionsInterface = {
    list: (input?: unknown) => dispatch('actions', 'list', 'query', input),
    stop: (input?: unknown) => dispatch('actions', 'stop', 'mutation', input),
    getTraces: (input?: unknown) => dispatch('actions', 'getTraces', 'query', input),
    create: (input?: unknown) => dispatch('actions', 'create', 'mutation', input),
    update: (input?: unknown) => dispatch('actions', 'update', 'mutation', input),
    delete: (input?: unknown) => dispatch('actions', 'delete', 'mutation', input),
    setLinks: (input?: unknown) => dispatch('actions', 'setLinks', 'mutation', input),
  }

  const actionSourceInterface = {
    listActions: (input?: unknown) => dispatch('actionSource', 'listActions', 'query', input),
    runAction: (input?: unknown) => dispatch('actionSource', 'runAction', 'mutation', input),
    stopAction: (input?: unknown) => dispatch('actionSource', 'stopAction', 'mutation', input),
  }

  const addonPagesInterface = {
    listPages: (input?: unknown) => dispatch('addonPages', 'listPages', 'query', input),
  }

  const addonsInterface = {
    list: (input?: unknown) => dispatch('addons', 'list', 'query', input),
    getLogs: (input?: unknown) => dispatch('addons', 'getLogs', 'query', input),
    listPackages: (input?: unknown) => dispatch('addons', 'listPackages', 'query', input),
    installPackage: (input?: unknown) => dispatch('addons', 'installPackage', 'mutation', input),
    installFromWorkspace: (input?: unknown) => dispatch('addons', 'installFromWorkspace', 'mutation', input),
    isWorkspaceAvailable: (input?: unknown) => dispatch('addons', 'isWorkspaceAvailable', 'query', input),
    listWorkspacePackages: (input?: unknown) => dispatch('addons', 'listWorkspacePackages', 'query', input),
    uninstallPackage: (input?: unknown) => dispatch('addons', 'uninstallPackage', 'mutation', input),
    listInstallations: (input?: unknown) => dispatch('addons', 'listInstallations', 'query', input),
    reloadPackages: (input?: unknown) => dispatch('addons', 'reloadPackages', 'mutation', input),
    searchAvailable: (input?: unknown) => dispatch('addons', 'searchAvailable', 'query', input),
    listUpdates: (input?: unknown) => dispatch('addons', 'listUpdates', 'query', input),
    updatePackage: (input?: unknown) => dispatch('addons', 'updatePackage', 'mutation', input),
    rollbackPackage: (input?: unknown) => dispatch('addons', 'rollbackPackage', 'mutation', input),
    forceRefresh: (input?: unknown) => dispatch('addons', 'forceRefresh', 'mutation', input),
    restartServer: (input?: unknown) => dispatch('addons', 'restartServer', 'mutation', input),
    getLastRestart: (input?: unknown) => dispatch('addons', 'getLastRestart', 'query', input),
    listFrameworkPackages: (input?: unknown) => dispatch('addons', 'listFrameworkPackages', 'query', input),
    listCapabilityProviders: (input?: unknown) => dispatch('addons', 'listCapabilityProviders', 'query', input),
    setCapabilityProviderEnabled: (input?: unknown) => dispatch('addons', 'setCapabilityProviderEnabled', 'mutation', input),
    getVersions: (input?: unknown) => dispatch('addons', 'getVersions', 'query', input),
    getPackageDocs: (input?: unknown) => dispatch('addons', 'getPackageDocs', 'query', input),
    restartAddon: (input?: unknown) => dispatch('addons', 'restartAddon', 'mutation', input),
    retryLoad: (input?: unknown) => dispatch('addons', 'retryLoad', 'mutation', input),
    getAutoUpdateSettings: (input?: unknown) => dispatch('addons', 'getAutoUpdateSettings', 'query', input),
    setAutoUpdateSettings: (input?: unknown) => dispatch('addons', 'setAutoUpdateSettings', 'mutation', input),
    getAddonAutoUpdate: (input?: unknown) => dispatch('addons', 'getAddonAutoUpdate', 'query', input),
    setAddonAutoUpdate: (input?: unknown) => dispatch('addons', 'setAddonAutoUpdate', 'mutation', input),
    applyAutoUpdateToAll: (input?: unknown) => dispatch('addons', 'applyAutoUpdateToAll', 'mutation', input),
    custom: (input?: unknown) => dispatch('addons', 'custom', 'mutation', input),
    startJob: (input?: unknown) => dispatch('addons', 'startJob', 'mutation', input),
    getJob: (input?: unknown) => dispatch('addons', 'getJob', 'query', input),
    listJobs: (input?: unknown) => dispatch('addons', 'listJobs', 'query', input),
    cancelJob: (input?: unknown) => dispatch('addons', 'cancelJob', 'mutation', input),
    onAddonLogs: (input?: unknown, push?: unknown) => dispatch('addons', 'onAddonLogs', 'subscription', input, push),
  }

  const addonSettingsInterface = {
    getGlobalSettings: (input?: unknown) => dispatch('addonSettings', 'getGlobalSettings', 'query', input),
    updateGlobalSettings: (input?: unknown) => dispatch('addonSettings', 'updateGlobalSettings', 'mutation', input),
    getIntegrationSettings: (input?: unknown) => dispatch('addonSettings', 'getIntegrationSettings', 'query', input),
  }

  const addonWidgetsInterface = {
    listWidgets: (input?: unknown) => dispatch('addonWidgets', 'listWidgets', 'query', input),
  }

  const alertsInterface = {
    emit: (input?: unknown) => dispatch('alerts', 'emit', 'mutation', input),
    update: (input?: unknown) => dispatch('alerts', 'update', 'mutation', input),
    list: (input?: unknown) => dispatch('alerts', 'list', 'query', input),
    getUnreadCount: (input?: unknown) => dispatch('alerts', 'getUnreadCount', 'query', input),
    markRead: (input?: unknown) => dispatch('alerts', 'markRead', 'mutation', input),
    markAllRead: (input?: unknown) => dispatch('alerts', 'markAllRead', 'mutation', input),
    dismiss: (input?: unknown) => dispatch('alerts', 'dismiss', 'mutation', input),
  }

  const audioAnalyzerInterface = {
    analyseChunk: (input?: unknown) => dispatch('audioAnalyzer', 'analyseChunk', 'mutation', input),
    classify: (input?: unknown) => dispatch('audioAnalyzer', 'classify', 'query', input),
    attachDevice: (input?: unknown) => dispatch('audioAnalyzer', 'attachDevice', 'mutation', input),
    isReady: (input?: unknown) => dispatch('audioAnalyzer', 'isReady', 'query', input),
    dispose: (input?: unknown) => dispatch('audioAnalyzer', 'dispose', 'mutation', input),
    reprobeAudioEngine: (input?: unknown) => dispatch('audioAnalyzer', 'reprobeAudioEngine', 'mutation', input),
  }

  const audioCodecInterface = {
    listSupportedCodecs: (input?: unknown) => dispatch('audioCodec', 'listSupportedCodecs', 'query', input),
    canHandle: (input?: unknown) => dispatch('audioCodec', 'canHandle', 'query', input),
    createDecodeSession: (input?: unknown) => dispatch('audioCodec', 'createDecodeSession', 'mutation', input),
    createEncodeSession: (input?: unknown) => dispatch('audioCodec', 'createEncodeSession', 'mutation', input),
    closeSession: (input?: unknown) => dispatch('audioCodec', 'closeSession', 'mutation', input),
    pushEncodedFrame: (input?: unknown) => dispatch('audioCodec', 'pushEncodedFrame', 'mutation', input),
    pullPcm: (input?: unknown) => dispatch('audioCodec', 'pullPcm', 'query', input),
    pushPcm: (input?: unknown) => dispatch('audioCodec', 'pushPcm', 'mutation', input),
    pullEncoded: (input?: unknown) => dispatch('audioCodec', 'pullEncoded', 'query', input),
    flushEncode: (input?: unknown) => dispatch('audioCodec', 'flushEncode', 'mutation', input),
    listActiveSessions: (input?: unknown) => dispatch('audioCodec', 'listActiveSessions', 'query', input),
  }

  const backupInterface = {
    listDestinations: (input?: unknown) => dispatch('backup', 'listDestinations', 'query', input),
    trigger: (input?: unknown) => dispatch('backup', 'trigger', 'mutation', input),
    listRuns: (input?: unknown) => dispatch('backup', 'listRuns', 'query', input),
    cancel: (input?: unknown) => dispatch('backup', 'cancel', 'mutation', input),
    list: (input?: unknown) => dispatch('backup', 'list', 'query', input),
    listLocations: (input?: unknown) => dispatch('backup', 'listLocations', 'query', input),
    getEntries: (input?: unknown) => dispatch('backup', 'getEntries', 'query', input),
    restore: (input?: unknown) => dispatch('backup', 'restore', 'mutation', input),
    getEncryption: (input?: unknown) => dispatch('backup', 'getEncryption', 'query', input),
    setupEncryption: (input?: unknown) => dispatch('backup', 'setupEncryption', 'mutation', input),
    disableEncryption: (input?: unknown) => dispatch('backup', 'disableEncryption', 'mutation', input),
    checkBackupKey: (input?: unknown) => dispatch('backup', 'checkBackupKey', 'mutation', input),
    delete: (input?: unknown) => dispatch('backup', 'delete', 'mutation', input),
    listArchives: (input?: unknown) => dispatch('backup', 'listArchives', 'query', input),
    upsertDestinationPolicy: (input?: unknown) => dispatch('backup', 'upsertDestinationPolicy', 'mutation', input),
    previewSchedule: (input?: unknown) => dispatch('backup', 'previewSchedule', 'query', input),
    listSchedules: (input?: unknown) => dispatch('backup', 'listSchedules', 'query', input),
    listAvailableDatabases: (input?: unknown) => dispatch('backup', 'listAvailableDatabases', 'query', input),
    upsertSchedule: (input?: unknown) => dispatch('backup', 'upsertSchedule', 'mutation', input),
    deleteSchedule: (input?: unknown) => dispatch('backup', 'deleteSchedule', 'mutation', input),
  }

  const brokerInterface = {
    list: (input?: unknown) => dispatch('broker', 'list', 'query', input),
    get: (input?: unknown) => dispatch('broker', 'get', 'query', input),
    listProviders: (input?: unknown) => dispatch('broker', 'listProviders', 'query', input),
    add: (input?: unknown) => dispatch('broker', 'add', 'mutation', input),
    remove: (input?: unknown) => dispatch('broker', 'remove', 'mutation', input),
    testConnection: (input?: unknown) => dispatch('broker', 'testConnection', 'mutation', input),
    getSettings: (input?: unknown) => dispatch('broker', 'getSettings', 'query', input),
    setSettings: (input?: unknown) => dispatch('broker', 'setSettings', 'mutation', input),
    getBrokerConfig: (input?: unknown) => dispatch('broker', 'getBrokerConfig', 'query', input),
    getSettingsSchema: (input?: unknown) => dispatch('broker', 'getSettingsSchema', 'query', input),
    testSettings: (input?: unknown) => dispatch('broker', 'testSettings', 'mutation', input),
    publish: (input?: unknown) => dispatch('broker', 'publish', 'mutation', input),
    subscribe: (input?: unknown) => dispatch('broker', 'subscribe', 'mutation', input),
    unsubscribe: (input?: unknown) => dispatch('broker', 'unsubscribe', 'mutation', input),
    getState: (input?: unknown) => dispatch('broker', 'getState', 'query', input),
    getStatus: (input?: unknown) => dispatch('broker', 'getStatus', 'query', input),
  }

  const calendarsInterface = {
    listCalendars: (input?: unknown) => dispatch('calendars', 'listCalendars', 'query', input),
    listEvents: (input?: unknown) => dispatch('calendars', 'listEvents', 'query', input),
    getPreferences: (input?: unknown) => dispatch('calendars', 'getPreferences', 'query', input),
    setCalendarPreference: (input?: unknown) => dispatch('calendars', 'setCalendarPreference', 'mutation', input),
  }

  const connectionTestInterface = {
    testSettings: (input?: unknown) => dispatch('connectionTest', 'testSettings', 'mutation', input),
    describeTest: (input?: unknown) => dispatch('connectionTest', 'describeTest', 'query', input),
  }

  const coreBlocksInterface = {
    list: (input?: unknown) => dispatch('coreBlocks', 'list', 'query', input),
    get: (input?: unknown) => dispatch('coreBlocks', 'get', 'query', input),
    create: (input?: unknown) => dispatch('coreBlocks', 'create', 'mutation', input),
    update: (input?: unknown) => dispatch('coreBlocks', 'update', 'mutation', input),
    delete: (input?: unknown) => dispatch('coreBlocks', 'delete', 'mutation', input),
    setEnabled: (input?: unknown) => dispatch('coreBlocks', 'setEnabled', 'mutation', input),
    restart: (input?: unknown) => dispatch('coreBlocks', 'restart', 'mutation', input),
    compile: (input?: unknown) => dispatch('coreBlocks', 'compile', 'mutation', input),
    getBlockSettings: (input?: unknown) => dispatch('coreBlocks', 'getBlockSettings', 'query', input),
    updateBlockSettings: (input?: unknown) => dispatch('coreBlocks', 'updateBlockSettings', 'mutation', input),
    migrateRawSecrets: (input?: unknown) => dispatch('coreBlocks', 'migrateRawSecrets', 'mutation', input),
    getTypeDefs: (input?: unknown) => dispatch('coreBlocks', 'getTypeDefs', 'query', input),
    createComposition: (input?: unknown) => dispatch('coreBlocks', 'createComposition', 'mutation', input),
    updateComposition: (input?: unknown) => dispatch('coreBlocks', 'updateComposition', 'mutation', input),
    getComposition: (input?: unknown) => dispatch('coreBlocks', 'getComposition', 'query', input),
    listCompositions: (input?: unknown) => dispatch('coreBlocks', 'listCompositions', 'query', input),
    getCustomization: (input?: unknown) => dispatch('coreBlocks', 'getCustomization', 'query', input),
    listComposableCaps: (input?: unknown) => dispatch('coreBlocks', 'listComposableCaps', 'query', input),
    validateComposition: (input?: unknown) => dispatch('coreBlocks', 'validateComposition', 'mutation', input),
    reportAutomationRun: (input?: unknown) => dispatch('coreBlocks', 'reportAutomationRun', 'mutation', input),
    getAutomationRunState: (input?: unknown) => dispatch('coreBlocks', 'getAutomationRunState', 'query', input),
    getTraces: (input?: unknown) => dispatch('coreBlocks', 'getTraces', 'query', input),
  }

  const decoderInterface = {
    getInfo: (input?: unknown) => dispatch('decoder', 'getInfo', 'query', input),
    reprobeHwaccel: (input?: unknown) => dispatch('decoder', 'reprobeHwaccel', 'mutation', input),
  }

  const deviceAdoptionInterface = {
    listCandidateFilters: (input?: unknown) => dispatch('deviceAdoption', 'listCandidateFilters', 'query', input),
    listCandidates: (input?: unknown) => dispatch('deviceAdoption', 'listCandidates', 'query', input),
    getCandidate: (input?: unknown) => dispatch('deviceAdoption', 'getCandidate', 'query', input),
    refresh: (input?: unknown) => dispatch('deviceAdoption', 'refresh', 'mutation', input),
    adopt: (input?: unknown) => dispatch('deviceAdoption', 'adopt', 'mutation', input),
    release: (input?: unknown) => dispatch('deviceAdoption', 'release', 'mutation', input),
    resync: (input?: unknown) => dispatch('deviceAdoption', 'resync', 'mutation', input),
  }

  const deviceCredentialsInterface = {
    listDeviceCredentials: (input?: unknown) => dispatch('deviceCredentials', 'listDeviceCredentials', 'query', input),
    startEnrollment: (input?: unknown) => dispatch('deviceCredentials', 'startEnrollment', 'mutation', input),
    revokeDeviceCredential: (input?: unknown) => dispatch('deviceCredentials', 'revokeDeviceCredential', 'mutation', input),
    getDeviceCertificateSettings: (input?: unknown) => dispatch('deviceCredentials', 'getDeviceCertificateSettings', 'query', input),
    setDeviceCertificateSettings: (input?: unknown) => dispatch('deviceCredentials', 'setDeviceCertificateSettings', 'mutation', input),
    deleteDeviceCredential: (input?: unknown) => dispatch('deviceCredentials', 'deleteDeviceCredential', 'mutation', input),
    getDeviceCaStatus: (input?: unknown) => dispatch('deviceCredentials', 'getDeviceCaStatus', 'query', input),
    renameDeviceCredential: (input?: unknown) => dispatch('deviceCredentials', 'renameDeviceCredential', 'mutation', input),
  }

  const deviceExportInterface = {
    getStatus: (input?: unknown) => dispatch('deviceExport', 'getStatus', 'query', input),
    listSupportedDeviceKinds: (input?: unknown) => dispatch('deviceExport', 'listSupportedDeviceKinds', 'query', input),
    listExposedDevices: (input?: unknown) => dispatch('deviceExport', 'listExposedDevices', 'query', input),
    exposeDevice: (input?: unknown) => dispatch('deviceExport', 'exposeDevice', 'mutation', input),
    unexposeDevice: (input?: unknown) => dispatch('deviceExport', 'unexposeDevice', 'mutation', input),
  }

  const deviceHistoryInterface = {
    listNodeSeries: (input?: unknown) => dispatch('deviceHistory', 'listNodeSeries', 'query', input),
    queryNode: (input?: unknown) => dispatch('deviceHistory', 'queryNode', 'query', input),
    queryMany: (input?: unknown) => dispatch('deviceHistory', 'queryMany', 'query', input),
    declareSeries: (input?: unknown) => dispatch('deviceHistory', 'declareSeries', 'mutation', input),
    record: (input?: unknown) => dispatch('deviceHistory', 'record', 'mutation', input),
    recordBuckets: (input?: unknown) => dispatch('deviceHistory', 'recordBuckets', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('deviceHistory', 'getStatus', 'query', input),
    listOrphanSeries: (input?: unknown) => dispatch('deviceHistory', 'listOrphanSeries', 'query', input),
    deleteOrphanSeries: (input?: unknown) => dispatch('deviceHistory', 'deleteOrphanSeries', 'mutation', input),
  }

  const deviceManagerInterface = {
    allocateDeviceId: (input?: unknown) => dispatch('deviceManager', 'allocateDeviceId', 'mutation', input),
    migrateDevice: (input?: unknown) => dispatch('deviceManager', 'migrateDevice', 'mutation', input),
    registerDevice: (input?: unknown) => dispatch('deviceManager', 'registerDevice', 'mutation', input),
    removeDevice: (input?: unknown) => dispatch('deviceManager', 'removeDevice', 'mutation', input),
    persistConfig: (input?: unknown) => dispatch('deviceManager', 'persistConfig', 'mutation', input),
    getRoleDisplayDefaults: (input?: unknown) => dispatch('deviceManager', 'getRoleDisplayDefaults', 'query', input),
    setRoleDisplayDefaults: (input?: unknown) => dispatch('deviceManager', 'setRoleDisplayDefaults', 'mutation', input),
    listLocations: (input?: unknown) => dispatch('deviceManager', 'listLocations', 'query', input),
    addLocation: (input?: unknown) => dispatch('deviceManager', 'addLocation', 'mutation', input),
    removeLocation: (input?: unknown) => dispatch('deviceManager', 'removeLocation', 'mutation', input),
    renameLocation: (input?: unknown) => dispatch('deviceManager', 'renameLocation', 'mutation', input),
    listLocationIcons: (input?: unknown) => dispatch('deviceManager', 'listLocationIcons', 'query', input),
    setLocationIcon: (input?: unknown) => dispatch('deviceManager', 'setLocationIcon', 'mutation', input),
    listLocationDescriptions: (input?: unknown) => dispatch('deviceManager', 'listLocationDescriptions', 'query', input),
    setLocationDescription: (input?: unknown) => dispatch('deviceManager', 'setLocationDescription', 'mutation', input),
    listSiteZones: (input?: unknown) => dispatch('deviceManager', 'listSiteZones', 'query', input),
    setSiteZone: (input?: unknown) => dispatch('deviceManager', 'setSiteZone', 'mutation', input),
    removeSiteZone: (input?: unknown) => dispatch('deviceManager', 'removeSiteZone', 'mutation', input),
    renameSiteZone: (input?: unknown) => dispatch('deviceManager', 'renameSiteZone', 'mutation', input),
    setLocationZone: (input?: unknown) => dispatch('deviceManager', 'setLocationZone', 'mutation', input),
    listPersistedByAddon: (input?: unknown) => dispatch('deviceManager', 'listPersistedByAddon', 'query', input),
    listAll: (input?: unknown) => dispatch('deviceManager', 'listAll', 'query', input),
    getChildren: (input?: unknown) => dispatch('deviceManager', 'getChildren', 'query', input),
    getChildrenBatch: (input?: unknown) => dispatch('deviceManager', 'getChildrenBatch', 'query', input),
    getLinkedDevicesBatch: (input?: unknown) => dispatch('deviceManager', 'getLinkedDevicesBatch', 'query', input),
    listDeletedSince: (input?: unknown) => dispatch('deviceManager', 'listDeletedSince', 'query', input),
    cleanupDeletedDevicesData: (input?: unknown) => dispatch('deviceManager', 'cleanupDeletedDevicesData', 'mutation', input),
    removeByIntegration: (input?: unknown) => dispatch('deviceManager', 'removeByIntegration', 'mutation', input),
    getBindingsBatch: (input?: unknown) => dispatch('deviceManager', 'getBindingsBatch', 'query', input),
    getAllBindings: (input?: unknown) => dispatch('deviceManager', 'getAllBindings', 'query', input),
    listDeviceIdsByCaps: (input?: unknown) => dispatch('deviceManager', 'listDeviceIdsByCaps', 'query', input),
    listWrappersForCap: (input?: unknown) => dispatch('deviceManager', 'listWrappersForCap', 'query', input),
    listBindableCapsForDeviceType: (input?: unknown) => dispatch('deviceManager', 'listBindableCapsForDeviceType', 'query', input),
    discoverDevices: (input?: unknown) => dispatch('deviceManager', 'discoverDevices', 'mutation', input),
    adoptDevice: (input?: unknown) => dispatch('deviceManager', 'adoptDevice', 'mutation', input),
    getCreationSchema: (input?: unknown) => dispatch('deviceManager', 'getCreationSchema', 'query', input),
    createDevice: (input?: unknown) => dispatch('deviceManager', 'createDevice', 'mutation', input),
    testCreationField: (input?: unknown) => dispatch('deviceManager', 'testCreationField', 'mutation', input),
    adoptionListCandidateFilters: (input?: unknown) => dispatch('deviceManager', 'adoptionListCandidateFilters', 'query', input),
    adoptionListCandidates: (input?: unknown) => dispatch('deviceManager', 'adoptionListCandidates', 'query', input),
    adoptionRefresh: (input?: unknown) => dispatch('deviceManager', 'adoptionRefresh', 'mutation', input),
    adoptionAdopt: (input?: unknown) => dispatch('deviceManager', 'adoptionAdopt', 'mutation', input),
    adoptionRelease: (input?: unknown) => dispatch('deviceManager', 'adoptionRelease', 'mutation', input),
    adoptionStartJob: (input?: unknown) => dispatch('deviceManager', 'adoptionStartJob', 'mutation', input),
    adoptionListJobs: (input?: unknown) => dispatch('deviceManager', 'adoptionListJobs', 'query', input),
    adoptionCancelJob: (input?: unknown) => dispatch('deviceManager', 'adoptionCancelJob', 'mutation', input),
    adoptionResync: (input?: unknown) => dispatch('deviceManager', 'adoptionResync', 'mutation', input),
    discoveryProviders: (input?: unknown) => dispatch('deviceManager', 'discoveryProviders', 'query', input),
    discoverAllProviders: (input?: unknown) => dispatch('deviceManager', 'discoverAllProviders', 'mutation', input),
    discoverProvider: (input?: unknown) => dispatch('deviceManager', 'discoverProvider', 'mutation', input),
    providerCreationType: (input?: unknown) => dispatch('deviceManager', 'providerCreationType', 'query', input),
    providerDiscoveryParamsSchema: (input?: unknown) => dispatch('deviceManager', 'providerDiscoveryParamsSchema', 'query', input),
    getDeviceStatusAggregateBatch: (input?: unknown) => dispatch('deviceManager', 'getDeviceStatusAggregateBatch', 'query', input),
  }

  const deviceProviderInterface = {
    start: (input?: unknown) => dispatch('deviceProvider', 'start', 'mutation', input),
    stop: (input?: unknown) => dispatch('deviceProvider', 'stop', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('deviceProvider', 'getStatus', 'query', input),
    getDevices: (input?: unknown) => dispatch('deviceProvider', 'getDevices', 'query', input),
    reloadDevice: (input?: unknown) => dispatch('deviceProvider', 'reloadDevice', 'mutation', input),
    supportsDiscovery: (input?: unknown) => dispatch('deviceProvider', 'supportsDiscovery', 'query', input),
    discoverDevices: (input?: unknown) => dispatch('deviceProvider', 'discoverDevices', 'mutation', input),
    getDiscoveryParamsSchema: (input?: unknown) => dispatch('deviceProvider', 'getDiscoveryParamsSchema', 'query', input),
    getManualCreationType: (input?: unknown) => dispatch('deviceProvider', 'getManualCreationType', 'query', input),
    adoptDiscoveredDevice: (input?: unknown) => dispatch('deviceProvider', 'adoptDiscoveredDevice', 'mutation', input),
    supportsManualCreation: (input?: unknown) => dispatch('deviceProvider', 'supportsManualCreation', 'query', input),
    getChildCreationSchema: (input?: unknown) => dispatch('deviceProvider', 'getChildCreationSchema', 'query', input),
    createDevice: (input?: unknown) => dispatch('deviceProvider', 'createDevice', 'mutation', input),
    testCreationField: (input?: unknown) => dispatch('deviceProvider', 'testCreationField', 'mutation', input),
  }

  const deviceStateInterface = {
    getAllSnapshots: (input?: unknown) => dispatch('deviceState', 'getAllSnapshots', 'query', input),
    listClaims: (input?: unknown) => dispatch('deviceState', 'listClaims', 'query', input),
  }

  const displayPaletteInterface = {
    getPalette: (input?: unknown) => dispatch('displayPalette', 'getPalette', 'query', input),
    listPresets: (input?: unknown) => dispatch('displayPalette', 'listPresets', 'query', input),
    setPalette: (input?: unknown) => dispatch('displayPalette', 'setPalette', 'mutation', input),
  }

  const faceGalleryInterface = {
    listIdentities: (input?: unknown) => dispatch('faceGallery', 'listIdentities', 'query', input),
    createIdentity: (input?: unknown) => dispatch('faceGallery', 'createIdentity', 'mutation', input),
    renameIdentity: (input?: unknown) => dispatch('faceGallery', 'renameIdentity', 'mutation', input),
    deleteIdentity: (input?: unknown) => dispatch('faceGallery', 'deleteIdentity', 'mutation', input),
    listIdentitySamples: (input?: unknown) => dispatch('faceGallery', 'listIdentitySamples', 'query', input),
    auditIdentitySamples: (input?: unknown) => dispatch('faceGallery', 'auditIdentitySamples', 'query', input),
    removeSample: (input?: unknown) => dispatch('faceGallery', 'removeSample', 'mutation', input),
    getFaceMedia: (input?: unknown) => dispatch('faceGallery', 'getFaceMedia', 'query', input),
    assignFace: (input?: unknown) => dispatch('faceGallery', 'assignFace', 'mutation', input),
    unassignFace: (input?: unknown) => dispatch('faceGallery', 'unassignFace', 'mutation', input),
    deleteFace: (input?: unknown) => dispatch('faceGallery', 'deleteFace', 'mutation', input),
    assignFaces: (input?: unknown) => dispatch('faceGallery', 'assignFaces', 'mutation', input),
    unassignFaces: (input?: unknown) => dispatch('faceGallery', 'unassignFaces', 'mutation', input),
    suggestFaceClusters: (input?: unknown) => dispatch('faceGallery', 'suggestFaceClusters', 'query', input),
  }

  const integrationsInterface = {
    list: (input?: unknown) => dispatch('integrations', 'list', 'query', input),
    get: (input?: unknown) => dispatch('integrations', 'get', 'query', input),
    getByAddonId: (input?: unknown) => dispatch('integrations', 'getByAddonId', 'query', input),
    create: (input?: unknown) => dispatch('integrations', 'create', 'mutation', input),
    update: (input?: unknown) => dispatch('integrations', 'update', 'mutation', input),
    delete: (input?: unknown) => dispatch('integrations', 'delete', 'mutation', input),
    getSettings: (input?: unknown) => dispatch('integrations', 'getSettings', 'query', input),
    setSettings: (input?: unknown) => dispatch('integrations', 'setSettings', 'mutation', input),
    getAvailableTypes: (input?: unknown) => dispatch('integrations', 'getAvailableTypes', 'query', input),
    testConnection: (input?: unknown) => dispatch('integrations', 'testConnection', 'mutation', input),
  }

  const keychainAdminInterface = {
    status: (input?: unknown) => dispatch('keychainAdmin', 'status', 'query', input),
    listSecrets: (input?: unknown) => dispatch('keychainAdmin', 'listSecrets', 'query', input),
    listAudit: (input?: unknown) => dispatch('keychainAdmin', 'listAudit', 'query', input),
    reveal: (input?: unknown) => dispatch('keychainAdmin', 'reveal', 'mutation', input),
    setSystemSecret: (input?: unknown) => dispatch('keychainAdmin', 'setSystemSecret', 'mutation', input),
    importSecret: (input?: unknown) => dispatch('keychainAdmin', 'importSecret', 'mutation', input),
    deleteOrphans: (input?: unknown) => dispatch('keychainAdmin', 'deleteOrphans', 'mutation', input),
    rotateMasterKey: (input?: unknown) => dispatch('keychainAdmin', 'rotateMasterKey', 'mutation', input),
    purgeRetiredKeys: (input?: unknown) => dispatch('keychainAdmin', 'purgeRetiredKeys', 'mutation', input),
    downloadRecoveryKey: (input?: unknown) => dispatch('keychainAdmin', 'downloadRecoveryKey', 'mutation', input),
    resetKeychain: (input?: unknown) => dispatch('keychainAdmin', 'resetKeychain', 'mutation', input),
    resetReport: (input?: unknown) => dispatch('keychainAdmin', 'resetReport', 'query', input),
    acknowledgeReset: (input?: unknown) => dispatch('keychainAdmin', 'acknowledgeReset', 'mutation', input),
  }

  const llmInterface = {
    generate: (input?: unknown) => dispatch('llm', 'generate', 'mutation', input),
    generateVision: (input?: unknown) => dispatch('llm', 'generateVision', 'mutation', input),
    cancel: (input?: unknown) => dispatch('llm', 'cancel', 'mutation', input),
    listProfileKinds: (input?: unknown) => dispatch('llm', 'listProfileKinds', 'query', input),
    listProfiles: (input?: unknown) => dispatch('llm', 'listProfiles', 'query', input),
    upsertProfile: (input?: unknown) => dispatch('llm', 'upsertProfile', 'mutation', input),
    migrateRawSecrets: (input?: unknown) => dispatch('llm', 'migrateRawSecrets', 'mutation', input),
    deleteProfile: (input?: unknown) => dispatch('llm', 'deleteProfile', 'mutation', input),
    testProfile: (input?: unknown) => dispatch('llm', 'testProfile', 'mutation', input),
    listModels: (input?: unknown) => dispatch('llm', 'listModels', 'mutation', input),
    getDefaults: (input?: unknown) => dispatch('llm', 'getDefaults', 'query', input),
    setDefault: (input?: unknown) => dispatch('llm', 'setDefault', 'mutation', input),
    getUsage: (input?: unknown) => dispatch('llm', 'getUsage', 'query', input),
    listModelCatalog: (input?: unknown) => dispatch('llm', 'listModelCatalog', 'query', input),
    listRuntimeNodes: (input?: unknown) => dispatch('llm', 'listRuntimeNodes', 'query', input),
    listNodeModels: (input?: unknown) => dispatch('llm', 'listNodeModels', 'query', input),
    resolveModelRef: (input?: unknown) => dispatch('llm', 'resolveModelRef', 'mutation', input),
    installModel: (input?: unknown) => dispatch('llm', 'installModel', 'mutation', input),
    deleteModel: (input?: unknown) => dispatch('llm', 'deleteModel', 'mutation', input),
    getRuntimeStatus: (input?: unknown) => dispatch('llm', 'getRuntimeStatus', 'query', input),
    startRuntime: (input?: unknown) => dispatch('llm', 'startRuntime', 'mutation', input),
    stopRuntime: (input?: unknown) => dispatch('llm', 'stopRuntime', 'mutation', input),
  }

  const localNetworkInterface = {
    list: (input?: unknown) => dispatch('localNetwork', 'list', 'query', input),
    getPreferred: (input?: unknown) => dispatch('localNetwork', 'getPreferred', 'query', input),
    getConnectionEndpoints: (input?: unknown) => dispatch('localNetwork', 'getConnectionEndpoints', 'query', input),
    getNotificationEndpoint: (input?: unknown) => dispatch('localNetwork', 'getNotificationEndpoint', 'query', input),
    setNotificationEndpoint: (input?: unknown) => dispatch('localNetwork', 'setNotificationEndpoint', 'mutation', input),
    getViewerEndpoints: (input?: unknown) => dispatch('localNetwork', 'getViewerEndpoints', 'query', input),
    setViewerEndpoints: (input?: unknown) => dispatch('localNetwork', 'setViewerEndpoints', 'mutation', input),
    getAddresses: (input?: unknown) => dispatch('localNetwork', 'getAddresses', 'query', input),
    addCustomAddress: (input?: unknown) => dispatch('localNetwork', 'addCustomAddress', 'mutation', input),
    removeCustomAddress: (input?: unknown) => dispatch('localNetwork', 'removeCustomAddress', 'mutation', input),
    setAddressRole: (input?: unknown) => dispatch('localNetwork', 'setAddressRole', 'mutation', input),
    getHubAddresses: (input?: unknown) => dispatch('localNetwork', 'getHubAddresses', 'query', input),
    getAllowedAddresses: (input?: unknown) => dispatch('localNetwork', 'getAllowedAddresses', 'query', input),
    setAllowedAddresses: (input?: unknown) => dispatch('localNetwork', 'setAllowedAddresses', 'mutation', input),
    resetAllowlistToBestMatch: (input?: unknown) => dispatch('localNetwork', 'resetAllowlistToBestMatch', 'mutation', input),
    getTlsStatus: (input?: unknown) => dispatch('localNetwork', 'getTlsStatus', 'query', input),
    regenerateCertificate: (input?: unknown) => dispatch('localNetwork', 'regenerateCertificate', 'mutation', input),
    uploadCertificate: (input?: unknown) => dispatch('localNetwork', 'uploadCertificate', 'mutation', input),
    downloadCa: (input?: unknown) => dispatch('localNetwork', 'downloadCa', 'query', input),
    useStoredUploadedCertificate: (input?: unknown) => dispatch('localNetwork', 'useStoredUploadedCertificate', 'mutation', input),
    revertToGeneratedCertificate: (input?: unknown) => dispatch('localNetwork', 'revertToGeneratedCertificate', 'mutation', input),
  }

  const meshNetworkInterface = {
    getStatus: (input?: unknown) => dispatch('meshNetwork', 'getStatus', 'query', input),
    join: (input?: unknown) => dispatch('meshNetwork', 'join', 'mutation', input),
    startLogin: (input?: unknown) => dispatch('meshNetwork', 'startLogin', 'mutation', input),
    leave: (input?: unknown) => dispatch('meshNetwork', 'leave', 'mutation', input),
    logout: (input?: unknown) => dispatch('meshNetwork', 'logout', 'mutation', input),
    listPeers: (input?: unknown) => dispatch('meshNetwork', 'listPeers', 'query', input),
    testConnection: (input?: unknown) => dispatch('meshNetwork', 'testConnection', 'mutation', input),
  }

  const metricsProviderInterface = {
    collectSnapshot: (input?: unknown) => dispatch('metricsProvider', 'collectSnapshot', 'query', input),
    getCached: (input?: unknown) => dispatch('metricsProvider', 'getCached', 'query', input),
    getCurrent: (input?: unknown) => dispatch('metricsProvider', 'getCurrent', 'query', input),
    getDiskSpace: (input?: unknown) => dispatch('metricsProvider', 'getDiskSpace', 'query', input),
    getGpuInfo: (input?: unknown) => dispatch('metricsProvider', 'getGpuInfo', 'query', input),
    getCpuTemperature: (input?: unknown) => dispatch('metricsProvider', 'getCpuTemperature', 'query', input),
    getProcessStats: (input?: unknown) => dispatch('metricsProvider', 'getProcessStats', 'query', input),
    listAddonInstances: (input?: unknown) => dispatch('metricsProvider', 'listAddonInstances', 'query', input),
    getAddonStats: (input?: unknown) => dispatch('metricsProvider', 'getAddonStats', 'query', input),
    listNodeProcesses: (input?: unknown) => dispatch('metricsProvider', 'listNodeProcesses', 'query', input),
    getLoadSeries: (input?: unknown) => dispatch('metricsProvider', 'getLoadSeries', 'query', input),
  }

  const mqttBrokerInterface = {
    listBrokers: (input?: unknown) => dispatch('mqttBroker', 'listBrokers', 'query', input),
    getBrokerConfig: (input?: unknown) => dispatch('mqttBroker', 'getBrokerConfig', 'query', input),
    addBroker: (input?: unknown) => dispatch('mqttBroker', 'addBroker', 'mutation', input),
    removeBroker: (input?: unknown) => dispatch('mqttBroker', 'removeBroker', 'mutation', input),
    testConnection: (input?: unknown) => dispatch('mqttBroker', 'testConnection', 'mutation', input),
    startEmbeddedBroker: (input?: unknown) => dispatch('mqttBroker', 'startEmbeddedBroker', 'mutation', input),
    stopEmbeddedBroker: (input?: unknown) => dispatch('mqttBroker', 'stopEmbeddedBroker', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('mqttBroker', 'getStatus', 'query', input),
  }

  const networkAccessInterface = {
    start: (input?: unknown) => dispatch('networkAccess', 'start', 'mutation', input),
    stop: (input?: unknown) => dispatch('networkAccess', 'stop', 'mutation', input),
    getEndpoint: (input?: unknown) => dispatch('networkAccess', 'getEndpoint', 'query', input),
    getStatus: (input?: unknown) => dispatch('networkAccess', 'getStatus', 'query', input),
    listEndpoints: (input?: unknown) => dispatch('networkAccess', 'listEndpoints', 'query', input),
  }

  const networkQualityInterface = {
    getAllStats: (input?: unknown) => dispatch('networkQuality', 'getAllStats', 'query', input),
  }

  const nodesInterface = {
    topology: (input?: unknown) => dispatch('nodes', 'topology', 'query', input),
    directory: (input?: unknown) => dispatch('nodes', 'directory', 'query', input),
    deployAddon: (input?: unknown) => dispatch('nodes', 'deployAddon', 'mutation', input),
    undeployAddon: (input?: unknown) => dispatch('nodes', 'undeployAddon', 'mutation', input),
    restartAddon: (input?: unknown) => dispatch('nodes', 'restartAddon', 'mutation', input),
    restartProcess: (input?: unknown) => dispatch('nodes', 'restartProcess', 'mutation', input),
    restartNode: (input?: unknown) => dispatch('nodes', 'restartNode', 'mutation', input),
    shutdownNode: (input?: unknown) => dispatch('nodes', 'shutdownNode', 'mutation', input),
    renameNode: (input?: unknown) => dispatch('nodes', 'renameNode', 'mutation', input),
    clusterAddonStatus: (input?: unknown) => dispatch('nodes', 'clusterAddonStatus', 'query', input),
    getCapUsageGraph: (input?: unknown) => dispatch('nodes', 'getCapUsageGraph', 'query', input),
    getNodeAddons: (input?: unknown) => dispatch('nodes', 'getNodeAddons', 'query', input),
    setProcessLogLevel: (input?: unknown) => dispatch('nodes', 'setProcessLogLevel', 'mutation', input),
    executeQuery: (input?: unknown) => dispatch('nodes', 'executeQuery', 'mutation', input),
  }

  const notificationOutputInterface = {
    listTargetKinds: (input?: unknown) => dispatch('notificationOutput', 'listTargetKinds', 'query', input),
    listTargets: (input?: unknown) => dispatch('notificationOutput', 'listTargets', 'query', input),
    getTarget: (input?: unknown) => dispatch('notificationOutput', 'getTarget', 'query', input),
    discoverTargets: (input?: unknown) => dispatch('notificationOutput', 'discoverTargets', 'query', input),
    probeTargetConfig: (input?: unknown) => dispatch('notificationOutput', 'probeTargetConfig', 'mutation', input),
    send: (input?: unknown) => dispatch('notificationOutput', 'send', 'mutation', input),
    testTarget: (input?: unknown) => dispatch('notificationOutput', 'testTarget', 'mutation', input),
    upsertTarget: (input?: unknown) => dispatch('notificationOutput', 'upsertTarget', 'mutation', input),
    deleteTarget: (input?: unknown) => dispatch('notificationOutput', 'deleteTarget', 'mutation', input),
    setTargetEnabled: (input?: unknown) => dispatch('notificationOutput', 'setTargetEnabled', 'mutation', input),
  }

  const notificationRulesInterface = {
    listRules: (input?: unknown) => dispatch('notificationRules', 'listRules', 'query', input),
    getRule: (input?: unknown) => dispatch('notificationRules', 'getRule', 'query', input),
    createRule: (input?: unknown) => dispatch('notificationRules', 'createRule', 'mutation', input),
    updateRule: (input?: unknown) => dispatch('notificationRules', 'updateRule', 'mutation', input),
    deleteRule: (input?: unknown) => dispatch('notificationRules', 'deleteRule', 'mutation', input),
    setRuleEnabled: (input?: unknown) => dispatch('notificationRules', 'setRuleEnabled', 'mutation', input),
    listSequences: (input?: unknown) => dispatch('notificationRules', 'listSequences', 'query', input),
    getSequence: (input?: unknown) => dispatch('notificationRules', 'getSequence', 'query', input),
    createSequence: (input?: unknown) => dispatch('notificationRules', 'createSequence', 'mutation', input),
    updateSequence: (input?: unknown) => dispatch('notificationRules', 'updateSequence', 'mutation', input),
    deleteSequence: (input?: unknown) => dispatch('notificationRules', 'deleteSequence', 'mutation', input),
    getClipRetentionAsks: (input?: unknown) => dispatch('notificationRules', 'getClipRetentionAsks', 'query', input),
    listDeviceMutes: (input?: unknown) => dispatch('notificationRules', 'listDeviceMutes', 'query', input),
    testRule: (input?: unknown) => dispatch('notificationRules', 'testRule', 'mutation', input),
    previewStateSummary: (input?: unknown) => dispatch('notificationRules', 'previewStateSummary', 'mutation', input),
    getConditionCatalog: (input?: unknown) => dispatch('notificationRules', 'getConditionCatalog', 'query', input),
    getTemplateCatalog: (input?: unknown) => dispatch('notificationRules', 'getTemplateCatalog', 'query', input),
    previewTemplate: (input?: unknown) => dispatch('notificationRules', 'previewTemplate', 'mutation', input),
    getHistory: (input?: unknown) => dispatch('notificationRules', 'getHistory', 'query', input),
    getRuleLastRuns: (input?: unknown) => dispatch('notificationRules', 'getRuleLastRuns', 'query', input),
    resolveArtifactUrl: (input?: unknown) => dispatch('notificationRules', 'resolveArtifactUrl', 'query', input),
    listSnoozes: (input?: unknown) => dispatch('notificationRules', 'listSnoozes', 'query', input),
    createSnooze: (input?: unknown) => dispatch('notificationRules', 'createSnooze', 'mutation', input),
    cancelSnooze: (input?: unknown) => dispatch('notificationRules', 'cancelSnooze', 'mutation', input),
    getAlarmConfig: (input?: unknown) => dispatch('notificationRules', 'getAlarmConfig', 'query', input),
    setAlarmConfig: (input?: unknown) => dispatch('notificationRules', 'setAlarmConfig', 'mutation', input),
    createAlarmProfile: (input?: unknown) => dispatch('notificationRules', 'createAlarmProfile', 'mutation', input),
    renameAlarmProfile: (input?: unknown) => dispatch('notificationRules', 'renameAlarmProfile', 'mutation', input),
    deleteAlarmProfile: (input?: unknown) => dispatch('notificationRules', 'deleteAlarmProfile', 'mutation', input),
    activateAlarmProfile: (input?: unknown) => dispatch('notificationRules', 'activateAlarmProfile', 'mutation', input),
    getAlarmSensors: (input?: unknown) => dispatch('notificationRules', 'getAlarmSensors', 'query', input),
  }

  const oidcConnectionsInterface = {
    connectionFormSchema: (input?: unknown) => dispatch('oidcConnections', 'connectionFormSchema', 'query', input),
    listConnections: (input?: unknown) => dispatch('oidcConnections', 'listConnections', 'query', input),
    createConnection: (input?: unknown) => dispatch('oidcConnections', 'createConnection', 'mutation', input),
    updateConnection: (input?: unknown) => dispatch('oidcConnections', 'updateConnection', 'mutation', input),
    deleteConnection: (input?: unknown) => dispatch('oidcConnections', 'deleteConnection', 'mutation', input),
  }

  const osdManagerInterface = {
    getConditionSupport: (input?: unknown) => dispatch('osdManager', 'getConditionSupport', 'query', input),
    copyDeviceConfiguration: (input?: unknown) => dispatch('osdManager', 'copyDeviceConfiguration', 'mutation', input),
    listTemplates: (input?: unknown) => dispatch('osdManager', 'listTemplates', 'query', input),
    upsertTemplate: (input?: unknown) => dispatch('osdManager', 'upsertTemplate', 'mutation', input),
    deleteTemplate: (input?: unknown) => dispatch('osdManager', 'deleteTemplate', 'mutation', input),
  }

  const pipelineExecutorInterface = {
    getAvailableEngines: (input?: unknown) => dispatch('pipelineExecutor', 'getAvailableEngines', 'query', input),
    getSelectedEngine: (input?: unknown) => dispatch('pipelineExecutor', 'getSelectedEngine', 'query', input),
    getEngineProvisioning: (input?: unknown) => dispatch('pipelineExecutor', 'getEngineProvisioning', 'query', input),
    getVideoPipelineSteps: (input?: unknown) => dispatch('pipelineExecutor', 'getVideoPipelineSteps', 'query', input),
    setVideoPipelineSteps: (input?: unknown) => dispatch('pipelineExecutor', 'setVideoPipelineSteps', 'mutation', input),
    getInferenceDeviceHealth: (input?: unknown) => dispatch('pipelineExecutor', 'getInferenceDeviceHealth', 'query', input),
    rearmInferenceDevice: (input?: unknown) => dispatch('pipelineExecutor', 'rearmInferenceDevice', 'mutation', input),
    getSchema: (input?: unknown) => dispatch('pipelineExecutor', 'getSchema', 'query', input),
    getOrchestratorConfigSchema: (input?: unknown) => dispatch('pipelineExecutor', 'getOrchestratorConfigSchema', 'query', input),
    validatePipeline: (input?: unknown) => dispatch('pipelineExecutor', 'validatePipeline', 'query', input),
    getCapabilities: (input?: unknown) => dispatch('pipelineExecutor', 'getCapabilities', 'query', input),
    getAddonModels: (input?: unknown) => dispatch('pipelineExecutor', 'getAddonModels', 'query', input),
    downloadModel: (input?: unknown) => dispatch('pipelineExecutor', 'downloadModel', 'mutation', input),
    deleteModel: (input?: unknown) => dispatch('pipelineExecutor', 'deleteModel', 'mutation', input),
    cacheFrameInPool: (input?: unknown) => dispatch('pipelineExecutor', 'cacheFrameInPool', 'mutation', input),
    inferCached: (input?: unknown) => dispatch('pipelineExecutor', 'inferCached', 'mutation', input),
    uncacheFrame: (input?: unknown) => dispatch('pipelineExecutor', 'uncacheFrame', 'mutation', input),
    getEffectiveTuning: (input?: unknown) => dispatch('pipelineExecutor', 'getEffectiveTuning', 'query', input),
    listLoadedEngines: (input?: unknown) => dispatch('pipelineExecutor', 'listLoadedEngines', 'query', input),
    spinEngine: (input?: unknown) => dispatch('pipelineExecutor', 'spinEngine', 'mutation', input),
    killEngine: (input?: unknown) => dispatch('pipelineExecutor', 'killEngine', 'mutation', input),
    listReferenceImages: (input?: unknown) => dispatch('pipelineExecutor', 'listReferenceImages', 'query', input),
    getReferenceImage: (input?: unknown) => dispatch('pipelineExecutor', 'getReferenceImage', 'query', input),
    getReferenceAudioFiles: (input?: unknown) => dispatch('pipelineExecutor', 'getReferenceAudioFiles', 'query', input),
    getReferenceAudio: (input?: unknown) => dispatch('pipelineExecutor', 'getReferenceAudio', 'query', input),
    getAudioCapabilities: (input?: unknown) => dispatch('pipelineExecutor', 'getAudioCapabilities', 'query', input),
    runAudioTest: (input?: unknown) => dispatch('pipelineExecutor', 'runAudioTest', 'mutation', input),
    getDetectionConfigSchema: (input?: unknown) => dispatch('pipelineExecutor', 'getDetectionConfigSchema', 'query', input),
  }

  const pipelineOrchestratorInterface = {
    requestOccupancyLook: (input?: unknown) => dispatch('pipelineOrchestrator', 'requestOccupancyLook', 'mutation', input),
    pauseForStorageMigration: (input?: unknown) => dispatch('pipelineOrchestrator', 'pauseForStorageMigration', 'mutation', input),
    resumeForStorageMigration: (input?: unknown) => dispatch('pipelineOrchestrator', 'resumeForStorageMigration', 'mutation', input),
    rebalance: (input?: unknown) => dispatch('pipelineOrchestrator', 'rebalance', 'mutation', input),
    getPipelineAssignments: (input?: unknown) => dispatch('pipelineOrchestrator', 'getPipelineAssignments', 'query', input),
    getAgentLoad: (input?: unknown) => dispatch('pipelineOrchestrator', 'getAgentLoad', 'query', input),
    getClusterModelChoice: (input?: unknown) => dispatch('pipelineOrchestrator', 'getClusterModelChoice', 'query', input),
    getGlobalMetrics: (input?: unknown) => dispatch('pipelineOrchestrator', 'getGlobalMetrics', 'query', input),
    getCapabilityBindings: (input?: unknown) => dispatch('pipelineOrchestrator', 'getCapabilityBindings', 'query', input),
    setCapabilityBinding: (input?: unknown) => dispatch('pipelineOrchestrator', 'setCapabilityBinding', 'mutation', input),
    getIngestOwner: (input?: unknown) => dispatch('pipelineOrchestrator', 'getIngestOwner', 'query', input),
    getAudioNodeLoad: (input?: unknown) => dispatch('pipelineOrchestrator', 'getAudioNodeLoad', 'query', input),
    getAudioAssignments: (input?: unknown) => dispatch('pipelineOrchestrator', 'getAudioAssignments', 'query', input),
    getAgentSettings: (input?: unknown) => dispatch('pipelineOrchestrator', 'getAgentSettings', 'query', input),
    listAgentSettings: (input?: unknown) => dispatch('pipelineOrchestrator', 'listAgentSettings', 'query', input),
    removeAgentSettings: (input?: unknown) => dispatch('pipelineOrchestrator', 'removeAgentSettings', 'mutation', input),
    setAgentMaxCameras: (input?: unknown) => dispatch('pipelineOrchestrator', 'setAgentMaxCameras', 'mutation', input),
    setAgentCapabilities: (input?: unknown) => dispatch('pipelineOrchestrator', 'setAgentCapabilities', 'mutation', input),
    setAgentDecodeLimits: (input?: unknown) => dispatch('pipelineOrchestrator', 'setAgentDecodeLimits', 'mutation', input),
    setAgentReachableHost: (input?: unknown) => dispatch('pipelineOrchestrator', 'setAgentReachableHost', 'mutation', input),
    setAgentInferenceDevices: (input?: unknown) => dispatch('pipelineOrchestrator', 'setAgentInferenceDevices', 'mutation', input),
    setNodeStepSettings: (input?: unknown) => dispatch('pipelineOrchestrator', 'setNodeStepSettings', 'mutation', input),
    getNodeInferenceDevices: (input?: unknown) => dispatch('pipelineOrchestrator', 'getNodeInferenceDevices', 'query', input),
    forgetInferenceDevice: (input?: unknown) => dispatch('pipelineOrchestrator', 'forgetInferenceDevice', 'mutation', input),
    resetNodePipelineDefaults: (input?: unknown) => dispatch('pipelineOrchestrator', 'resetNodePipelineDefaults', 'mutation', input),
    planAutoTune: (input?: unknown) => dispatch('pipelineOrchestrator', 'planAutoTune', 'query', input),
    applyAutoTune: (input?: unknown) => dispatch('pipelineOrchestrator', 'applyAutoTune', 'mutation', input),
    setLoadBalancingShares: (input?: unknown) => dispatch('pipelineOrchestrator', 'setLoadBalancingShares', 'mutation', input),
    getPlacementStats: (input?: unknown) => dispatch('pipelineOrchestrator', 'getPlacementStats', 'query', input),
    suggestShares: (input?: unknown) => dispatch('pipelineOrchestrator', 'suggestShares', 'query', input),
    getEffectiveShares: (input?: unknown) => dispatch('pipelineOrchestrator', 'getEffectiveShares', 'query', input),
    setShareSource: (input?: unknown) => dispatch('pipelineOrchestrator', 'setShareSource', 'mutation', input),
    getNodeBenchmarkPreflight: (input?: unknown) => dispatch('pipelineOrchestrator', 'getNodeBenchmarkPreflight', 'query', input),
    startNodeBenchmark: (input?: unknown) => dispatch('pipelineOrchestrator', 'startNodeBenchmark', 'mutation', input),
    getNodeBenchmarkStatus: (input?: unknown) => dispatch('pipelineOrchestrator', 'getNodeBenchmarkStatus', 'query', input),
    abortNodeBenchmark: (input?: unknown) => dispatch('pipelineOrchestrator', 'abortNodeBenchmark', 'mutation', input),
    getNodeBenchmarkCandidates: (input?: unknown) => dispatch('pipelineOrchestrator', 'getNodeBenchmarkCandidates', 'query', input),
    listNodeBenchmarkResults: (input?: unknown) => dispatch('pipelineOrchestrator', 'listNodeBenchmarkResults', 'query', input),
    deleteNodeBenchmarkResult: (input?: unknown) => dispatch('pipelineOrchestrator', 'deleteNodeBenchmarkResult', 'mutation', input),
    getCameraStatuses: (input?: unknown) => dispatch('pipelineOrchestrator', 'getCameraStatuses', 'query', input),
    setCameraSensors: (input?: unknown) => dispatch('pipelineOrchestrator', 'setCameraSensors', 'mutation', input),
    reconcileFromDisk: (input?: unknown) => dispatch('pipelineOrchestrator', 'reconcileFromDisk', 'mutation', input),
    getReconcileFromDiskStatus: (input?: unknown) => dispatch('pipelineOrchestrator', 'getReconcileFromDiskStatus', 'query', input),
  }

  const pipelineRunnerInterface = {
    attachCamera: (input?: unknown) => dispatch('pipelineRunner', 'attachCamera', 'mutation', input),
    reportMotion: (input?: unknown) => dispatch('pipelineRunner', 'reportMotion', 'mutation', input),
    getLocalLoad: (input?: unknown) => dispatch('pipelineRunner', 'getLocalLoad', 'query', input),
    getLocalMetrics: (input?: unknown) => dispatch('pipelineRunner', 'getLocalMetrics', 'query', input),
    getAllCameraMetrics: (input?: unknown) => dispatch('pipelineRunner', 'getAllCameraMetrics', 'query', input),
    getLocalCameras: (input?: unknown) => dispatch('pipelineRunner', 'getLocalCameras', 'query', input),
    getNativeCrop: (input?: unknown) => dispatch('pipelineRunner', 'getNativeCrop', 'query', input),
    runStatelessStep: (input?: unknown) => dispatch('pipelineRunner', 'runStatelessStep', 'mutation', input),
    startNodeBench: (input?: unknown) => dispatch('pipelineRunner', 'startNodeBench', 'mutation', input),
    getNodeBenchStatus: (input?: unknown) => dispatch('pipelineRunner', 'getNodeBenchStatus', 'query', input),
    abortNodeBench: (input?: unknown) => dispatch('pipelineRunner', 'abortNodeBench', 'mutation', input),
  }

  const plateGalleryInterface = {
    getPlateMedia: (input?: unknown) => dispatch('plateGallery', 'getPlateMedia', 'query', input),
    searchPlates: (input?: unknown) => dispatch('plateGallery', 'searchPlates', 'query', input),
    suggestPlateClusters: (input?: unknown) => dispatch('plateGallery', 'suggestPlateClusters', 'query', input),
    correctPlateText: (input?: unknown) => dispatch('plateGallery', 'correctPlateText', 'mutation', input),
    deletePlate: (input?: unknown) => dispatch('plateGallery', 'deletePlate', 'mutation', input),
    listVehicles: (input?: unknown) => dispatch('plateGallery', 'listVehicles', 'query', input),
    createVehicle: (input?: unknown) => dispatch('plateGallery', 'createVehicle', 'mutation', input),
    renameVehicle: (input?: unknown) => dispatch('plateGallery', 'renameVehicle', 'mutation', input),
    deleteVehicle: (input?: unknown) => dispatch('plateGallery', 'deleteVehicle', 'mutation', input),
    listVehicleSamples: (input?: unknown) => dispatch('plateGallery', 'listVehicleSamples', 'query', input),
    removeVehicleSample: (input?: unknown) => dispatch('plateGallery', 'removeVehicleSample', 'mutation', input),
    assignPlate: (input?: unknown) => dispatch('plateGallery', 'assignPlate', 'mutation', input),
    unassignPlate: (input?: unknown) => dispatch('plateGallery', 'unassignPlate', 'mutation', input),
    assignPlates: (input?: unknown) => dispatch('plateGallery', 'assignPlates', 'mutation', input),
    unassignPlates: (input?: unknown) => dispatch('plateGallery', 'unassignPlates', 'mutation', input),
  }

  const recordEntriesInterface = {
    listEntryKinds: (input?: unknown) => dispatch('recordEntries', 'listEntryKinds', 'query', input),
    listEntries: (input?: unknown) => dispatch('recordEntries', 'listEntries', 'query', input),
    putEntry: (input?: unknown) => dispatch('recordEntries', 'putEntry', 'mutation', input),
    deleteEntry: (input?: unknown) => dispatch('recordEntries', 'deleteEntry', 'mutation', input),
  }

  const recordingArchiveInterface = {
    getAvailabilityBatch: (input?: unknown) => dispatch('recordingArchive', 'getAvailabilityBatch', 'query', input),
    getDaysWithRecordingsBatch: (input?: unknown) => dispatch('recordingArchive', 'getDaysWithRecordingsBatch', 'query', input),
    getStorageUsage: (input?: unknown) => dispatch('recordingArchive', 'getStorageUsage', 'query', input),
    listOpsLog: (input?: unknown) => dispatch('recordingArchive', 'listOpsLog', 'query', input),
    pauseForStorageMigration: (input?: unknown) => dispatch('recordingArchive', 'pauseForStorageMigration', 'mutation', input),
    resumeForStorageMigration: (input?: unknown) => dispatch('recordingArchive', 'resumeForStorageMigration', 'mutation', input),
    refreshStorageLocationsForMigration: (input?: unknown) => dispatch('recordingArchive', 'refreshStorageLocationsForMigration', 'mutation', input),
    startStorageMigrationMove: (input?: unknown) => dispatch('recordingArchive', 'startStorageMigrationMove', 'mutation', input),
    getStorageMigrationMoveStatus: (input?: unknown) => dispatch('recordingArchive', 'getStorageMigrationMoveStatus', 'query', input),
    cancelStorageMigrationMove: (input?: unknown) => dispatch('recordingArchive', 'cancelStorageMigrationMove', 'mutation', input),
    relocateFootage: (input?: unknown) => dispatch('recordingArchive', 'relocateFootage', 'mutation', input),
    listRelocateJobs: (input?: unknown) => dispatch('recordingArchive', 'listRelocateJobs', 'query', input),
    getRelocateResidue: (input?: unknown) => dispatch('recordingArchive', 'getRelocateResidue', 'query', input),
    reconcileLedgerAgainstDisk: (input?: unknown) => dispatch('recordingArchive', 'reconcileLedgerAgainstDisk', 'mutation', input),
    cancelRelocateJob: (input?: unknown) => dispatch('recordingArchive', 'cancelRelocateJob', 'mutation', input),
    planStorageRebalance: (input?: unknown) => dispatch('recordingArchive', 'planStorageRebalance', 'query', input),
    startStorageRebalance: (input?: unknown) => dispatch('recordingArchive', 'startStorageRebalance', 'mutation', input),
    getPlacement: (input?: unknown) => dispatch('recordingArchive', 'getPlacement', 'query', input),
    setDevicePlacement: (input?: unknown) => dispatch('recordingArchive', 'setDevicePlacement', 'mutation', input),
  }

  const recordingExportInterface = {
    createExport: (input?: unknown) => dispatch('recordingExport', 'createExport', 'mutation', input),
    getExport: (input?: unknown) => dispatch('recordingExport', 'getExport', 'query', input),
    cancelExport: (input?: unknown) => dispatch('recordingExport', 'cancelExport', 'mutation', input),
    deleteExport: (input?: unknown) => dispatch('recordingExport', 'deleteExport', 'mutation', input),
    getDownloadUrl: (input?: unknown) => dispatch('recordingExport', 'getDownloadUrl', 'query', input),
    readExportBytes: (input?: unknown) => dispatch('recordingExport', 'readExportBytes', 'query', input),
  }

  const serverManagementInterface = {
    getServerPackageStatus: (input?: unknown) => dispatch('serverManagement', 'getServerPackageStatus', 'query', input),
    checkServerUpdate: (input?: unknown) => dispatch('serverManagement', 'checkServerUpdate', 'mutation', input),
    applyServerUpdate: (input?: unknown) => dispatch('serverManagement', 'applyServerUpdate', 'mutation', input),
    rollbackServerUpdate: (input?: unknown) => dispatch('serverManagement', 'rollbackServerUpdate', 'mutation', input),
    restartServer: (input?: unknown) => dispatch('serverManagement', 'restartServer', 'mutation', input),
  }

  const settingsStoreInterface = {
    get: (input?: unknown) => dispatch('settingsStore', 'get', 'query', input),
    set: (input?: unknown) => dispatch('settingsStore', 'set', 'mutation', input),
    query: (input?: unknown) => dispatch('settingsStore', 'query', 'query', input),
    upsert: (input?: unknown) => dispatch('settingsStore', 'upsert', 'mutation', input),
    upsertMany: (input?: unknown) => dispatch('settingsStore', 'upsertMany', 'mutation', input),
    insert: (input?: unknown) => dispatch('settingsStore', 'insert', 'mutation', input),
    insertMany: (input?: unknown) => dispatch('settingsStore', 'insertMany', 'mutation', input),
    transact: (input?: unknown) => dispatch('settingsStore', 'transact', 'mutation', input),
    update: (input?: unknown) => dispatch('settingsStore', 'update', 'mutation', input),
    delete: (input?: unknown) => dispatch('settingsStore', 'delete', 'mutation', input),
    deleteWhere: (input?: unknown) => dispatch('settingsStore', 'deleteWhere', 'mutation', input),
    updateWhere: (input?: unknown) => dispatch('settingsStore', 'updateWhere', 'mutation', input),
    count: (input?: unknown) => dispatch('settingsStore', 'count', 'query', input),
    aggregate: (input?: unknown) => dispatch('settingsStore', 'aggregate', 'query', input),
    histogram: (input?: unknown) => dispatch('settingsStore', 'histogram', 'query', input),
    isEmpty: (input?: unknown) => dispatch('settingsStore', 'isEmpty', 'query', input),
    declareCollection: (input?: unknown) => dispatch('settingsStore', 'declareCollection', 'mutation', input),
  }

  const storageInterface = {
    resolve: (input?: unknown) => dispatch('storage', 'resolve', 'query', input),
    write: (input?: unknown) => dispatch('storage', 'write', 'mutation', input),
    read: (input?: unknown) => dispatch('storage', 'read', 'query', input),
    exists: (input?: unknown) => dispatch('storage', 'exists', 'query', input),
    list: (input?: unknown) => dispatch('storage', 'list', 'query', input),
    delete: (input?: unknown) => dispatch('storage', 'delete', 'mutation', input),
    getAvailableSpace: (input?: unknown) => dispatch('storage', 'getAvailableSpace', 'query', input),
    beginUpload: (input?: unknown) => dispatch('storage', 'beginUpload', 'mutation', input),
    writeChunk: (input?: unknown) => dispatch('storage', 'writeChunk', 'mutation', input),
    finalizeUpload: (input?: unknown) => dispatch('storage', 'finalizeUpload', 'mutation', input),
    abortUpload: (input?: unknown) => dispatch('storage', 'abortUpload', 'mutation', input),
    beginDownload: (input?: unknown) => dispatch('storage', 'beginDownload', 'mutation', input),
    readChunk: (input?: unknown) => dispatch('storage', 'readChunk', 'query', input),
    endDownload: (input?: unknown) => dispatch('storage', 'endDownload', 'mutation', input),
    listLocations: (input?: unknown) => dispatch('storage', 'listLocations', 'query', input),
    listLocationDeclarations: (input?: unknown) => dispatch('storage', 'listLocationDeclarations', 'query', input),
    upsertLocation: (input?: unknown) => dispatch('storage', 'upsertLocation', 'mutation', input),
    deleteLocation: (input?: unknown) => dispatch('storage', 'deleteLocation', 'mutation', input),
    listDrainProgress: (input?: unknown) => dispatch('storage', 'listDrainProgress', 'query', input),
    testLocation: (input?: unknown) => dispatch('storage', 'testLocation', 'query', input),
    listProviders: (input?: unknown) => dispatch('storage', 'listProviders', 'query', input),
    testConfig: (input?: unknown) => dispatch('storage', 'testConfig', 'query', input),
  }

  const storageMigrationInterface = {
    plan: (input?: unknown) => dispatch('storageMigration', 'plan', 'query', input),
    start: (input?: unknown) => dispatch('storageMigration', 'start', 'mutation', input),
    status: (input?: unknown) => dispatch('storageMigration', 'status', 'query', input),
    cancel: (input?: unknown) => dispatch('storageMigration', 'cancel', 'mutation', input),
    movers: (input?: unknown) => dispatch('storageMigration', 'movers', 'query', input),
    moverClearance: (input?: unknown) => dispatch('storageMigration', 'moverClearance', 'query', input),
    residue: (input?: unknown) => dispatch('storageMigration', 'residue', 'query', input),
    drain: (input?: unknown) => dispatch('storageMigration', 'drain', 'mutation', input),
    cleanupStart: (input?: unknown) => dispatch('storageMigration', 'cleanupStart', 'mutation', input),
    cleanupStatus: (input?: unknown) => dispatch('storageMigration', 'cleanupStatus', 'query', input),
    cleanupCancel: (input?: unknown) => dispatch('storageMigration', 'cleanupCancel', 'mutation', input),
    history: (input?: unknown) => dispatch('storageMigration', 'history', 'query', input),
  }

  const streamBrokerInterface = {
    fetchEventMedia: (input?: unknown) => dispatch('streamBroker', 'fetchEventMedia', 'mutation', input),
    listAllCameraStreams: (input?: unknown) => dispatch('streamBroker', 'listAllCameraStreams', 'query', input),
    listAllProfileSlots: (input?: unknown) => dispatch('streamBroker', 'listAllProfileSlots', 'query', input),
    getBrokerStats: (input?: unknown) => dispatch('streamBroker', 'getBrokerStats', 'query', input),
    probeStream: (input?: unknown) => dispatch('streamBroker', 'probeStream', 'mutation', input),
    listClients: (input?: unknown) => dispatch('streamBroker', 'listClients', 'query', input),
    getLiveViewerCounts: (input?: unknown) => dispatch('streamBroker', 'getLiveViewerCounts', 'query', input),
    killClient: (input?: unknown) => dispatch('streamBroker', 'killClient', 'mutation', input),
    getStreamUrl: (input?: unknown) => dispatch('streamBroker', 'getStreamUrl', 'query', input),
    getStreamWithCodec: (input?: unknown) => dispatch('streamBroker', 'getStreamWithCodec', 'mutation', input),
    releaseStreamWithCodec: (input?: unknown) => dispatch('streamBroker', 'releaseStreamWithCodec', 'mutation', input),
    acquireEgressTranscode: (input?: unknown) => dispatch('streamBroker', 'acquireEgressTranscode', 'mutation', input),
    releaseEgressTranscode: (input?: unknown) => dispatch('streamBroker', 'releaseEgressTranscode', 'mutation', input),
    subscribeAudioChunks: (input?: unknown) => dispatch('streamBroker', 'subscribeAudioChunks', 'mutation', input),
    pullAudioChunks: (input?: unknown) => dispatch('streamBroker', 'pullAudioChunks', 'query', input),
    unsubscribeAudioChunks: (input?: unknown) => dispatch('streamBroker', 'unsubscribeAudioChunks', 'mutation', input),
    setPreBufferDuration: (input?: unknown) => dispatch('streamBroker', 'setPreBufferDuration', 'mutation', input),
    getPreBufferInfo: (input?: unknown) => dispatch('streamBroker', 'getPreBufferInfo', 'query', input),
    getRtspPort: (input?: unknown) => dispatch('streamBroker', 'getRtspPort', 'query', input),
    getAllRtspEntries: (input?: unknown) => dispatch('streamBroker', 'getAllRtspEntries', 'query', input),
    getRtspEntry: (input?: unknown) => dispatch('streamBroker', 'getRtspEntry', 'query', input),
    regenerateRtspToken: (input?: unknown) => dispatch('streamBroker', 'regenerateRtspToken', 'mutation', input),
    setRtspEnabled: (input?: unknown) => dispatch('streamBroker', 'setRtspEnabled', 'mutation', input),
    isRtspEnabled: (input?: unknown) => dispatch('streamBroker', 'isRtspEnabled', 'query', input),
  }

  const systemInterface = {
    info: (input?: unknown) => dispatch('system', 'info', 'query', input),
    health: (input?: unknown) => dispatch('system', 'health', 'query', input),
    featureFlags: (input?: unknown) => dispatch('system', 'featureFlags', 'query', input),
    networkAddresses: (input?: unknown) => dispatch('system', 'networkAddresses', 'query', input),
    getRetentionConfig: (input?: unknown) => dispatch('system', 'getRetentionConfig', 'query', input),
    setRetentionConfig: (input?: unknown) => dispatch('system', 'setRetentionConfig', 'mutation', input),
    forceRetentionCleanup: (input?: unknown) => dispatch('system', 'forceRetentionCleanup', 'mutation', input),
    getSiteLocation: (input?: unknown) => dispatch('system', 'getSiteLocation', 'query', input),
    setSiteLocation: (input?: unknown) => dispatch('system', 'setSiteLocation', 'mutation', input),
    detectSiteLocation: (input?: unknown) => dispatch('system', 'detectSiteLocation', 'mutation', input),
    getRequestCensus: (input?: unknown) => dispatch('system', 'getRequestCensus', 'query', input),
    getLoadContributions: (input?: unknown) => dispatch('system', 'getLoadContributions', 'query', input),
    getFailureContributions: (input?: unknown) => dispatch('system', 'getFailureContributions', 'query', input),
    getLoggingSettings: (input?: unknown) => dispatch('system', 'getLoggingSettings', 'query', input),
    setLoggingSettings: (input?: unknown) => dispatch('system', 'setLoggingSettings', 'mutation', input),
  }

  const terminalSessionInterface = {
    listProfiles: (input?: unknown) => dispatch('terminalSession', 'listProfiles', 'query', input),
    listInstances: (input?: unknown) => dispatch('terminalSession', 'listInstances', 'query', input),
    createInstance: (input?: unknown) => dispatch('terminalSession', 'createInstance', 'mutation', input),
    updateInstance: (input?: unknown) => dispatch('terminalSession', 'updateInstance', 'mutation', input),
    deleteInstance: (input?: unknown) => dispatch('terminalSession', 'deleteInstance', 'mutation', input),
    setInstanceEnabled: (input?: unknown) => dispatch('terminalSession', 'setInstanceEnabled', 'mutation', input),
    listLegacyCameras: (input?: unknown) => dispatch('terminalSession', 'listLegacyCameras', 'query', input),
    adoptLegacyMonitor: (input?: unknown) => dispatch('terminalSession', 'adoptLegacyMonitor', 'mutation', input),
    listSessions: (input?: unknown) => dispatch('terminalSession', 'listSessions', 'query', input),
    openSession: (input?: unknown) => dispatch('terminalSession', 'openSession', 'mutation', input),
    resize: (input?: unknown) => dispatch('terminalSession', 'resize', 'mutation', input),
    pullOutput: (input?: unknown) => dispatch('terminalSession', 'pullOutput', 'mutation', input),
    writeInput: (input?: unknown) => dispatch('terminalSession', 'writeInput', 'mutation', input),
    close: (input?: unknown) => dispatch('terminalSession', 'close', 'mutation', input),
  }

  const toastInterface = {
    onToast: (input?: unknown, push?: unknown) => dispatch('toast', 'onToast', 'subscription', input, push),
  }

  const trainingInterface = {
    listBaseModels: (input?: unknown) => dispatch('training', 'listBaseModels', 'query', input),
    planJob: (input?: unknown) => dispatch('training', 'planJob', 'query', input),
    startJob: (input?: unknown) => dispatch('training', 'startJob', 'mutation', input),
    startJobBatch: (input?: unknown) => dispatch('training', 'startJobBatch', 'mutation', input),
    listJobs: (input?: unknown) => dispatch('training', 'listJobs', 'query', input),
    getJob: (input?: unknown) => dispatch('training', 'getJob', 'query', input),
    cancelJob: (input?: unknown) => dispatch('training', 'cancelJob', 'mutation', input),
    getJobResult: (input?: unknown) => dispatch('training', 'getJobResult', 'query', input),
    listCanaryTargets: (input?: unknown) => dispatch('training', 'listCanaryTargets', 'query', input),
    registerResult: (input?: unknown) => dispatch('training', 'registerResult', 'mutation', input),
    canaryResult: (input?: unknown) => dispatch('training', 'canaryResult', 'mutation', input),
    rollbackCanary: (input?: unknown) => dispatch('training', 'rollbackCanary', 'mutation', input),
    discardResult: (input?: unknown) => dispatch('training', 'discardResult', 'mutation', input),
  }

  const turnProviderInterface = {
    getTurnServers: (input?: unknown) => dispatch('turnProvider', 'getTurnServers', 'query', input),
  }

  const userManagementInterface = {
    listUsers: (input?: unknown) => dispatch('userManagement', 'listUsers', 'query', input),
    createUser: (input?: unknown) => dispatch('userManagement', 'createUser', 'mutation', input),
    updateUser: (input?: unknown) => dispatch('userManagement', 'updateUser', 'mutation', input),
    deleteUser: (input?: unknown) => dispatch('userManagement', 'deleteUser', 'mutation', input),
    resetPassword: (input?: unknown) => dispatch('userManagement', 'resetPassword', 'mutation', input),
    setUserScopes: (input?: unknown) => dispatch('userManagement', 'setUserScopes', 'mutation', input),
    validateCredentials: (input?: unknown) => dispatch('userManagement', 'validateCredentials', 'mutation', input),
    setupTotp: (input?: unknown) => dispatch('userManagement', 'setupTotp', 'mutation', input),
    confirmTotp: (input?: unknown) => dispatch('userManagement', 'confirmTotp', 'mutation', input),
    disableTotp: (input?: unknown) => dispatch('userManagement', 'disableTotp', 'mutation', input),
    getTotpStatus: (input?: unknown) => dispatch('userManagement', 'getTotpStatus', 'query', input),
    migrateRawSecrets: (input?: unknown) => dispatch('userManagement', 'migrateRawSecrets', 'mutation', input),
    verifyTotp: (input?: unknown) => dispatch('userManagement', 'verifyTotp', 'mutation', input),
    oauthIssueCode: (input?: unknown) => dispatch('userManagement', 'oauthIssueCode', 'mutation', input),
    oauthExchangeCode: (input?: unknown) => dispatch('userManagement', 'oauthExchangeCode', 'mutation', input),
    oauthRefresh: (input?: unknown) => dispatch('userManagement', 'oauthRefresh', 'mutation', input),
    oauthVerifyAccessToken: (input?: unknown) => dispatch('userManagement', 'oauthVerifyAccessToken', 'query', input),
    listExternalIdentities: (input?: unknown) => dispatch('userManagement', 'listExternalIdentities', 'query', input),
    findUserByExternalIdentity: (input?: unknown) => dispatch('userManagement', 'findUserByExternalIdentity', 'query', input),
    unlinkExternalIdentity: (input?: unknown) => dispatch('userManagement', 'unlinkExternalIdentity', 'mutation', input),
    listOauthSessions: (input?: unknown) => dispatch('userManagement', 'listOauthSessions', 'query', input),
    revokeOauthSession: (input?: unknown) => dispatch('userManagement', 'revokeOauthSession', 'mutation', input),
  }

  return {
    actions: actionsInterface,
    actionSource: actionSourceInterface,
    addonPages: addonPagesInterface,
    addons: addonsInterface,
    addonSettings: addonSettingsInterface,
    addonWidgets: addonWidgetsInterface,
    alerts: alertsInterface,
    audioAnalyzer: audioAnalyzerInterface,
    audioCodec: audioCodecInterface,
    backup: backupInterface,
    broker: brokerInterface,
    calendars: calendarsInterface,
    connectionTest: connectionTestInterface,
    coreBlocks: coreBlocksInterface,
    decoder: decoderInterface,
    deviceAdoption: deviceAdoptionInterface,
    deviceCredentials: deviceCredentialsInterface,
    deviceExport: deviceExportInterface,
    deviceHistory: deviceHistoryInterface,
    deviceManager: deviceManagerInterface,
    deviceProvider: deviceProviderInterface,
    deviceState: deviceStateInterface,
    displayPalette: displayPaletteInterface,
    faceGallery: faceGalleryInterface,
    integrations: integrationsInterface,
    keychainAdmin: keychainAdminInterface,
    llm: llmInterface,
    localNetwork: localNetworkInterface,
    meshNetwork: meshNetworkInterface,
    metricsProvider: metricsProviderInterface,
    mqttBroker: mqttBrokerInterface,
    networkAccess: networkAccessInterface,
    networkQuality: networkQualityInterface,
    nodes: nodesInterface,
    notificationOutput: notificationOutputInterface,
    notificationRules: notificationRulesInterface,
    oidcConnections: oidcConnectionsInterface,
    osdManager: osdManagerInterface,
    pipelineExecutor: pipelineExecutorInterface,
    pipelineOrchestrator: pipelineOrchestratorInterface,
    pipelineRunner: pipelineRunnerInterface,
    plateGallery: plateGalleryInterface,
    recordEntries: recordEntriesInterface,
    recordingArchive: recordingArchiveInterface,
    recordingExport: recordingExportInterface,
    serverManagement: serverManagementInterface,
    settingsStore: settingsStoreInterface,
    storage: storageInterface,
    storageMigration: storageMigrationInterface,
    streamBroker: streamBrokerInterface,
    system: systemInterface,
    terminalSession: terminalSessionInterface,
    toast: toastInterface,
    training: trainingInterface,
    turnProvider: turnProviderInterface,
    userManagement: userManagementInterface,
  }
}
