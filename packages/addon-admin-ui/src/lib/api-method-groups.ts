/**
 * The API explorer's macro groups (planning#595): the one place that says which
 * operator-recognisable area a tRPC router belongs to.
 *
 * A method's router is the capability's camelCase name (or a core router's), so
 * the router alone decides the group. A router nobody listed lands in `other`:
 * the bucket is always rendered when it has methods, so a new router is visible
 * (and a one-line addition here) instead of silently absent.
 */

export const API_GROUP_IDS = [
  'devices',
  'camerasMedia',
  'pipeline',
  'recordings',
  'notifications',
  'integrations',
  'system',
  'other',
] as const

export type ApiGroupId = (typeof API_GROUP_IDS)[number]

type MappedGroupId = Exclude<ApiGroupId, 'other'>

const ROUTERS_BY_GROUP: Readonly<Record<MappedGroupId, readonly string[]>> = {
  devices: [
    'accessories',
    'airQualitySensor',
    'alarmPanel',
    'ambientLightSensor',
    'battery',
    'binary',
    'brightness',
    'button',
    'carbonMonoxide',
    'climateControl',
    'color',
    'connectivity',
    'consumables',
    'contact',
    'control',
    'cover',
    'deviceAdminLink',
    'deviceAdoption',
    'deviceCredentials',
    'deviceExport',
    'deviceExtension',
    'deviceHistory',
    'deviceManager',
    'deviceOps',
    'deviceProvider',
    'deviceRemovalHook',
    'deviceRuns',
    'deviceState',
    'deviceStateRefresh',
    'deviceStatus',
    'deviceTransitions',
    'dishwasher',
    'displayPalette',
    'doorbell',
    'energySystem',
    'enumSensor',
    'fanControl',
    'fanPresets',
    'flood',
    'gas',
    'groupActive',
    'groupCommands',
    'groupStatus',
    'heatingValve',
    'heatPumpControl',
    'heatPumpStatus',
    'heroLayout',
    'humidifier',
    'humiditySensor',
    'irTransmitter',
    'lawnMowerControl',
    'location',
    'lockControl',
    'lowPowerSleep',
    'mediaPlayer',
    'meter',
    'motion',
    'numericSensor',
    'petFeeder',
    'petFountain',
    'powerMeter',
    'powerSource',
    'presence',
    'pressureSensor',
    'pumpCycle',
    'reboot',
    'remote',
    'remoteLayoutComponents',
    'runningState',
    'siren',
    'smoke',
    'switch',
    'tags',
    'tamper',
    'temperatureSensor',
    'timedRun',
    'template',
    'vacuumControl',
    'valve',
    'vehicle',
    'vibration',
    'waterHeater',
    'weather',
    'weatherStation',
  ],
  camerasMedia: [
    'audioAnalysis',
    'audioAnalyzer',
    'audioCodec',
    'audioMetrics',
    'cameraCredentials',
    'cameraGridLayout',
    'cameraStreams',
    'dayNight',
    'decoder',
    'faceGallery',
    'image',
    'imageSettings',
    'intercom',
    'navigation',
    'osd',
    'osdManager',
    'plateGallery',
    'privacyMask',
    'ptz',
    'ptzAutotrack',
    'snapshot',
    'streamBroker',
    'streamCatalog',
    'streamParams',
    'streamSignals',
    'streamProbe',
    'videoclips',
    'webrtcSession',
  ],
  pipeline: [
    'cameraPipelineConfig',
    'composer',
    'coreBlocks',
    'customModelRegistry',
    'detectionPipeline',
    'embeddingEncoder',
    'llm',
    'llmRuntime',
    'modelConvert',
    'modelDistributor',
    'motionDetection',
    'motionTrigger',
    'motionZones',
    'nativeObjectDetection',
    'pipelineAnalytics',
    'pipelineExecutor',
    'pipelineOrchestrator',
    'pipelineRunner',
    'sceneMonitor',
    'training',
    'trainingProvider',
    'vectorStore',
    'workload',
    'zoneAnalytics',
    'zoneRules',
    'zones',
  ],
  recordings: [
    'backup',
    'dataStoreProvider',
    'databaseSnapshot',
    'filesystemBrowse',
    'recordEntries',
    'recording',
    'recordingArchive',
    'recordingExport',
    'recordingOnboard',
    'recordingSignal',
    'records',
    'retentionSource',
    'storage',
    'storageAdmin',
    'storageEvictable',
    'storageMigration',
    'storageOccupancy',
    'storageProvider',
  ],
  notifications: [
    'actions',
    'actionSource',
    'alerts',
    'automationControl',
    'calendars',
    'calendarSource',
    'doNotDisturb',
    'notificationOutput',
    'notificationRules',
    'notifications',
    'notifier',
    'schedulers',
    'scriptRunner',
    'smtpProvider',
    'toast',
  ],
  integrations: [
    'addonPages',
    'addonPagesSource',
    'addonRoutes',
    'addons',
    'addonSettings',
    'addonWidgets',
    'addonWidgetsSource',
    'adminUi',
    'boardKeySource',
    'broker',
    'integrationInstances',
    'integrations',
    'mqttBroker',
    'oauthIntegration',
    'viewerUi',
  ],
  system: [
    'agentPairing',
    'agents',
    'apiCatalog',
    'auth',
    'authProvider',
    'capabilities',
    'certificates',
    'clusterNodes',
    'clusterUpdate',
    'credentialTokens',
    'error',
    'eventBus',
    'eventEmitter',
    'failureContribution',
    'featureProbe',
    'hwaccel',
    'keychain',
    'keychainAdmin',
    'liveEvents',
    'loadContribution',
    'localNetwork',
    'logChannels',
    'logDestination',
    'logger',
    'loginMethod',
    'logs',
    'meshNetwork',
    'metricsProvider',
    'migrations',
    'networkAccess',
    'networkLink',
    'networkQuality',
    'nodeCertificates',
    'nodeRemovalHook',
    'nodes',
    'platformProbe',
    'preferences',
    'repl',
    'resync',
    'serverManagement',
    'settingsStore',
    'ssoBridge',
    'system',
    'systemEvents',
    'terminalSession',
    'turnProvider',
    'update',
    'userManagement',
    'userPasskeys',
  ],
}

const MAPPED_GROUP_IDS: readonly MappedGroupId[] = API_GROUP_IDS.filter(
  (id): id is MappedGroupId => id !== 'other',
)

const GROUP_BY_ROUTER: ReadonlyMap<string, MappedGroupId> = new Map(
  MAPPED_GROUP_IDS.flatMap((group) =>
    ROUTERS_BY_GROUP[group].map((router): [string, MappedGroupId] => [router, group]),
  ),
)

/** The macro group of a tRPC router name (`deviceManager`); an unlisted router is `other`. */
export function groupOfRouter(router: string): ApiGroupId {
  return GROUP_BY_ROUTER.get(router) ?? 'other'
}

export interface ApiMethodGroup<T> {
  readonly id: ApiGroupId
  readonly methods: readonly T[]
}

/**
 * `methods` split into the macro groups, in the fixed group order. A group with
 * no method is left out — `other` included, but only because it is empty: every
 * input method lands in exactly one group.
 */
export function groupMethods<T extends { readonly router: string }>(
  methods: readonly T[],
): readonly ApiMethodGroup<T>[] {
  const buckets = new Map<ApiGroupId, T[]>()
  for (const method of methods) {
    const id = groupOfRouter(method.router)
    const bucket = buckets.get(id)
    if (bucket === undefined) buckets.set(id, [method])
    else bucket.push(method)
  }
  return API_GROUP_IDS.flatMap((id) => {
    const bucket = buckets.get(id)
    return bucket === undefined ? [] : [{ id, methods: bucket }]
  })
}

/** The routers `other` holds — what to add to the map above when the bucket grows. */
export function unmappedRouters(routers: readonly string[]): readonly string[] {
  return [...new Set(routers.filter((r) => groupOfRouter(r) === 'other'))].toSorted()
}
