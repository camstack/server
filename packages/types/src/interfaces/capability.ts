import type { IAuthProvider } from '../capabilities/auth-provider.cap.js'
import type { ILoginMethodProvider } from '../capabilities/login-method.cap.js'
import type { InferProvider } from '../capabilities/capability-definition.js'
import type { ISnapshotOrchestrator } from '../capabilities/snapshot.cap.js'
import type { streamBrokerCapability } from '../capabilities/stream-broker.cap.js'
import type {
  CollectionCapabilityName,
  SingletonCapabilityName,
} from '../generated/capability-router-map.js'
// IAudioAnalyzer — replaced by InferProvider<typeof audioAnalyzerCapability> in CapabilityProviderMap
// IAudioClassifier — removed: audio-classifier cap deleted, merged into audio-analyzer
import type { StepDefinition } from '../types/pipeline-step.js'
// IAnalysisAddon — removed in P12b, replaced by pipeline-analytics cap in CapabilityProviderMap
import type { IAddonPageProvider } from './addon.js'
// INotificationOutput — replaced by InferProvider<typeof notificationOutputCapability> in CapabilityProviderMap
import type { IAddonRouteProvider } from './addon-routes.js'
// IMotionDetector — replaced by InferProvider<typeof motionDetectionCapability> in CapabilityProviderMap
import type { ILogDestination } from './logging.js'
import type { IPipelineExecutorProvider } from './pipeline-executor-capability.js'
import type { IPipelineOrchestratorProvider } from './pipeline-orchestrator-capability.js'
import type { IPipelineRunnerProvider } from './pipeline-runner-capability.js'
import type { IEmbeddingsBackend, ISettingsBackend } from './storage.js'

/**
 * Pipeline step capability — each step is a separate capability
 * named `pipeline-step:{stepId}` (e.g., `pipeline-step:object-detection`).
 *
 * Collection mode: multiple addons can provide the same step ID.
 * The user selects which provider to use per-camera or globally.
 */
export type IPipelineStepProvider = StepDefinition

/**
 * Cardinality of active providers for a capability:
 *   - `singleton` — one active provider cluster-wide
 *   - `collection` — every registered provider stays active
 *   - `per-node` — one active provider per node/agent
 */
export type CapabilityMode = 'singleton' | 'collection' | 'per-node'

/**
 * Declared in addon package.json manifests under camstack.addons[].capabilities.
 *
 * Mode (singleton / collection) is **not** declared here — the single source
 * of truth is the cap definition in `packages/types/src/capabilities/*.cap.ts`.
 * The kernel looks up the mode at registration time via the pre-declared
 * CapabilityDefinition. Manifests only reference the cap by name and
 * optionally declare dependencies + autoActivate. Session 5 A5 consolidation
 * removed the duplicated `mode` field from every addon manifest — see the
 * audit addendum finding R6 in the session 4 handover. D4 additionally
 * removed `kind` and `defaultActive` — all three behavioural fields now live
 * exclusively on the `CapabilityDefinition`.
 */
export interface CapabilityDeclaration {
  /** Capability name (e.g. 'storage', 'decoder', 'pipeline-analytics') */
  readonly name: string
  /** Optional dependencies — addon won't initialize until these capabilities are available */
  readonly dependsOn?: readonly string[]
  /**
   * Auto-activate this capability on all devices.
   * When true, this addon's capability is active on every device by default.
   * Users can disable it per-device. Default: false.
   */
  readonly autoActivate?: boolean
  /**
   * When true, the addon may omit calling registerProvider() for this
   * capability during initialize(). Validation will not warn about it.
   * Use for capabilities the addon conditionally provides (e.g. only
   * when a hardware accelerator is present).
   */
  readonly optional?: boolean
}

/**
 * Registration object for a service that consumes a capability.
 * The registry calls the appropriate callback when providers are added/removed/replaced.
 */
export interface CapabilityConsumerRegistration<T = unknown> {
  /** Which capability this consumer needs */
  readonly capability: string
  /** Called when a singleton provider is set or replaced. Async for teardown of previous. */
  onSet?(provider: T): void | Promise<void>
  /** Called when a collection provider is added */
  onAdded?(provider: T): void | Promise<void>
  /** Called when a collection provider is removed (addon disabled) */
  onRemoved?(provider: T): void | Promise<void>
}

/**
 * Per-node resolved view of a singleton capability — one entry per node
 * that hosts at least one provider for the cap. `providers` are the BARE
 * addon ids available on that node; `resolvedActive` is what the node will
 * actually use (per-node override → cluster-global default → first
 * available); `hasOverride` is true when an explicit per-node override is set.
 */
export interface NodeSingletonView {
  readonly nodeId: string
  readonly providers: readonly string[]
  readonly resolvedActive: string | null
  readonly hasOverride: boolean
}

/**
 * Introspection data for a registered capability.
 */
export interface CapabilityInfo {
  readonly name: string
  readonly mode: CapabilityMode
  /** All addon IDs that provide this capability */
  readonly providers: readonly string[]
  /** For singleton: the active addon ID (null if none) */
  readonly activeProvider: string | null
  /** For collection: addon IDs that are registered but disabled */
  readonly disabledProviders: readonly string[]
  /** For singleton caps: per-node resolved selection. Absent for non-singletons. */
  readonly perNode?: readonly NodeSingletonView[]
}

/**
 * Maps capability names to their provider interfaces.
 * Extensible via TypeScript declaration merging:
 *
 * ```typescript
 * declare module '@camstack/types' {
 *   interface CapabilityProviderMap {
 *     'my-custom-capability': IMyProvider
 *   }
 * }
 * ```
 */
export interface CapabilityProviderMap {
  // `storage` was flipped to a singleton cap (Task 3 of the storage-
  // unification refactor); the orchestrator (`core/builtins/storage-
  // orchestrator`) registers as the sole provider of the codegen'd
  // surface. The legacy `IStorageProvider` interface lives on as the
  // closed-enum contract for the upstream `storage-provider` collection
  // cap (filesystem-storage, future SFTP/S3/WebDAV).
  storage: InferProvider<typeof import('../capabilities/storage.cap.js').storageCapability>
  // Legacy interface entries below predate the InferProvider model.
  // Their providers register with a divergent shape (ILogDestination's sync
  // `write`, IAddonRouteProvider's Fastify `handler` closures, IAuthProvider's
  // internal login/JWT adapter) — moving them to InferProvider would silently
  // change provider call sites in addon-registry/feature/etc. These three caps
  // stay `mount: { kind: 'skip' }` (not served as tRPC cap routers).
  'log-destination': ILogDestination
  // Uses the inferred cap contract directly — `InferProvider<typeof streamBrokerCapability>` is the source of truth.
  'stream-broker': InferProvider<typeof streamBrokerCapability>
  // `addon-pages` — singleton aggregator cap. Provider lives in the hub-
  // local `addon-pages-aggregator` builtin, which walks every registered
  // `addon-pages-source` provider and stamps versioned `bundleUrl`s.
  'addon-pages': InferProvider<
    typeof import('../capabilities/addon-pages.cap.js').addonPagesCapability
  >
  // `addon-pages-source` — collection cap. Each addon contributing UI
  // pages registers a provider here with raw `AddonPageDeclaration[]`.
  'addon-pages-source': IAddonPageProvider
  // `addon-widgets` — singleton aggregator cap. Provider lives in the
  // hub-local `addon-widgets-aggregator` builtin, which walks every
  // registered `addon-widgets-source` provider and stamps versioned
  // `bundleUrl`s.
  'addon-widgets': InferProvider<
    typeof import('../capabilities/addon-widgets.cap.js').addonWidgetsCapability
  >
  // `addon-widgets-source` — collection cap. Each addon contributing
  // dashboard/device-tab widgets registers a provider here returning
  // raw `WidgetMetadata[]` for ITS widgets.
  'addon-widgets-source': InferProvider<
    typeof import('../capabilities/addon-widgets-source.cap.js').addonWidgetsSourceCapability
  >
  'admin-ui': InferProvider<typeof import('../capabilities/admin-ui.cap.js').adminUiCapability>
  'viewer-ui': InferProvider<typeof import('../capabilities/viewer-ui.cap.js').viewerUiCapability>
  'auth-provider': IAuthProvider
  // `login-method` — collection cap. Each auth addon (OIDC /
  // WebAuthn) contributes its pre-auth login surface(s); the public
  // `auth.listLoginMethods` procedure aggregates them for the login page.
  'login-method': ILoginMethodProvider
  'notification-output': InferProvider<
    typeof import('../capabilities/notification-output.cap.js').notificationOutputCapability
  >
  'addon-routes': IAddonRouteProvider
  // analysis-pipeline + analysis-data-persistence removed in P12b — see
  // pipeline-analytics below for the replacement cap.
  'pipeline-analytics': InferProvider<
    typeof import('../capabilities/pipeline-analytics.cap.js').pipelineAnalyticsCapability
  >
  // Uses the inferred cap contract — the legacy `IDeviceProvider` is the
  // pre-capability model that is no longer registered by any provider after
  // the device-provider contract refactor. `InferProvider` is the source of
  // truth for the router.
  'device-provider': InferProvider<
    typeof import('../capabilities/device-provider.cap.js').deviceProviderCapability
  >
  'device-manager': InferProvider<
    typeof import('../capabilities/device-manager.cap.js').deviceManagerCapability
  >
  // `device-adoption` — generic discovery/adoption surface. The
  // device-manager singleton proxies to it by addonId (Home Assistant,
  // …) via `waitForProvider('device-adoption', …)`; the typed map entry
  // makes that lookup return `IDeviceAdoptionProvider | null` with no cast.
  'device-adoption': InferProvider<
    typeof import('../capabilities/device-adoption.cap.js').deviceAdoptionCapability
  >
  // `broker` — message-broker collection cap (MQTT / HA). Map entry added
  // alongside `device-adoption` so consumers resolving it through the typed
  // registry getters get `IBrokerProvider` instead of `unknown`.
  broker: InferProvider<typeof import('../capabilities/broker.cap.js').brokerCapability>
  'device-state': InferProvider<
    typeof import('../capabilities/device-state.cap.js').deviceStateCapability
  >
  'user-management': InferProvider<
    typeof import('../capabilities/user-management.cap.js').userManagementCapability
  >
  'platform-probe': InferProvider<
    typeof import('../capabilities/platform-probe.cap.js').platformProbeCapability
  >
  'local-network': InferProvider<
    typeof import('../capabilities/local-network.cap.js').localNetworkCapability
  >
  'mesh-network': InferProvider<
    typeof import('../capabilities/mesh-network.cap.js').meshNetworkCapability
  >
  alerts: InferProvider<typeof import('../capabilities/alerts.cap.js').alertsCapability>
  backup: InferProvider<typeof import('../capabilities/backup.cap.js').backupCapability>
  // Uses the inferred cap contract — `network-access` providers
  // (cloudflare-tunnel, tailscale-ingress) register canonical
  // `InferProvider`-shaped providers; the legacy `INetworkAccessProvider`
  // interface (server-network.ts) was never the registered shape.
  'network-access': InferProvider<
    typeof import('../capabilities/network-access.cap.js').networkAccessCapability
  >
  // scene-intelligence: removed in P12a (no provider, no consumer)
  'pipeline-executor': IPipelineExecutorProvider
  'detection-pipeline': InferProvider<
    typeof import('../capabilities/detection-pipeline.cap.js').detectionPipelineCapability
  >
  'pipeline-orchestrator': IPipelineOrchestratorProvider
  'pipeline-runner': IPipelineRunnerProvider
  'motion-detection': InferProvider<
    typeof import('../capabilities/motion-detection.cap.js').motionDetectionCapability
  >
  'embedding-encoder': InferProvider<
    typeof import('../capabilities/embedding-encoder.cap.js').embeddingEncoderCapability
  >
  decoder: InferProvider<typeof import('../capabilities/decoder.cap.js').decoderCapability>
  'audio-analyzer': InferProvider<
    typeof import('../capabilities/audio-analyzer.cap.js').audioAnalyzerCapability
  >
  'audio-analysis': InferProvider<
    typeof import('../capabilities/audio-analysis.cap.js').audioAnalysisCapability
  >
  'audio-codec': InferProvider<
    typeof import('../capabilities/audio-codec.cap.js').audioCodecCapability
  >
  'addon-settings': InferProvider<
    typeof import('../capabilities/addon-settings.cap.js').addonSettingsCapability
  >
  'settings-store': ISettingsBackend
  embeddings: IEmbeddingsBackend
  snapshot: ISnapshotOrchestrator
  'metrics-provider': InferProvider<
    typeof import('../capabilities/metrics-provider.cap.js').metricsProviderCapability
  >
  // Device-scoped facades registered by addon-stream-broker. Both
  // mount as singleton cap providers at the hub and serve every
  // camera device from the same instance.
  'camera-streams': InferProvider<
    typeof import('../capabilities/camera-streams.cap.js').cameraStreamsCapability
  >
  'webrtc-session': InferProvider<
    typeof import('../capabilities/webrtc-session.cap.js').webrtcSessionCapability
  >
  // Device-scoped capabilities (singleton providers handling all
  // devices of a kind via deviceId routing). Mounted in trpc.router.ts
  // via requireSingleton.
  accessories: InferProvider<
    typeof import('../capabilities/accessories.cap.js').accessoriesCapability
  >
  battery: InferProvider<typeof import('../capabilities/battery.cap.js').batteryCapability>
  doorbell: InferProvider<typeof import('../capabilities/doorbell.cap.js').doorbellCapability>
  'event-emitter': InferProvider<
    typeof import('../capabilities/event-emitter.cap.js').eventEmitterCapability
  >
  update: InferProvider<typeof import('../capabilities/update.cap.js').updateCapability>
  intercom: InferProvider<typeof import('../capabilities/intercom.cap.js').intercomCapability>
  switch: InferProvider<typeof import('../capabilities/switch.cap.js').switchCapability>
  osd: InferProvider<typeof import('../capabilities/osd.cap.js').osdCapability>
  'stream-params': InferProvider<
    typeof import('../capabilities/stream-params.cap.js').streamParamsCapability
  >
  'stream-catalog': InferProvider<
    typeof import('../capabilities/stream-catalog.cap.js').streamCatalogCapability
  >
  'motion-zones': InferProvider<
    typeof import('../capabilities/motion-zones.cap.js').motionZonesCapability
  >
  'privacy-mask': InferProvider<
    typeof import('../capabilities/privacy-mask.cap.js').privacyMaskCapability
  >
  ptz: InferProvider<typeof import('../capabilities/ptz.cap.js').ptzCapability>
  'ptz-autotrack': InferProvider<
    typeof import('../capabilities/ptz-autotrack.cap.js').ptzAutotrackCapability
  >
  consumables: InferProvider<
    typeof import('../capabilities/consumables.cap.js').consumablesCapability
  >
  reboot: InferProvider<typeof import('../capabilities/reboot.cap.js').rebootCapability>
  'device-discovery': InferProvider<
    typeof import('../capabilities/device-discovery.cap.js').deviceDiscoveryCapability
  >
  brightness: InferProvider<typeof import('../capabilities/brightness.cap.js').brightnessCapability>
  'motion-trigger': InferProvider<
    typeof import('../capabilities/motion-trigger.cap.js').motionTriggerCapability
  >
  recording: InferProvider<typeof import('../capabilities/recording.cap.js').recordingCapability>
  zones: InferProvider<typeof import('../capabilities/zones.cap.js').zonesCapability>
  'zone-rules': InferProvider<
    typeof import('../capabilities/zone-rules.cap.js').zoneRulesCapability
  >
  'zone-analytics': InferProvider<
    typeof import('../capabilities/zone-analytics.cap.js').zoneAnalyticsCapability
  >
  'audio-metrics': InferProvider<
    typeof import('../capabilities/audio-metrics.cap.js').audioMetricsCapability
  >
  motion: InferProvider<typeof import('../capabilities/motion.cap.js').motionCapability>
  'native-object-detection': InferProvider<
    typeof import('../capabilities/native-object-detection.cap.js').nativeObjectDetectionCapability
  >
  'device-ops': InferProvider<
    typeof import('../capabilities/device-ops.cap.js').deviceOpsCapability
  >
  // Phase E (2026-05-06) — formerly hand-written core routers, now caps:
  system: InferProvider<typeof import('../capabilities/system.cap.js').systemCapability>
  'network-quality': InferProvider<
    typeof import('../capabilities/network-quality.cap.js').networkQualityCapability
  >
  toast: InferProvider<typeof import('../capabilities/toast.cap.js').toastCapability>
  nodes: InferProvider<typeof import('../capabilities/nodes.cap.js').nodesCapability>
  integrations: InferProvider<
    typeof import('../capabilities/integrations.cap.js').integrationsCapability
  >
  addons: InferProvider<typeof import('../capabilities/addons.cap.js').addonsCapability>
  // `remote-access` was retired (2026-05-15) — the admin UI now talks to
  // the `network-access` collection cap directly via generic per-addonId
  // routing; its orchestrator addon stays alive as a backend-only
  // boot-autostart service.
  //
  // `turn-orchestrator` was retired (2026-05-15) — every piece of it is
  // now a generic primitive: `addons.listCapabilityProviders` /
  // `addons.setCapabilityProviderEnabled` for inventory + toggling, and
  // the `turn-provider` collection's array-output aggregate
  // (`getTurnServers` fanned across enabled providers by the auto-mount)
  // for the combined ICE-server list.
  //
  // `authentication` was retired (2026-05-15) — the singleton facade over
  // the `auth-provider` collection was vestigial (no-op `setProviderEnabled`,
  // hardcoded `enabled: true`). The admin UI now enumerates / toggles via
  // the generic `addons` primitives; the login page reads the public
  // `auth.listLoginMethods` aggregate over the `login-method` collection.
  // `turn-provider` collection cap — `getTurnServers` is array-output,
  // so the auto-mount aggregates it across every enabled provider.
  // `storage-provider` is the collection sister of `storage`.
  // `camera-credentials`, `device-status`, `feature-probe` are
  // independent caps. Added in commits ee46c646 / a2082112 / 941a65fd /
  // d55ff3df with codegen run but the hand-curated map forgotten.
  'turn-provider': InferProvider<
    typeof import('../capabilities/turn-provider.cap.js').turnProviderCapability
  >
  'storage-provider': InferProvider<
    typeof import('../capabilities/storage-provider.cap.js').storageProviderCapability
  >
  'camera-credentials': InferProvider<
    typeof import('../capabilities/camera-credentials.cap.js').cameraCredentialsCapability
  >
  'device-status': InferProvider<
    typeof import('../capabilities/device-status.cap.js').deviceStatusCapability
  >
  'feature-probe': InferProvider<
    typeof import('../capabilities/feature-probe.cap.js').featureProbeCapability
  >
  // Public-surface mount batch (2026-05-13) — collection caps added via
  // codegen but absent from the provider map. Same forgotten-step bug
  // as the cluster above.
  'device-export': InferProvider<
    typeof import('../capabilities/device-export.cap.js').deviceExportCapability
  >
  'mqtt-broker': InferProvider<
    typeof import('../capabilities/mqtt-broker.cap.js').mqttBrokerCapability
  >
  // Home Assistant device-native caps (registered via ctx.registerNativeCap
  // on per-device HA child devices). Added alongside deviceNative:true in the
  // cap definitions so requireDeviceScoped can resolve them without a cast.
  'air-quality-sensor': InferProvider<
    typeof import('../capabilities/air-quality-sensor.cap.js').airQualitySensorCapability
  >
  'alarm-panel': InferProvider<
    typeof import('../capabilities/alarm-panel.cap.js').alarmPanelCapability
  >
  'ambient-light-sensor': InferProvider<
    typeof import('../capabilities/ambient-light-sensor.cap.js').ambientLightSensorCapability
  >
  'automation-control': InferProvider<
    typeof import('../capabilities/automation-control.cap.js').automationControlCapability
  >
  binary: InferProvider<typeof import('../capabilities/binary.cap.js').binaryCapability>
  'carbon-monoxide': InferProvider<
    typeof import('../capabilities/carbon-monoxide.cap.js').carbonMonoxideCapability
  >
  'climate-control': InferProvider<
    typeof import('../capabilities/climate-control.cap.js').climateControlCapability
  >
  color: InferProvider<typeof import('../capabilities/color.cap.js').colorCapability>
  connectivity: InferProvider<
    typeof import('../capabilities/connectivity.cap.js').connectivityCapability
  >
  contact: InferProvider<typeof import('../capabilities/contact.cap.js').contactCapability>
  control: InferProvider<typeof import('../capabilities/control.cap.js').controlCapability>
  cover: InferProvider<typeof import('../capabilities/cover.cap.js').coverCapability>
  'enum-sensor': InferProvider<
    typeof import('../capabilities/enum-sensor.cap.js').enumSensorCapability
  >
  'fan-control': InferProvider<
    typeof import('../capabilities/fan-control.cap.js').fanControlCapability
  >
  flood: InferProvider<typeof import('../capabilities/flood.cap.js').floodCapability>
  gas: InferProvider<typeof import('../capabilities/gas.cap.js').gasCapability>
  'humidity-sensor': InferProvider<
    typeof import('../capabilities/humidity-sensor.cap.js').humiditySensorCapability
  >
  'lock-control': InferProvider<
    typeof import('../capabilities/lock-control.cap.js').lockControlCapability
  >
  'vacuum-control': InferProvider<
    typeof import('../capabilities/vacuum-control.cap.js').vacuumControlCapability
  >
  'lawn-mower-control': InferProvider<
    typeof import('../capabilities/lawn-mower-control.cap.js').lawnMowerControlCapability
  >
  valve: InferProvider<typeof import('../capabilities/valve.cap.js').valveCapability>
  humidifier: InferProvider<typeof import('../capabilities/humidifier.cap.js').humidifierCapability>
  'water-heater': InferProvider<
    typeof import('../capabilities/water-heater.cap.js').waterHeaterCapability
  >
  weather: InferProvider<typeof import('../capabilities/weather.cap.js').weatherCapability>
  image: InferProvider<typeof import('../capabilities/image.cap.js').imageCapability>
  'media-player': InferProvider<
    typeof import('../capabilities/media-player.cap.js').mediaPlayerCapability
  >
  notifier: InferProvider<typeof import('../capabilities/notifier.cap.js').notifierCapability>
  'numeric-sensor': InferProvider<
    typeof import('../capabilities/numeric-sensor.cap.js').numericSensorCapability
  >
  'power-meter': InferProvider<
    typeof import('../capabilities/power-meter.cap.js').powerMeterCapability
  >
  presence: InferProvider<typeof import('../capabilities/presence.cap.js').presenceCapability>
  'pressure-sensor': InferProvider<
    typeof import('../capabilities/pressure-sensor.cap.js').pressureSensorCapability
  >
  'script-runner': InferProvider<
    typeof import('../capabilities/script-runner.cap.js').scriptRunnerCapability
  >
  smoke: InferProvider<typeof import('../capabilities/smoke.cap.js').smokeCapability>
  tamper: InferProvider<typeof import('../capabilities/tamper.cap.js').tamperCapability>
  'temperature-sensor': InferProvider<
    typeof import('../capabilities/temperature-sensor.cap.js').temperatureSensorCapability
  >
  vibration: InferProvider<typeof import('../capabilities/vibration.cap.js').vibrationCapability>
  // HA-targeted fire-only actuator cap (Phase C4)
  button: InferProvider<typeof import('../capabilities/button.cap.js').buttonCapability>
  // Model Studio P3 — singleton conversion worker cap. Added to the
  // provider map so `requireSingleton(registry, 'model-convert')` is
  // well-typed without a cast at the mount site (trpc.router.ts).
  'model-convert': InferProvider<
    typeof import('../capabilities/model-convert.cap.js').modelConvertCapability
  >
  // Additional capabilities added via declaration merging.
  // NOTE: we deliberately do NOT add `[key: string]: unknown` because
  // that collapses every typed lookup to `unknown`. Downstream packages
  // add their entries via `declare module '@camstack/types'`.
}

/**
 * Capability provider map filtered to capabilities declared as `singleton`
 * in their `.cap.ts` definition. Derived at compile time from the generated
 * `SingletonCapabilityName` union and the hand-curated `CapabilityProviderMap`.
 *
 * Consumers that need to narrow a getter should use this type to express
 * intent: `getSingleton<K extends keyof SingletonCapabilityMap>(name: K)`.
 * A cap declared as collection will be rejected at the type level even if
 * it exists in `CapabilityProviderMap`.
 *
 * Introduced in session 5 Sprint A5 to unblock hard-typed registry getters.
 */
export type SingletonCapabilityMap = {
  [K in SingletonCapabilityName as K extends keyof CapabilityProviderMap
    ? K
    : never]: K extends keyof CapabilityProviderMap ? CapabilityProviderMap[K] : never
}

/**
 * Capability provider map filtered to capabilities declared as `collection`
 * in their `.cap.ts` definition. Counterpart to `SingletonCapabilityMap`.
 */
export type CollectionCapabilityMap = {
  [K in CollectionCapabilityName as K extends keyof CapabilityProviderMap
    ? K
    : never]: K extends keyof CapabilityProviderMap ? CapabilityProviderMap[K] : never
}
