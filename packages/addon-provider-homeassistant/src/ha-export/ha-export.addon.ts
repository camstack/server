/**
 * Native Home Assistant export — a custom component fed by HTTP push.
 *
 * Contract: `docs/superpowers/specs/2026-08-04-ha-native-export-design.md`.
 * Read it before changing the entity map or the transport.
 *
 * **This addon PUSHES. Home Assistant never polls camstack for a value.**
 * Every entity in the catalog is fed by a listener here, on the authority
 * that already owns the value — device slices, motion, the track
 * lifecycle, zone occupancy, the camera switches. The projector turns
 * each into `{topic, value}` and the push client batches, dedups and
 * heartbeats them out.
 *
 * Where it lives, and why it is not inside the provider's process: it
 * ships in the SAME bundle as `provider-homeassistant` (so the HA URL and
 * token are not duplicated — they are read through the `broker` cap, and
 * addons never import each other even in one bundle), but as a SEPARATE
 * manifest entry with its own runner. D29: a defect in export must not be
 * able to respawn the runner that owns the devices.
 *
 * Three things a future session will want to know:
 *
 *  1. **Push authenticates with Home Assistant's OWN token.** The
 *     component registers its view with HA auth, so the long-lived token
 *     already stored on the broker is the credential. There is no second
 *     shared secret to configure, rotate or leak.
 *  2. **Events optimise; the reconcile is the contract.** Bus events are
 *     telemetry and may be dropped (D8), so a full reconcile runs on
 *     boot, on config change, on a timer, and whenever the link to HA
 *     returns. A dropped event costs one interval of staleness rather
 *     than permanent divergence.
 *  3. **Membership is per broker.** Two Home Assistant instances see
 *     different sets of cameras, and the per-device Export panel shows
 *     one switch per broker over the single membership store.
 */
import {
  addonRoutesCapability,
  BaseAddon,
  buildAddonRouteProvider,
  type CameraStatus,
  CameraSwitchIdSchema,
  type ConfigUISchema,
  type ConfigUISchemaWithValues,
  deviceExportCapability,
  EventCategory,
  type IAddonHttpRoute,
  type IDeviceExportProvider,
  isReadingQuantity,
  type IOauthIntegrationProvider,
  NC_HISTORY_LIMIT_MAX,
  nodePin,
  oauthIntegrationCapability,
  type ProviderRegistration,
} from '@camstack/types'
import { z } from 'zod'
import { HA_PROVIDER_ADDON_ID, listHomeAssistantBrokers } from '../ha-broker-source.js'
import { applyCameraFunctionWrite } from './camera-function-writes.js'
import {
  type CameraFunction,
  type CameraFunctionReads,
  type CameraPrivacyReads,
  deriveCameraFunctions,
  resolveCameraFunctionWrite,
} from './camera-functions.js'
import {
  applyCapCommand,
  type CommandTarget,
  type ExportCommand,
  isCapCommand,
  resolveCommand,
} from './command-routes.js'
import {
  COMPONENT_VERSION_PATH,
  type ComponentProbe,
  ComponentSupportTracker,
  parseComponentReport,
  supportSignature,
} from './component-support.js'
import { buildDevicePlan, CAMERA_DERIVED_CAPS, unclassifiedCaps } from './entity-catalog.js'
import {
  buildMediaUrl,
  haMediaBaseUrl,
  MEDIA_URL_TTL_MS,
  verifyMediaSignature,
} from './media-url.js'
import {
  brokerRefreshPatch,
  brokersExposing,
  type ExportMembership,
  enabledBrokerIds,
  exposedDeviceIds,
  isExposed,
  type KnownBroker,
  pruneBrokers,
  setExposed,
} from './membership.js'
import { footageForNode, shouldReadPackageStatus } from './node-reads.js'
import { HOME_ASSISTANT_OAUTH_INTEGRATION } from './oauth-integration.js'
import { PushClient } from './push-client.js'
import { ReachabilityReconciler } from './reachability-reconcile.js'
import { shouldSkipAnnounce, structureFingerprint } from './reconcile-fingerprint.js'
import {
  ReadMirror,
  cameraFunctionReadsFailed,
  type MirrorResolution,
  type ReadOutcome,
} from './held-reads.js'
import { ResyncGate } from './resync-gate.js'
import {
  isItemEntityCap,
  ITEM_ENTITY_MAP,
  type ItemEntity,
  itemEntitiesFor,
  projectItemSlice,
} from './item-entities.js'
import { type HistoryRow, reduceLastTriggers } from './rule-triggers.js'
import {
  type CameraStatusInput,
  projectAudioWindow,
  projectBatterySlice,
  projectCameraFunctions,
  projectCameraStatus,
  projectCapSlice,
  projectDeviceStatus,
  projectDoorbellSlice,
  projectMotion,
  projectNetworkLinkSlice,
  projectTrackLifecycle,
  projectZoneOccupancy,
  type StateValue,
} from './state-projector.js'
import {
  type AlertSummary,
  deriveAlertSummary,
  isSyntheticDeviceKey,
  projectSynthetic,
  ruleIdFromEntity,
  type SyntheticInput,
  type SyntheticLastTrigger,
  type SyntheticNode,
  type SyntheticRule,
  syntheticPlans,
} from './synthetic-devices.js'
import {
  EXPORTED_ENTITIES_STABLE_ID,
  ExportedEntities,
  type ExportedEntitiesState,
} from './exported-entities.js'
import { parseCommandTopic, stateTopic, syntheticDeviceKeyFor } from './topics.js'
import { SUPPORTED_DEVICE_KINDS } from './supported-device-kinds.js'
import type {
  CatalogDevice,
  CatalogFunctionSwitch,
  CatalogStreamChoice,
  CatalogZone,
  HaDevicePlan,
} from './types.js'

const ADDON_ID = 'homeassistant-export'

/** Where the custom component registers its push view inside HA. */
const PUSH_PATH = '/api/camstack/push'

const MEDIA_ROUTE_PREFIX = `/addon/${ADDON_ID}/ha-media`

/** How long `doorbell_pressed` stays on before its OFF edge is published. */
const DOORBELL_PULSE_MS = 5_000
/** How soon a pass with a held-back read is retried. */
const READ_RETRY_MS = 30_000

/**
 * The earliest timestamp a real change could plausibly carry. Below this,
 * a slice field is a placeholder or a seeded "known value, unknown change
 * time" stamp (e.g. Homematic's `HM_SEEDED_CHANGED_AT = 1`) — never a real
 * instant. Year 2000 predates every device this addon exports.
 */
const MIN_PLAUSIBLE_TIMESTAMP_MS = Date.UTC(2000, 0, 1)

/** One PTZ button press, as a relative move. */
const PTZ_MOVE_BY_DIRECTION: Readonly<
  Record<string, { pan?: number; tilt?: number; zoom?: number }>
> = {
  up: { tilt: 0.1 },
  down: { tilt: -0.1 },
  left: { pan: -0.1 },
  right: { pan: 0.1 },
  zoom_in: { zoom: 0.1 },
  zoom_out: { zoom: -0.1 },
}

interface HaExportConfig {
  readonly reconcileIntervalSec: number
  /** brokerId → exported device ids. The ONLY export-membership store. */
  readonly membership: ExportMembership
  /** Refreshed on every reconcile so the checkbox list stays honest. */
  readonly knownBrokers: readonly KnownBroker[]
  /**
   * The actions and notification targets exported beside the devices (D968).
   * Hidden state, written through `exposeEntity` / `unexposeEntity` only.
   */
  readonly exportedEntities: ExportedEntitiesState
  /**
   * Base URL Home Assistant should use to FETCH media from this hub.
   * Empty means "work it out from the network caps"; a link that cannot
   * be resolved is never minted, because a broken image URL in HA reads
   * as a broken integration.
   */
  readonly publicBaseUrl: string
  /** `exportTo:<brokerId>` — one checkbox per broker present. */
  readonly [enabledKey: `exportTo:${string}`]: unknown
}

const DEFAULT_CONFIG: HaExportConfig = {
  reconcileIntervalSec: 300,
  membership: {},
  knownBrokers: [],
  exportedEntities: { actions: [], targets: [] },
  publicBaseUrl: '',
}

/** Resolved connection to one Home Assistant instance. */
interface BrokerLink {
  readonly brokerId: string
  readonly name: string
  readonly baseUrl: string
  readonly token: string
  readonly client: PushClient
}

/** What `settleItemEntities` decided for one device this pass. */
interface ItemEntitySettlement {
  readonly entities: Readonly<Record<string, readonly ItemEntity[]>>
  /** A removal or a failed read is being held — retry soon for the second vote. */
  readonly held: boolean
}

interface ExportedDevice {
  readonly plan: HaDevicePlan
  readonly deviceId: number
  readonly target: CommandTarget
  /** Brokers this device reaches. Empty means it is exported nowhere. */
  readonly brokerIds: readonly string[]
  /**
   * The streams the plan's `camera` entities were built from.
   *
   * Kept for the reconcile fingerprint and for the log line, NOT for a
   * value pass: a camera entity carries no state on the push plane — the
   * component negotiates it from the `stream_target` announced with the
   * entity. It used to carry an RTSP url per (profile, mute) pair, which
   * the component has never read.
   */
  readonly streams: readonly CatalogStreamChoice[]
  /**
   * The camera function reads for THIS pass, computed ONCE
   * (`readCameraFunctions`) and reused by both the announce (the switch
   * catalog) and the state push (`currentStateFor`) — the two used to call
   * the deprecated `getCameraSwitches` separately for the same answer.
   * `null` for a non-camera or a camera whose reads failed entirely.
   */
  readonly cameraFunctions: readonly CameraFunction[] | null
}

export class HaExportAddon extends BaseAddon<HaExportConfig> {
  private links = new Map<string, BrokerLink>()
  /** deviceKey → the device it addresses. Rebuilt on every reconcile. */
  private exported = new Map<string, ExportedDevice>()
  /** numeric deviceId → deviceKey, for the event path. */
  private keyByDeviceId = new Map<number, string>()
  private mediaSecret = ''
  private mediaBaseUrl: string | null = null
  private reconcileTimer: NodeJS.Timeout | null = null
  private reconcileInFlight = false
  /** A reason asked for while one was running. Re-run, never dropped. */
  private reconcilePending: string | null = null
  private lastError: string | undefined
  /**
   * Fingerprint of the last ANNOUNCED structure. An event-debounced
   * reconcile that rebuilds an identical structure skips the announce and
   * the full state push: a flapping camera (RTSP retry every 4 s emits a
   * device event per attempt) was driving a full 2.7 s reconcile every
   * ~13 s, forever. Only the 'structure-changed' reason short-circuits —
   * 'boot', 'periodic' and config-driven passes always announce, so the
   * D8/D11 contract (events are an optimisation, never a substitute)
   * still holds through the periodic pass.
   */
  private lastStructureFingerprint: string | undefined
  /**
   * When the next pass must be a FULL authoritative announce (`full: true` on
   * the wire) whatever the fingerprint says: a start, a new broker link, an
   * undelivered push, a failed pass. See `resync-gate.ts`.
   */
  private readonly resync = new ResyncGate()
  /**
   * The last EXPORTED set of each part of a device's component set. A read
   * that failed (or a provider not registered yet) holds it; a shrink needs
   * two agreeing answers. See `held-reads.ts`.
   */
  private readonly boundCapsMirror = new ReadMirror<string>((cap) => cap)
  private readonly zonesMirror = new ReadMirror<CatalogZone>((zone) => zone.id)
  private readonly streamsMirror = new ReadMirror<CatalogStreamChoice>((stream) => stream.id)
  private readonly presetsMirror = new ReadMirror<string>((preset) => preset)
  private readonly switchesMirror = new ReadMirror<CatalogFunctionSwitch>((fn) => fn.id)
  /**
   * Per-item capability → its mirror, keyed by entity id. An item that
   * leaves the slice deletes its entities (and their history) in Home
   * Assistant, so the removal waits for a second read to agree (D49).
   */
  private readonly itemEntityMirrors = new Map<string, ReadMirror<ItemEntity>>(
    Object.keys(ITEM_ENTITY_MAP).map((cap) => [
      cap,
      new ReadMirror<ItemEntity>((item) => item.entity),
    ]),
  )
  /** A held-back read is retried soon, not at the next 300 s pass. */
  private readTimer: NodeJS.Timeout | null = null
  private entityCount = 0
  /** deviceId → the `lastPressedAt` already rung, so a re-read does not ring again. */
  private readonly lastDoorbellPressAt = new Map<number, number>()
  /** deviceId → the pending OFF edge. HA releases nothing on its own. */
  private readonly doorbellReleaseTimers = new Map<number, NodeJS.Timeout>()
  private unclassified: readonly string[] = []
  /**
   * What each Home Assistant's custom component can BUILD.
   *
   * The hub and the component ship on different trains — the operator
   * updates the integration through HACS when they decide to — so a
   * platform this hub knows about is not one the component has. Refreshed
   * at the top of every reconcile, before any plan is built.
   */
  private readonly componentSupport = new ComponentSupportTracker()
  /**
   * The rules as of the last reconcile, so a command arriving on
   * `rule_<slug>` can be turned back into the rule id it came from. Refreshed
   * whenever the synthetic devices are, never written to.
   */
  private syntheticRules: readonly SyntheticRule[] = []
  /** D968: the actions and notification targets exported beside the devices. */
  private exportedEntities: ExportedEntities | null = null
  /**
   * `pipelineOrchestrator.getCameraStatuses`, keyed by deviceId — ONE call
   * per reconcile pass for every exported camera (Task C3), never per
   * device: the input is optional and omitting it means "the whole fleet",
   * which is exactly the path this repo just finished removing from hot
   * loops. Feeds `status` / `recording_active` (Traccia C) and
   * `broker-audio`'s node pin (Traccia A2). Cleared to empty on a failed
   * read — never stale data from a previous pass, which would be a status
   * silently wrong rather than absent.
   */
  private cameraStatusByDeviceId = new Map<number, CameraStatus>()

  /**
   * A link that returned repairs NOW, not at the next periodic pass.
   *
   * `PushClient` drops its dedup cache the moment Home Assistant answers
   * again; without this, nothing re-sent anything and every entity sat
   * blank for up to `reconcileIntervalSec` (300s). Bounded and coalesced,
   * because the answer is the COMPLETE `cmps` set plus every value for
   * every exported device — see `reachability-reconcile.ts`.
   */
  private readonly reachability = new ReachabilityReconciler({
    onScheduled: ({ brokerId, delayMs }) => {
      this.ctx.logger.info('ha-export: Home Assistant link returned, re-announcing everything', {
        meta: { brokerId, inMs: delayMs },
      })
    },
    run: ({ brokerIds }) => {
      void this.reconcile('link-restored')
      this.ctx.logger.debug('ha-export: re-announce triggered by a returning link', {
        meta: { brokers: [...brokerIds] },
      })
    },
  })

  constructor() {
    super({ ...DEFAULT_CONFIG })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const secret = this.state<string>('haExportMediaSecret', z.string(), '')
    const existing = await secret.get()
    if (existing.length === 0) {
      const minted = randomSecret()
      await secret.set(minted)
      this.mediaSecret = minted
    } else {
      this.mediaSecret = existing
    }

    this.wireListeners()
    await this.serveMediaPlane()

    // DETACHED, deliberately. `onInitialize` does not return until this method
    // does, and a provider is registered only once it returns — so anything
    // awaited here delays every capability this addon declares. The boot
    // reconcile sweeps the whole fleet through `ctx.api` (listAll, every
    // snapshot, per-device bindings and zones): seconds on a real hub, longer
    // when a Home Assistant is unreachable. It used to delay only export, which
    // nothing else waits for; it now also delays the `homeassistant` OAuth
    // descriptor, and a linking attempt in that window gets no integration.
    //
    // Safe to detach: `reconcile` guards its own re-entry and re-runs a request
    // that arrived mid-pass, and `startTimer` owns the cadence regardless.
    void this.reconcile('boot').catch((err: unknown) => {
      this.lastError = errMsg(err)
      this.ctx.logger.warn('ha-export: initial reconcile failed', {
        meta: { error: this.lastError },
      })
    })
    this.startTimer()

    this.ctx.addDisposer(async () => {
      this.stopTimer()
      // A doorbell rung in the last 5s has an OFF edge pending; drop it rather
      // than let a timer keep the runner's event loop alive past shutdown.
      for (const timer of this.doorbellReleaseTimers.values()) clearTimeout(timer)
      this.doorbellReleaseTimers.clear()
      this.reachability.dispose()
      if (this.readTimer !== null) clearTimeout(this.readTimer)
      this.readTimer = null
      for (const link of this.links.values()) await link.client.dispose()
      this.links.clear()
    })

    const exportedEntities = new ExportedEntities(
      {
        api: this.ctx.api,
        logger: this.ctx.logger,
        persist: (next) => this.updateGlobalSettings({ exportedEntities: next }),
        reconcile: () => this.reconcile('exported-entities-changed'),
      },
      this.config.exportedEntities ?? DEFAULT_CONFIG.exportedEntities,
    )
    this.exportedEntities = exportedEntities

    const exportProvider: IDeviceExportProvider = {
      getStatus: async () => this.buildStatus(),
      listSupportedDeviceKinds: async () => [...SUPPORTED_DEVICE_KINDS],
      listExposedDevices: async () =>
        exposedDeviceIds(this.config.membership, this.enabledBrokerIds()).map((deviceId) => ({
          deviceId,
          exposedAs: brokersExposing(this.config.membership, deviceId)
            .map((brokerId) => this.brokerName(brokerId))
            .join(', '),
        })),
      exposeDevice: async ({ deviceId }) => this.setMembershipEverywhere(deviceId, true),
      unexposeDevice: async ({ deviceId }) => this.setMembershipEverywhere(deviceId, false),
      listSupportedEntityKinds: async () => ['device', 'action', 'notifier'],
      listExposedEntities: async () => {
        await exportedEntities.pruneDeleted()
        return [
          ...exposedDeviceIds(this.config.membership, this.enabledBrokerIds()).map((deviceId) => ({
            entity: { kind: 'device' as const, deviceId },
            exposedAs: brokersExposing(this.config.membership, deviceId)
              .map((brokerId) => this.brokerName(brokerId))
              .join(', '),
          })),
          ...exportedEntities.list(),
        ]
      },
      exposeEntity: async ({ entity }) =>
        entity.kind === 'device'
          ? this.setMembershipEverywhere(entity.deviceId, true)
          : exportedEntities.expose(entity),
      unexposeEntity: async ({ entity }) =>
        entity.kind === 'device'
          ? this.setMembershipEverywhere(entity.deviceId, false)
          : exportedEntities.unexpose(entity),
      getDeviceSettingsContribution: async ({ deviceId }) => this.buildContribution(deviceId),
      getDeviceLiveContribution: async () => null,
      applyDeviceSettingsPatch: async ({ deviceId, patch }) =>
        this.applyDeviceSettingsPatch(deviceId, patch),
    }

    const routes: IAddonHttpRoute[] = [
      {
        method: 'POST',
        path: '/command',
        access: 'authenticated',
        description: 'Home Assistant → CamStack command: {topic, value}',
        handler: async (request, reply) => {
          await this.handleCommandRoute(request.body, reply)
        },
      },
    ]

    // The `homeassistant` OAuth client. Static — it depends on nothing this
    // addon has to fetch, which is why it must not sit behind anything that
    // does. See oauth-integration.ts for why this manifest owns it.
    const oauthIntegrationProvider: IOauthIntegrationProvider = {
      getDescriptor: async () => HOME_ASSISTANT_OAUTH_INTEGRATION,
    }

    return [
      { capability: deviceExportCapability, provider: exportProvider },
      {
        capability: addonRoutesCapability,
        provider: buildAddonRouteProvider(ADDON_ID, routes),
      },
      {
        capability: oauthIntegrationCapability,
        provider: oauthIntegrationProvider,
      },
    ]
  }

  protected async onConfigChanged(): Promise<void> {
    await this.reconcile('config-changed')
    this.startTimer()
  }

  // ── Listeners ───────────────────────────────────────────────────────
  //
  // Every value in the catalog is fed from here. A source with no
  // listener is a spec entity with no source, and those are named in the
  // addon's CLAUDE.md rather than left to look implemented.

  private wireListeners(): void {
    this.subscribe({ category: EventCategory.DeviceStateChanged }, (event) => {
      this.onSliceChanged(event.data)
    })
    this.subscribe({ category: EventCategory.DeviceOnline }, (event) => {
      this.onOnlineChanged(event.data, true)
    })
    this.subscribe({ category: EventCategory.DeviceOffline }, (event) => {
      this.onOnlineChanged(event.data, false)
    })
    this.subscribe({ category: EventCategory.MotionOnMotionChanged }, (event) => {
      this.onMotion(event.data)
    })
    /**
     * The audio window. This is the source `audio_detected` never had: it was
     * fed only by the track lifecycle, which rarely carries an audio macro, so
     * the entity existed and effectively never moved. It also carries the
     * window LEVEL, which nothing else on the export path does.
     */
    this.subscribe({ category: EventCategory.PipelineAudioInferenceResult }, (event) => {
      this.onAudioWindow(event.data)
    })
    this.subscribe({ category: EventCategory.PipelineAnalyticsTrackLifecycle }, (event) => {
      void this.onTrackLifecycle(event.data)
    })
    this.subscribe({ category: EventCategory.ZoneAnalyticsOccupancyChanged }, (event) => {
      this.onZoneOccupancy(event.data)
    })
    /**
     * Structure, not value. A new device, a lost one or a changed
     * binding changes the `cmps` set, so it needs a full reconcile
     * rather than a state push.
     */
    for (const category of [
      EventCategory.DeviceRegistered,
      EventCategory.DeviceUnregistered,
      EventCategory.DeviceBindingsChanged,
      EventCategory.DeviceMetaChanged,
      EventCategory.BrokerStatusChanged,
    ]) {
      this.subscribe({ category }, () => {
        void this.reconcileSoon()
      })
    }
  }

  /**
   * A slice changed → the entities that read it.
   *
   * Two halves, exactly as the catalog has two halves. `device-status`
   * and `battery` are projected by hand for BOTH kinds — their topics are
   * the same on a camera and on a base device, and `battery` deliberately
   * publishes nothing when the device reports a low-battery INDICATOR
   * rather than a level, which a descriptor cannot express. Everything
   * else on a camera is a projection of pipeline output, and everything
   * else on a base device is derived from `CAP_ENTITY_MAP` — the same
   * branch `buildDevicePlan` takes, so the value can only land on an
   * entity the plan actually built.
   */
  private onSliceChanged(data: unknown): void {
    const deviceId = readNumber(data, 'deviceId')
    const capName = readString(data, 'capName')
    const slice = readRecord(data, 'slice')
    if (deviceId === null || capName === null || slice === null) return
    const deviceKey = this.keyByDeviceId.get(deviceId)
    if (deviceKey === undefined) return

    /** Per-item: on a camera and a base device alike, minted from the slice. */
    if (isItemEntityCap(capName)) {
      this.pushItemCap(deviceId, deviceKey, capName, slice)
      return
    }

    if (capName !== 'device-status' && capName !== 'battery' && !this.isCamera(deviceKey)) {
      this.pushDerivedCap(deviceId, deviceKey, capName, slice)
      return
    }

    /**
     * The two capabilities a CAMERA carries from the derived half. Same
     * descriptor, same entity id, same projector — the camera catalog
     * simply builds the component instead of `buildDerivedPlan`.
     */
    if (CAMERA_DERIVED_CAPS.includes(capName)) {
      this.pushDerivedCap(deviceId, deviceKey, capName, slice)
      return
    }

    if (capName === 'device-status') {
      const online = slice['online']
      if (typeof online === 'boolean') {
        this.push(deviceId, projectDeviceStatus(deviceKey, online))
      }
      return
    }
    if (capName === 'network-link') {
      const type = readString(slice, 'type')
      if (type === null) return
      const signalPercent = readNumber(slice, 'signal')
      this.push(deviceId, projectNetworkLinkSlice(deviceKey, { type, signalPercent }))
      return
    }
    if (capName === 'battery') {
      const percentage = readNumber(slice, 'level')
      const charging = readString(slice, 'charging')
      const sleeping = slice['sleeping']
      if (percentage === null || charging === null || typeof sleeping !== 'boolean') return
      const binary = slice['binary']
      this.push(
        deviceId,
        projectBatterySlice(deviceKey, {
          percentage,
          charging,
          sleeping,
          ...(typeof binary === 'boolean' ? { binary } : {}),
        }),
      )
      return
    }
    if (capName === 'doorbell') {
      /**
       * A press is a PULSE — the slice carries `lastPressedAt`, never a
       * boolean. `doorbell_pressed` is therefore ON only when THIS delivery
       * advanced the timestamp, and the previous value is remembered per
       * device rather than compared against the clock: a reconcile re-read of
       * an unchanged slice must not ring the doorbell again in Home Assistant,
       * and a press that arrives while the export was restarting must still
       * ring once. HA auto-releases nothing, so the OFF edge is published on a
       * short timer — without it the binary sensor latches on for ever and the
       * next press produces no edge to automate on.
       */
      const lastPressedAt = readNumber(slice, 'lastPressedAt')
      const pressCountSinceStart = readNumber(slice, 'pressCountSinceStart') ?? 0
      const previous = this.lastDoorbellPressAt.get(deviceId) ?? null
      const pressed = lastPressedAt !== null && lastPressedAt !== previous
      if (pressed) this.lastDoorbellPressAt.set(deviceId, lastPressedAt)
      this.push(
        deviceId,
        projectDoorbellSlice(deviceKey, { lastPressedAt, pressCountSinceStart }, pressed),
      )
      if (pressed) {
        const existing = this.doorbellReleaseTimers.get(deviceId)
        if (existing !== undefined) clearTimeout(existing)
        this.doorbellReleaseTimers.set(
          deviceId,
          setTimeout(() => {
            this.doorbellReleaseTimers.delete(deviceId)
            this.push(
              deviceId,
              projectDoorbellSlice(deviceKey, { lastPressedAt, pressCountSinceStart }, false),
            )
          }, DOORBELL_PULSE_MS),
        )
      }
      return
    }
    if (capName === 'motion') {
      const detected = slice['detected']
      const lastDetectedAt = readNumber(slice, 'lastDetectedAt')
      if (typeof detected !== 'boolean') return
      // A `lastDetectedAt` below the floor is a seeded "known value, unknown
      // change time" stamp (Homematic's `HM_SEEDED_CHANGED_AT = 1`), never a
      // real instant — publishing it as `motion_last_detection` told Home
      // Assistant a camera detected motion in 1970. Treat it as absent
      // rather than fabricate `now()`, which would reintroduce the exact
      // bug the seed stamp exists to prevent: a stale reading read as fresh.
      // A genuinely absent stamp (cold start, never detected) still falls
      // back to `now()` for a detection happening this instant.
      const timestamp =
        lastDetectedAt === null
          ? Date.now()
          : lastDetectedAt >= MIN_PLAUSIBLE_TIMESTAMP_MS
            ? lastDetectedAt
            : null
      this.push(deviceId, projectMotion(deviceKey, { detected, timestamp }))
    }
  }

  /** Camera or base kind — the same question `buildDevicePlan` asks. */
  private isCamera(deviceKey: string): boolean {
    return this.exported.get(deviceKey)?.target.type === 'camera'
  }

  /**
   * The generic derived push: any capability in `CAP_ENTITY_MAP`.
   *
   * Every branch that produces no value SAYS so, once per
   * (device, cap, field): an entity that exists and never receives a
   * value used to be indistinguishable from an entity nothing had
   * happened to, and that is how 23 of the 27 mapped capabilities went
   * unnoticed with no push path at all. Once, because a slice that
   * changes every second must not turn a catalog defect into a log
   * flood — the first line already carries everything the fix needs.
   */
  private pushDerivedCap(
    deviceId: number,
    deviceKey: string,
    capName: string,
    slice: Readonly<Record<string, unknown>>,
  ): void {
    const projection = projectCapSlice(deviceKey, capName, slice)
    switch (projection.kind) {
      case 'values':
        if (projection.values.length > 0) this.push(deviceId, projection.values)
        for (const field of projection.missingFields ?? []) {
          this.warnOnce(deviceId, capName, field, {
            message: 'ha-export: a derived extra entity reads a field its slice does not carry',
            meta: { capName, field, sliceFields: Object.keys(slice) },
          })
        }
        return
      case 'no-entity':
        return
      case 'missing-field':
        this.warnOnce(deviceId, capName, projection.field, {
          message: 'ha-export: a derived entity reads a field its slice does not carry',
          meta: {
            capName,
            field: projection.field,
            sliceFields: projection.sliceFields,
          },
        })
        return
      case 'unrenderable':
        this.warnOnce(deviceId, capName, projection.field, {
          message: 'ha-export: a derived entity cannot render the value its slice carries',
          meta: {
            capName,
            field: projection.field,
            valueType: projection.valueType,
          },
        })
        return
    }
  }

  /** The per-item values of one slice that land on an entity the plan announced. */
  private announcedItemValues(
    entry: ExportedDevice,
    capName: string,
    slice: unknown,
  ): readonly StateValue[] {
    const key = entry.plan.deviceKey
    const topics = new Set(
      (entry.target.itemEntities ?? [])
        .filter((item) => item.capName === capName)
        .map((item) => stateTopic(key, item.entity)),
    )
    return (projectItemSlice(key, capName, slice) ?? []).filter((value) => topics.has(value.topic))
  }

  /**
   * The per-item push (`item-entities.ts`).
   *
   * Values land only on entities the plan announced. When the slice mints a
   * different entity SET than the plan holds — an item appeared, left, or
   * started reporting a level — the structure is re-derived by a debounced
   * reconcile; the item mirror there decides whether a removal is believed.
   */
  private pushItemCap(
    deviceId: number,
    deviceKey: string,
    capName: string,
    slice: Readonly<Record<string, unknown>>,
  ): void {
    const minted = itemEntitiesFor(capName, slice)
    if (minted === null) {
      this.warnOnce(deviceId, capName, 'items', {
        message: 'ha-export: a per-item slice is not the capability shape, nothing published',
        meta: { capName, sliceFields: Object.keys(slice) },
      })
      return
    }
    const entry = this.exported.get(deviceKey)
    if (entry === undefined) return
    const announced = (entry.target.itemEntities ?? []).filter((item) => item.capName === capName)
    const landing = this.announcedItemValues(entry, capName, slice)
    if (landing.length > 0) this.push(deviceId, landing)

    const mintedIds = minted.map((item) => item.entity).toSorted()
    const announcedIds = announced.map((item) => item.entity).toSorted()
    if (mintedIds.join('\u0000') !== announcedIds.join('\u0000')) {
      this.ctx.logger.info('ha-export: a per-item entity set changed, re-announcing the device', {
        tags: { deviceId },
        meta: {
          capName,
          added: mintedIds.filter((id) => !announcedIds.includes(id)),
          removed: announcedIds.filter((id) => !mintedIds.includes(id)),
        },
      })
      void this.reconcileSoon()
    }
  }

  /** deviceId:cap:field already reported. Bounded by devices × mapped caps. */
  private readonly warnedCapFields = new Set<string>()

  private warnOnce(
    deviceId: number,
    capName: string,
    field: string,
    line: { message: string; meta: Readonly<Record<string, unknown>> },
  ): void {
    const key = `${deviceId}:${capName}:${field}`
    if (this.warnedCapFields.has(key)) return
    this.warnedCapFields.add(key)
    this.ctx.logger.warn(line.message, { tags: { deviceId }, meta: line.meta })
  }

  private onOnlineChanged(data: unknown, online: boolean): void {
    const deviceId = readNumber(data, 'deviceId')
    if (deviceId === null) return
    const deviceKey = this.keyByDeviceId.get(deviceId)
    if (deviceKey === undefined) return
    this.push(deviceId, projectDeviceStatus(deviceKey, online))
  }

  private onMotion(data: unknown): void {
    const deviceId = readNumber(data, 'deviceId')
    const detected = readRecordField(data, 'detected')
    if (deviceId === null || typeof detected !== 'boolean') return
    const deviceKey = this.keyByDeviceId.get(deviceId)
    if (deviceKey === undefined) return
    /**
     * A base device's motion entity is `motion`, a camera's is
     * `motion_detected` + `triggered`. The cap event is the same one, so
     * the projection has to follow the device's own half of the catalog —
     * publishing the camera topics for a PIR sensor addressed three
     * entities the sensor's plan never built.
     */
    if (!this.isCamera(deviceKey)) {
      this.pushDerivedCap(deviceId, deviceKey, 'motion', { detected })
      return
    }
    const timestamp = readNumber(data, 'timestamp') ?? Date.now()
    this.push(deviceId, projectMotion(deviceKey, { detected, timestamp }))
  }

  /**
   * The richest source: class, zone, identity, plate and the media key in
   * one payload. One subscription feeds most of a camera's catalog.
   */
  private async onTrackLifecycle(data: unknown): Promise<void> {
    const deviceId = readNumber(data, 'deviceId')
    const trackId = readString(data, 'trackId')
    const phase = readString(data, 'phase')
    if (deviceId === null || trackId === null) return
    if (phase !== 'start' && phase !== 'update' && phase !== 'end') return
    const deviceKey = this.keyByDeviceId.get(deviceId)
    if (deviceKey === undefined) return

    const classes = readStringArray(data, 'classes')
    const bestClassName = readString(data, 'bestClassName')
    const label = readString(data, 'label')
    const plateText = readString(data, 'plateText')
    const lastSeen = readNumber(data, 'lastSeen') ?? Date.now()
    const zonesVisited = readStringArray(data, 'zonesVisited')
    const fusedIntoTrackId = readString(data, 'fusedIntoTrackId')

    const mediaUrl = this.mintTrackMediaUrl(trackId, deviceId)
    const values = projectTrackLifecycle(
      deviceKey,
      {
        deviceId,
        trackId,
        phase,
        classes,
        ...(bestClassName !== null ? { bestClassName } : {}),
        ...(label !== null ? { label } : {}),
        ...(plateText !== null ? { plateText } : {}),
        lastSeen,
        zonesVisited,
        ...(fusedIntoTrackId !== null ? { fusedIntoTrackId } : {}),
      },
      mediaUrl,
    )
    if (values.length === 0) {
      this.ctx.logger.debug('ha-export: track produced no exportable state', {
        tags: { deviceId },
        meta: { trackId, bestClassName, phase, fusedIntoTrackId },
      })
      return
    }
    this.push(deviceId, values)
  }

  private onAudioWindow(data: unknown): void {
    const deviceId = readNumber(data, 'deviceId')
    if (deviceId === null) return
    const deviceKey = this.keyByDeviceId.get(deviceId)
    if (deviceKey === undefined) return
    const frame = readRecordField(data, 'frame')
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return
    const level = readRecord(frame, 'level')
    const dbfs = readNumber(level, 'dbfs')
    const rms = readNumber(level, 'rms')
    const raw = readRecordField(frame, 'detections')
    /**
     * An `AudioDetection` carries `macroClass` + `score` and its real sound
     * class in `labels: ScoredLabel[]` — the enrichment chain. It has NO
     * `className` and no `confidence`; reading those invented names mapped
     * every window to `[]`, so `audio_last_sound` sat at `unknown` for ever
     * while the analyzer was classifying happily (found 2026-08-09, symptom:
     * "le audio labels sembrano non arrivare" [the audio labels seem not to arrive]).
     *
     * The best LABEL wins over the macro: `audio` as a value tells an operator
     * nothing, `dog` or `crying` is the whole point. Falls back to the macro
     * class only when a detection carries no label at all.
     */
    const detections = Array.isArray(raw)
      ? raw.flatMap((entry) => {
          const labels = readRecordField(entry, 'labels')
          const best = Array.isArray(labels)
            ? labels.reduce<{ className: string; confidence: number } | null>((top, l) => {
                const label = readString(l, 'label')
                const score = readNumber(l, 'score') ?? 0
                if (label === null) return top
                return top === null || score > top.confidence
                  ? { className: label, confidence: score }
                  : top
              }, null)
            : null
          if (best !== null) return [best]
          const macro = readString(entry, 'macroClass')
          const score = readNumber(entry, 'score')
          return macro === null || score === null ? [] : [{ className: macro, confidence: score }]
        })
      : []
    this.push(
      deviceId,
      projectAudioWindow(deviceKey, {
        detections,
        ...(dbfs !== null ? { dbfs } : {}),
        ...(rms !== null ? { rms } : {}),
      }),
    )
  }

  private onZoneOccupancy(data: unknown): void {
    const deviceId = readNumber(data, 'deviceId')
    if (deviceId === null) return
    const deviceKey = this.keyByDeviceId.get(deviceId)
    if (deviceKey === undefined) return
    const zonesRaw = readRecordField(data, 'zones')
    if (!Array.isArray(zonesRaw)) return
    const zones = zonesRaw.flatMap((entry) => {
      const zoneId = readString(entry, 'zoneId')
      const byClass = readRecord(entry, 'byClass')
      if (zoneId === null) return []
      return [
        {
          zoneId,
          totalObjects: readNumber(entry, 'totalObjects') ?? 0,
          byClass: toCountRecord(byClass),
        },
      ]
    })
    // The frame-wide scope is the SCENE: everything on camera, zoned or not.
    // A camera with no zones defined still has one, which is why this is not
    // gated on `zones.length` the way the per-zone half is.
    const frame = readRecordField(data, 'frame')
    const scene =
      frame !== null && typeof frame === 'object' && !Array.isArray(frame)
        ? {
            totalObjects: readNumber(frame, 'totalObjects') ?? 0,
            byClass: toCountRecord(readRecord(frame, 'byClass')),
          }
        : undefined
    if (zones.length === 0 && scene === undefined) return
    this.push(
      deviceId,
      projectZoneOccupancy(deviceKey, {
        zones,
        ...(scene !== undefined ? { scene } : {}),
      }),
    )
  }

  // ── Push fan-out ────────────────────────────────────────────────────

  /**
   * Send a device's values to every broker it is exported to.
   *
   * A failure on one broker's client cannot reach another: each has its
   * own dedup cache and its own availability, so one unreachable Home
   * Assistant degrades only its own entities.
   */
  private push(deviceId: number, values: readonly StateValue[]): void {
    const deviceKey = this.keyByDeviceId.get(deviceId)
    if (deviceKey === undefined) return
    const exported = this.exported.get(deviceKey)
    if (exported === undefined) return
    for (const brokerId of exported.brokerIds) {
      const link = this.links.get(brokerId)
      if (link === undefined) continue
      for (const value of values) link.client.publishState(value.topic, value.value)
    }
  }

  // ── Reconcile ───────────────────────────────────────────────────────

  private reconcileQueued = false

  private async reconcileSoon(): Promise<void> {
    if (this.reconcileQueued) return
    this.reconcileQueued = true
    setTimeout(() => {
      this.reconcileQueued = false
      void this.reconcile('structure-changed')
    }, 2_000)
  }

  /**
   * The contract.
   *
   * Re-resolves the brokers, rebuilds every plan, re-sends the COMPLETE
   * `cmps` set for every exported device, and re-pushes every value.
   * Events are an optimisation over this, never a substitute (D8/D11).
   *
   * A reconcile asked for while one is running is RE-RUN after it, never
   * dropped. It used to be dropped, and silently: a link that returned
   * mid-pass cleared its dedup cache and then lost the only re-announce
   * that would have refilled it, which is the exact defect this addon
   * just fixed, arriving through a different door.
   */
  private async reconcile(reason: string): Promise<void> {
    if (this.reconcileInFlight) {
      this.reconcilePending = reason
      this.ctx.logger.debug('ha-export: a reconcile is already running, re-running after it', {
        meta: { reason },
      })
      return
    }
    this.reconcileInFlight = true
    try {
      let next: string | null = reason
      while (next !== null) {
        const current: string = next
        this.reconcilePending = null
        await this.runReconcile(current)
        next = this.reconcilePending
      }
    } finally {
      this.reconcileInFlight = false
      this.reconcilePending = null
    }
  }

  /** One pass. Never throws: a failure degrades this pass and no more. */
  private async runReconcile(reason: string): Promise<void> {
    const startedAt = Date.now()
    try {
      await this.refreshBrokers()
      // After the brokers: a link opened by this very pass is a gap too.
      const fullResync = this.resync.take(reason)
      let readsHeld = false
      await this.refreshMediaBaseUrl()
      // Before any plan is built: the answer decides which platforms the
      // plans may use, and a plan built on last pass's answer would
      // announce entities this Home Assistant cannot construct.
      await this.refreshComponentSupport()

      const enabled = this.enabledBrokerIds()
      const devices = await this.ctx.api.deviceManager.listAll.query({})
      const snapshots = await this.ctx.api.deviceState.getAllSnapshots.query({})
      const byId = new Map(devices.map((device) => [device.id, device]))

      /**
       * The exported cameras' `CameraStatus`, ONE call for every one of them
       * (Task C3). Computed BEFORE the per-device loop: `status`,
       * `recording_active` and `broker-audio`'s node pin all read from it, and
       * asking per camera would be the fan-out this repo just finished
       * removing from a 300 s poll.
       */
      const exposedIds = exposedDeviceIds(this.config.membership, enabled)
      const cameraDeviceIds: number[] = []
      for (const idStr of exposedIds) {
        const numericId = Number(idStr)
        if (!Number.isFinite(numericId)) continue
        const candidate = byId.get(numericId)
        if (
          candidate !== undefined &&
          candidate.type === 'camera' &&
          candidate.addonId !== HA_PROVIDER_ADDON_ID
        ) {
          cameraDeviceIds.push(numericId)
        }
      }
      this.cameraStatusByDeviceId = await this.readCameraStatuses(cameraDeviceIds)

      /** `notificationRules.listDeviceMutes` — once per pass, a flat list. */
      const mutedDeviceIds = await this.ctx.api.notificationRules.listDeviceMutes
        .query({})
        .then((r) => r.mutedDeviceIds)
        .catch((err: unknown): null => {
          this.ctx.logger.warn(
            'ha-export: could not read notification mutes, camera functions degrade',
            { meta: { error: errMsg(err) } },
          )
          return null
        })
      /** `deviceManager.listBindableCapsForDeviceType` — once per TYPE, not per device. */
      const bindableCapsByType = new Map<string, readonly string[] | null>()

      const exported = new Map<string, ExportedDevice>()
      const keyByDeviceId = new Map<number, string>()
      const allCaps = new Set<string>()
      const exportedDeviceLog: Array<{
        deviceId: number
        deviceType: string
        deviceKey: string
        brokers: readonly string[]
        entities: number
      }> = []
      let entityCount = 0

      for (const deviceIdStr of exposedDeviceIds(this.config.membership, enabled)) {
        const numericId = Number(deviceIdStr)
        if (!Number.isFinite(numericId)) {
          this.ctx.logger.warn('ha-export: membership holds a non-numeric device id, skipping', {
            meta: { deviceId: deviceIdStr },
          })
          continue
        }
        const device = byId.get(numericId)
        if (device === undefined) {
          this.ctx.logger.warn('ha-export: exported device is not in the registry, skipping', {
            tags: { deviceId: numericId },
          })
          continue
        }
        /**
         * The echo guard. A device imported FROM Home Assistant is never
         * exported back to it: HA would mirror its own entity across the
         * bridge, and any automation touching it would round-trip.
         */
        if (device.addonId === HA_PROVIDER_ADDON_ID) {
          this.ctx.logger.warn(
            'ha-export: refusing to export a device imported from Home Assistant',
            { tags: { deviceId: numericId } },
          )
          continue
        }

        /**
         * ONE collection of the eight function authorities per camera per
         * pass (Task A1/A3) — reused below by the announce (the switch
         * catalog, via `buildCatalogDevice`) AND by the state push
         * (`currentStateFor`, off `ExportedDevice.cameraFunctions`). The two
         * used to call the deprecated `getCameraSwitches` separately for the
         * same answer.
         */
        const sourceNodeId =
          this.cameraStatusByDeviceId.get(numericId)?.assignment.sourceNodeId ?? null
        const functionReads =
          device.type === 'camera'
            ? await this.readCameraFunctions({
                deviceId: numericId,
                deviceType: device.type,
                deviceDisabled: device.disabled,
                privacySlice: toSnapshot(snapshots[String(numericId)])['privacy-mask'],
                sourceNodeId,
                bindableCapsByType,
                mutedDeviceIds,
              })
            : null
        const cameraFunctions = functionReads !== null ? deriveCameraFunctions(functionReads) : null
        const functionsFailure =
          functionReads !== null ? cameraFunctionReadsFailed(functionReads, sourceNodeId) : null

        const built = await this.buildCatalogDevice(
          device,
          snapshots[String(numericId)],
          cameraFunctions,
          functionsFailure,
        )
        if (built.heldBack) readsHeld = true
        const catalogDevice = built.device
        if (catalogDevice === null) {
          // Nothing was ever exported for a part that cannot be read now:
          // announcing the rest would make Home Assistant delete the part.
          continue
        }
        for (const cap of catalogDevice.boundCaps) allCaps.add(cap)
        const brokerIds = brokersExposing(this.config.membership, deviceIdStr).filter((id) =>
          enabled.includes(id),
        )
        /**
         * The plan is built ONCE and announced to every broker that
         * receives the device, so it can only use platforms ALL of them
         * build — see `intersectSupport`. One instance on an old component
         * therefore holds its device back and nobody's entities silently
         * fail to arrive.
         */
        const plan = buildDevicePlan(catalogDevice, {
          platforms: this.componentSupport.supportForAll(brokerIds),
        })

        exported.set(plan.deviceKey, {
          plan,
          deviceId: numericId,
          target: {
            deviceId: numericId,
            type: device.type,
            boundCaps: catalogDevice.boundCaps,
            itemEntities: Object.values(catalogDevice.itemEntities ?? {}).flat(),
          },
          brokerIds,
          streams: catalogDevice.streams ?? [],
          cameraFunctions,
        })
        keyByDeviceId.set(numericId, plan.deviceKey)
        entityCount += Object.keys(plan.cmps).length

        /**
         * The positive branch. Every other line in this loop describes a
         * device being DROPPED; without this one an operator can see why
         * a device is missing but cannot confirm which devices were
         * actually exported, to which Home Assistant, with which
         * entities. Silence reads as "never happened" both ways. Deferred
         * until the announce decision: a skipped identical pass must not
         * repeat the whole roster either.
         */
        exportedDeviceLog.push({
          deviceId: numericId,
          deviceType: device.type,
          deviceKey: plan.deviceKey,
          brokers: brokerIds,
          entities: Object.keys(plan.cmps).length,
        })
      }

      /**
       * The synthetic devices — server-owned surfaces that are not camstack
       * devices. They are appended to the SAME `exported` map so they travel
       * the ordinary announce + push path: one code path for identity,
       * batching and dedup, rather than a parallel one that would drift.
       * `brokerIds` is every enabled broker, because they belong to the server
       * and not to a membership the operator picks per camera.
       */
      /**
       * The exported actions and notification targets (D968): one more
       * synthetic device. What the operator deleted is dropped first (a failed
       * read changes nothing); a target the component cannot build as `notify`
       * is named, not silently lost.
       */
      if (this.exportedEntities !== null) {
        await this.exportedEntities.pruneDeleted()
        const { plan: entitiesPlan, withheld } = this.exportedEntities.plan(
          this.componentSupport.supportForAll([...enabled]),
        )
        if (withheld.length > 0) {
          this.ctx.logger.warn(
            'ha-export: notification targets withheld — the Home Assistant component does not build notify entities yet',
            { meta: { targetIds: withheld } },
          )
        }
        if (entitiesPlan !== null) {
          exported.set(entitiesPlan.deviceKey, {
            plan: entitiesPlan,
            deviceId: -1,
            target: { deviceId: -1, type: 'synthetic', boundCaps: [] },
            brokerIds: [...enabled],
            streams: [],
            cameraFunctions: null,
          })
          entityCount += Object.keys(entitiesPlan.cmps).length
        }
      }

      const synthetic = await this.buildSynthetic(byId)
      if (synthetic !== null) {
        for (const plan of syntheticPlans(synthetic)) {
          exported.set(plan.deviceKey, {
            plan,
            deviceId: -1,
            target: { deviceId: -1, type: 'synthetic', boundCaps: [] },
            brokerIds: [...enabled],
            // A synthetic device is a server surface, not a camera.
            streams: [],
            cameraFunctions: null,
          })
          entityCount += Object.keys(plan.cmps).length
        }
      }

      this.exported = exported
      this.keyByDeviceId = keyByDeviceId
      this.entityCount = entityCount
      this.unclassified = unclassifiedCaps([...allCaps])

      const fingerprint = structureFingerprint(exported)
      if (readsHeld) this.scheduleReadRetry()
      if (!fullResync && shouldSkipAnnounce(reason, fingerprint, this.lastStructureFingerprint)) {
        this.ctx.logger.debug('ha-export: structure unchanged, skipping announce', {
          meta: { devices: exported.size, entities: entityCount },
        })
        this.lastError = undefined
        return
      }
      this.lastStructureFingerprint = fingerprint

      for (const line of exportedDeviceLog) {
        this.ctx.logger.info('ha-export: exporting device', {
          tags: { deviceId: line.deviceId },
          meta: {
            deviceType: line.deviceType,
            deviceKey: line.deviceKey,
            brokers: line.brokers,
            entities: line.entities,
          },
        })
      }

      const delivered = await this.announce(exported, fullResync)
      await this.pushFullState(exported, snapshots)
      if (synthetic !== null) {
        await this.pushSynthetic(projectSynthetic(synthetic, Date.now()), [...enabled])
      }
      // A push that did not land leaves the receiver behind the fingerprint
      // we just stored: the next pass, whatever its reason, announces in full.
      if (!delivered || [...this.links.values()].some((link) => !link.client.healthy)) {
        this.resync.markGap('push-not-delivered')
        this.lastStructureFingerprint = undefined
        this.ctx.logger.warn('ha-export: a push was not delivered, the next pass is a full resync')
      }

      this.ctx.logger.info('ha-export: reconciled', {
        meta: {
          reason,
          fullResync,
          brokers: enabled.length,
          devices: exported.size,
          entities: entityCount,
          unclassifiedCaps: this.unclassified.length,
          durationMs: Date.now() - startedAt,
        },
      })
      if (this.unclassified.length > 0) {
        this.ctx.logger.warn('ha-export: capabilities in neither the map nor the exclusion list', {
          meta: { caps: this.unclassified },
        })
      }
      this.lastError = undefined
    } catch (err) {
      this.lastError = errMsg(err)
      this.resync.markGap('reconcile-failed')
      this.ctx.logger.warn('ha-export: reconcile failed', {
        meta: { error: this.lastError },
      })
    }
  }

  /**
   * Send every exported device's COMPLETE component set, per broker.
   *
   * Wrapped per device: a device whose plan cannot be announced degrades
   * that device only and can never take the loop — or the runner — down
   * with it.
   */
  /**
   * Gather the synthetic devices' statistics.
   *
   * Best-effort per source: one API that does not answer costs its own
   * entities for this pass, never the whole set — a hub whose
   * `notificationRules` provider is restarting must still export its cluster
   * health, which is exactly when an operator wants it.
   *
   * Returns `null` only when NOTHING answered, so the devices are not
   * announced empty on a hub that is still booting.
   */
  private async buildSynthetic(
    byId: ReadonlyMap<number, { readonly name: string }>,
  ): Promise<SyntheticInput | null> {
    const rules = await this.ctx.api.notificationRules.listRules
      .query({})
      .then((r) =>
        r.rules.map((rule) => ({
          id: rule.id,
          name: rule.name,
          enabled: rule.enabled,
        })),
      )
      .catch((err: unknown) => {
        this.ctx.logger.warn('ha-export: could not read notification rules', {
          meta: { error: errMsg(err) },
        })
        return null
      })
    const topology = await this.ctx.api.nodes.topology.query().catch((err: unknown): null => {
      this.ctx.logger.warn('ha-export: could not read the cluster topology', {
        meta: { error: errMsg(err) },
      })
      return null
    })
    const addons = await this.ctx.api.addons.list
      .query()
      .then((list) => {
        let running = 0
        let failed = 0
        for (const addon of list) {
          const phase = addon.health?.phase
          if (phase === 'failed') failed += 1
          else running += 1
        }
        return { running, failed }
      })
      .catch(() => null)
    // Unpinned = the hub's own answer. Also the source of `image_contract`
    // (Task D3): the hub's seed-vs-contract verdict rides the same payload.
    const server = await this.ctx.api.serverManagement.getServerPackageStatus
      .query()
      .catch(() => null)
    const alerts = await this.readActiveAlerts()

    if (rules === null && topology === null && addons === null && server === null) return null

    this.syntheticRules = rules ?? this.syntheticRules
    const effectiveRules = this.syntheticRules
    const { lastTrigger, lastTriggerByRule } = await this.buildLastTrigger(byId, effectiveRules)
    const { nodes, oldestFootageMs } = await this.buildSyntheticNodes(topology ?? [])

    return {
      rules: effectiveRules,

      lastTrigger,
      lastTriggerByRule,
      nodes,
      addonsRunning: addons?.running ?? 0,
      addonsFailed: addons?.failed ?? 0,
      serverVersion: server?.runningVersion ?? server?.activeVersion ?? 'unknown',
      updateAvailable: server?.updateAvailable ?? false,
      alertsActive: alerts.active,
      alertsActiveCount: alerts.count,
      alertsLastTitle: alerts.lastTitle,
      oldestFootageMs,
      imageContractState: server?.imageContract?.state ?? null,
    }
  }

  /**
   * The most recent notification-rule trigger, GLOBAL and PER RULE —
   * "conoscere gli ultimi trigger, le ultime immagini... e da quale label"
   * [know the latest triggers, the latest images... and from which label] (operator, 2026-08-25), extended to "l'ultimo trigger PER REGOLA, con
   * immagine e metadati" [the latest trigger PER RULE, with image and metadata] (operator, 2026-08-27).
   *
   * ONE `getHistory` read serves BOTH: `reduceLastTriggers`
   * (`rule-triggers.ts`) reduces the same newest-first page into "the very
   * first row" (global) and "the first row per rule id" (per rule) — never
   * a query per rule, which is exactly the shape a previous session spent
   * hours removing from the events path. `NC_HISTORY_LIMIT_MAX` (the cap's
   * own ceiling) is used rather than the global feature's old `limit: 1`,
   * so a page wide enough to find every rule's last trigger is fetched in
   * this one call.
   *
   * `rules` bounds the per-rule work to rules that still exist: a deleted
   * rule's row may still be in the page, but this never mints a signed URL
   * for it. `resolveArtifactUrl` calls this pass makes are therefore bounded
   * by the RULE count (~15 measured live), never by fleet size or history
   * depth — and de-duplicated by artefact id, since two rules matching the
   * same evaluated record can share one indexed still.
   *
   * Best-effort like every other synthetic source here: a failed read costs
   * only these entities, never the rest of the device.
   */
  private async buildLastTrigger(
    byId: ReadonlyMap<number, { readonly name: string }>,
    rules: readonly SyntheticRule[],
  ): Promise<{
    readonly lastTrigger: SyntheticLastTrigger | null
    readonly lastTriggerByRule: ReadonlyMap<string, SyntheticLastTrigger>
  }> {
    const NONE = { lastTrigger: null, lastTriggerByRule: new Map<string, SyntheticLastTrigger>() }
    try {
      const { entries } = await this.ctx.api.notificationRules.getHistory.query({
        filter: { limit: NC_HISTORY_LIMIT_MAX },
      })
      const rows: readonly HistoryRow[] = entries
      const { overall, byRule } = reduceLastTriggers(rows)

      const urlCache = new Map<string, string | null>()
      const resolveUrl = async (
        artifactId: string | null,
        deviceId: number,
      ): Promise<string | null> => {
        if (artifactId === null) return null
        const cached = urlCache.get(artifactId)
        if (cached !== undefined) return cached
        const url = await this.ctx.api.notificationRules.resolveArtifactUrl
          .query({ artifactId })
          .then((r) => r.url)
          .catch((err: unknown) => {
            this.ctx.logger.debug('ha-export: could not resolve a trigger image url', {
              tags: { deviceId },
              meta: { artifactId, error: errMsg(err) },
            })
            return null
          })
        urlCache.set(artifactId, url)
        return url
      }

      const toSynthetic = async (t: {
        readonly at: number
        readonly ruleName: string
        readonly deviceId: number
        readonly label: string
        readonly status: 'pending' | 'sent' | 'dead'
        readonly artifactId: string | null
      }): Promise<SyntheticLastTrigger> => ({
        at: t.at,
        ruleName: t.ruleName,
        deviceName: byId.get(t.deviceId)?.name ?? `camera ${t.deviceId}`,
        label: t.label,
        status: t.status,
        imageUrl: await resolveUrl(t.artifactId, t.deviceId),
      })

      const lastTrigger = overall === null ? null : await toSynthetic(overall)

      const lastTriggerByRule = new Map<string, SyntheticLastTrigger>()
      for (const rule of rules) {
        const reduced = byRule.get(rule.id)
        if (reduced === undefined) continue
        lastTriggerByRule.set(rule.id, await toSynthetic(reduced))
      }

      return { lastTrigger, lastTriggerByRule }
    } catch (err) {
      this.ctx.logger.warn('ha-export: could not read the last notification triggers', {
        meta: { error: errMsg(err) },
      })
      return NONE
    }
  }

  /**
   * `alerts.list` — the conditions nobody said (Task D1). Best-effort: a
   * failed read yields "nothing active", not a fabricated absence dressed up
   * as a clean one — this addon logs the drop rather than pretending the
   * cluster is quiet. The derivation itself is pure — see
   * `deriveAlertSummary` in `synthetic-devices.ts`, which is what is tested.
   */
  private async readActiveAlerts(): Promise<AlertSummary> {
    try {
      const alerts = await this.ctx.api.alerts.list.query({ unreadOnly: false, limit: 50 })
      return deriveAlertSummary(alerts)
    } catch (err) {
      this.ctx.logger.warn('ha-export: could not read alerts, the alert entities go quiet', {
        meta: { error: errMsg(err) },
      })
      return { active: false, count: 0, lastTitle: null }
    }
  }

  /**
   * Per-node disk usage (Task D2) and per-AGENT package status (Task D3).
   * `recording` is a singleton cap, so its usage is read ONCE, unpinned, and
   * attributed to the node the answer names (`footageForNode`); package
   * status is asked only of online agents (`shouldReadPackageStatus`). A node
   * that is not read stays `unknown` — unread, never failed.
   */
  private async buildSyntheticNodes(
    topology: readonly {
      readonly id: string
      readonly name: string
      readonly isOnline: boolean
      readonly cpuPercent: number
      readonly memoryPercent: number
      readonly uptime: number
      readonly isHub: boolean
      readonly rootPackage: { readonly version: string } | null
    }[],
  ): Promise<{
    readonly nodes: readonly SyntheticNode[]
    /** The minimum `oldestMs` across every device this pass could read (D2). */
    readonly oldestFootageMs: number | null
  }> {
    const usage = await this.ctx.api.recordingArchive.getStorageUsage
      .query({})
      .catch((err: unknown): null => {
        this.ctx.logger.warn(
          'ha-export: could not read storage usage, the footage entities go unknown',
          { meta: { error: errMsg(err) } },
        )
        return null
      })

    let oldestFootageMs: number | null = null
    for (const device of usage?.devices ?? []) {
      const oldest = device.oldestMs
      if (oldest === null || oldest === undefined) continue
      if (oldestFootageMs === null || oldest < oldestFootageMs) oldestFootageMs = oldest
    }

    const nodes = await Promise.all(
      topology.map(async (node): Promise<SyntheticNode> => {
        const footage = footageForNode(node.id, usage)
        const packageStatus = shouldReadPackageStatus(node)
          ? await this.ctx.api.serverManagement.getServerPackageStatus
              .query({ nodeId: node.id })
              .catch((err: unknown): null => {
                this.ctx.logger.warn(
                  'ha-export: could not read package status for an agent node, ' +
                    'its update entities go unknown',
                  { meta: { nodeId: node.id, error: errMsg(err) } },
                )
                return null
              })
          : null

        return {
          id: node.id,
          name: node.name,
          online: node.isOnline,
          cpuPercent: node.cpuPercent,
          memoryPercent: node.memoryPercent,
          // The topology reports MILLISECONDS (`Date.now() - connectedSince`).
          uptimeMs: node.uptime,
          isHub: node.isHub,
          footageUsedBytes: footage.footageUsedBytes,
          footageFreePercent: footage.footageFreePercent,
          rootPackageVersion: node.rootPackage?.version ?? null,
          updateAvailable: packageStatus?.updateAvailable ?? null,
        }
      }),
    )
    return { nodes, oldestFootageMs }
  }

  /** Push the synthetic values to every enabled broker. */
  private async pushSynthetic(
    values: readonly StateValue[],
    brokerIds: readonly string[],
  ): Promise<void> {
    for (const brokerId of brokerIds) {
      const link = this.links.get(brokerId)
      if (link === undefined) continue
      for (const value of values) link.client.publishState(value.topic, value.value)
    }
  }

  /** `false` when any announce was not delivered. */
  private async announce(
    exported: ReadonlyMap<string, ExportedDevice>,
    full: boolean,
  ): Promise<boolean> {
    let allDelivered = true
    for (const entry of exported.values()) {
      for (const brokerId of entry.brokerIds) {
        const link = this.links.get(brokerId)
        if (link === undefined) continue
        try {
          const ok = await link.client.publishEntityChange(
            entry.plan.deviceKey,
            entry.plan.cmps,
            entry.plan.dev,
            full,
          )
          if (!ok) allDelivered = false
        } catch (err) {
          allDelivered = false
          this.ctx.logger.warn('ha-export: could not announce a device, skipping it', {
            tags: { deviceId: entry.deviceId },
            meta: { brokerId, error: errMsg(err) },
          })
        }
      }
    }
    return allDelivered
  }

  private async pushFullState(
    exported: ReadonlyMap<string, ExportedDevice>,
    snapshots: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    for (const entry of exported.values()) {
      try {
        const values = await this.currentStateFor(entry, snapshots[String(entry.deviceId)])
        this.push(entry.deviceId, values)
      } catch (err) {
        this.ctx.logger.warn('ha-export: could not read current state for a device', {
          tags: { deviceId: entry.deviceId },
          meta: { error: errMsg(err) },
        })
      }
    }
    for (const link of this.links.values()) await link.client.flush()
  }

  /** Everything readable without waiting for an event. */
  private async currentStateFor(
    entry: ExportedDevice,
    snapshotRaw: unknown,
  ): Promise<readonly StateValue[]> {
    const key = entry.plan.deviceKey
    const values: StateValue[] = []
    const snapshot = toSnapshot(snapshotRaw)

    const status = snapshot['device-status']
    const online = status?.['online']
    if (typeof online === 'boolean') values.push(...projectDeviceStatus(key, online))

    const link = snapshot['network-link']
    if (link !== undefined) {
      const type = readString(link, 'type')
      if (type !== null) {
        values.push(
          ...projectNetworkLinkSlice(key, {
            type,
            signalPercent: readNumber(link, 'signal'),
          }),
        )
      }
    }

    const battery = snapshot['battery']
    if (battery !== undefined) {
      const percentage = readNumber(battery, 'level')
      const charging = readString(battery, 'charging')
      const sleeping = battery['sleeping']
      if (percentage !== null && charging !== null && typeof sleeping === 'boolean') {
        const binary = battery['binary']
        values.push(
          ...projectBatterySlice(key, {
            percentage,
            charging,
            sleeping,
            ...(typeof binary === 'boolean' ? { binary } : {}),
          }),
        )
      }
    }

    /**
     * The derived half, from the snapshot the reconcile already read.
     *
     * The reconcile is the CONTRACT — events are an optimisation over it
     * (D8) — so every entity it announces must also get a value from it.
     * It used to push only `device-status` and `battery`, which is why a
     * derived entity whose event path was missing stayed blank for ever
     * rather than for one interval.
     */
    {
      /**
       * The derived half, and the two capabilities a CAMERA carries from
       * it (`CAMERA_DERIVED_CAPS`). A camera takes the hand-written
       * catalog, so every other cap slice on one addresses no component;
       * these two do, because the camera catalog builds them from the
       * same descriptor and the same entity id.
       */
      const isCamera = entry.target.type === 'camera'
      for (const [capName, capSlice] of Object.entries(snapshot)) {
        if (capName === 'device-status' || capName === 'battery') continue
        if (isItemEntityCap(capName)) {
          values.push(...this.announcedItemValues(entry, capName, capSlice))
          continue
        }
        if (isCamera && !CAMERA_DERIVED_CAPS.includes(capName)) continue
        const projection = projectCapSlice(key, capName, capSlice)
        if (projection.kind === 'values') values.push(...projection.values)
        else if (projection.kind === 'missing-field') {
          this.warnOnce(entry.deviceId, capName, projection.field, {
            message: 'ha-export: a derived entity reads a field its slice does not carry',
            meta: {
              capName,
              field: projection.field,
              sliceFields: projection.sliceFields,
            },
          })
        } else if (projection.kind === 'unrenderable') {
          this.warnOnce(entry.deviceId, capName, projection.field, {
            message: 'ha-export: a derived entity cannot render the value its slice carries',
            meta: {
              capName,
              field: projection.field,
              valueType: projection.valueType,
            },
          })
        }
      }
    }

    if (entry.target.type === 'camera') {
      /**
       * The live picture publishes NOTHING here, deliberately. A `camera`
       * entity's whole content is its `stream_target`, which travelled with
       * the announce; the component fetches the still and negotiates the
       * video itself. The url this block used to publish was read by
       * nobody — see `camera-entities.ts`.
       */
      values.push(...projectCameraFunctions(key, entry.cameraFunctions ?? []))

      /**
       * `status` / `recording_active` (Traccia C) — off the SAME
       * `CameraStatus` `runReconcile` already read once for the whole pass
       * (Task C3). A camera the batch read did not cover (the call failed
       * entirely, or a camera added mid-pass) publishes NEITHER: an invented
       * `ok` is the D62 failure this entity exists to prevent.
       */
      const cameraStatus = this.cameraStatusByDeviceId.get(entry.deviceId)
      if (cameraStatus !== undefined) {
        values.push(...projectCameraStatus(key, toCameraStatusInput(cameraStatus)))
      }

      const occupancy = await this.ctx.api.zoneAnalytics.getCurrentSnapshot.query({
        deviceId: entry.deviceId,
      })
      if (occupancy !== null) {
        values.push(
          ...projectZoneOccupancy(key, {
            zones: occupancy.zones.map((zone) => ({
              zoneId: zone.zoneId,
              totalObjects: zone.totalObjects,
              byClass: toCountRecord(zone.byClass),
            })),
            scene: {
              totalObjects: occupancy.frame.totalObjects,
              byClass: toCountRecord(occupancy.frame.byClass),
            },
          }),
        )
      }
    }

    return values
  }

  /**
   * `device: null` = a part of this device's component set cannot be read and
   * nothing was ever exported for it, so the device is not announced this pass
   * (an empty part would make Home Assistant delete what it holds). `heldBack`
   * = at least one part is not a fresh answer, so a retry is worth arming.
   */
  private async buildCatalogDevice(
    device: {
      id: number
      name: string
      type: string
      features: readonly string[]
      metadata?: Readonly<Record<string, unknown>> | null
      sourceInfo?: { readonly quantity?: string }
    },
    snapshotRaw: unknown,
    /**
     * The SAME collection `runReconcile` already read for this pass
     * (Task A1/A3) — never re-fetched here. `null` for a non-camera.
     */
    cameraFunctions: readonly CameraFunction[] | null,
    /** Why the function authorities did not all answer, or `null`. */
    functionsFailure: string | null,
  ): Promise<{
    readonly device: CatalogDevice | null
    readonly heldBack: boolean
  }> {
    const snapshot = toSnapshot(snapshotRaw)
    let heldBack = false
    let unknown = false
    const settle = <T>(
      part: string,
      mirror: ReadMirror<T>,
      outcome: ReadOutcome<T>,
    ): readonly T[] => {
      const resolution = mirror.resolve(device.id, outcome)
      if (resolution.status !== 'fresh') heldBack = true
      if (resolution.status === 'unknown') unknown = true
      this.logHeldRead(device.id, part, resolution)
      return resolution.status === 'unknown' ? [] : resolution.items
    }

    const boundCaps = settle('boundCaps', this.boundCapsMirror, await this.loadBoundCaps(device.id))
    const zones =
      device.type === 'camera'
        ? settle('zones', this.zonesMirror, await this.loadZones(device.id))
        : []
    /**
     * Every camera function, available or not — `entity-catalog.ts` is the
     * one place that filters to `available`, exactly as it did for
     * `getCameraSwitches`'s answer. A function that did not answer is
     * "unavailable", which removes its entity, so the set goes through the
     * mirror: held when a source failed, shrunk only on two agreeing passes.
     */
    const mappedSwitches: readonly CatalogFunctionSwitch[] = (cameraFunctions ?? []).map((fn) => ({
      id: fn.id,
      label: fn.label,
      available: fn.available,
    }))
    const switches =
      cameraFunctions === null
        ? mappedSwitches
        : settle<CatalogFunctionSwitch>(
            'cameraFunctions',
            this.switchesMirror,
            functionsFailure !== null
              ? { kind: 'failed', reason: functionsFailure }
              : {
                  kind: 'answered',
                  items: mappedSwitches.filter((fn) => fn.available),
                },
          )
    const ptzPresets =
      device.type === 'camera'
        ? settle(
            'ptzPresets',
            this.presetsMirror,
            boundCaps.includes('ptz')
              ? await this.loadPresets(device.id)
              : { kind: 'answered', items: [] },
          )
        : []
    const streams =
      device.type === 'camera'
        ? settle(
            'streams',
            this.streamsMirror,
            boundCaps.includes('webrtc-session')
              ? await this.loadStreamChoices(device.id)
              : { kind: 'answered', items: [] },
          )
        : []
    if (unknown) return { device: null, heldBack }
    const items = this.settleItemEntities(device.id, boundCaps, snapshot)
    if (items.held) heldBack = true
    const manufacturer = readString(device.metadata ?? {}, 'manufacturer')
    const model = readString(device.metadata ?? {}, 'model')
    const readingQuantity = device.sourceInfo?.quantity
    const catalogDevice: CatalogDevice = {
      id: device.id,
      name: device.name,
      type: device.type,
      ...(manufacturer !== null ? { manufacturer } : {}),
      ...(model !== null ? { model } : {}),
      features: device.features,
      boundCaps,
      zones,
      switches,
      ptzPresets,
      streams,
      slices: Object.keys(snapshot),
      /**
       * The slice VALUES, for the native platforms only: a native
       * `climate` announces the modes the device accepts, and
       * `availableModes` is on the slice and nowhere else. See
       * `CatalogDevice.capSlices`.
       */
      capSlices: snapshot,
      itemEntities: items.entities,
      ...(isReadingQuantity(readingQuantity) ? { readingQuantity } : {}),
    }
    return { device: catalogDevice, heldBack }
  }

  /**
   * The per-item entities of every per-item capability the device binds,
   * through each capability's mirror.
   *
   * An ABSENT slice is an answer — the capability is inert until a provider
   * sets items — so it reads as "no items", and a set that was announced
   * shrinks only when the next read agrees. A slice that is not the
   * capability's shape is a failed read: the held set is announced again,
   * and with nothing held the device is announced WITHOUT those entities
   * rather than held back whole, because a malformed consumables slice must
   * not take a vacuum's every other entity out of Home Assistant.
   */
  private settleItemEntities(
    deviceId: number,
    boundCaps: readonly string[],
    snapshot: Readonly<Record<string, SliceRecord>>,
  ): ItemEntitySettlement {
    const entities: Record<string, readonly ItemEntity[]> = {}
    let held = false
    for (const cap of boundCaps) {
      const mirror = this.itemEntityMirrors.get(cap)
      if (mirror === undefined) continue
      const slice = snapshot[cap]
      const minted = slice === undefined ? [] : itemEntitiesFor(cap, slice)
      const outcome: ReadOutcome<ItemEntity> =
        minted === null
          ? { kind: 'failed', reason: `the ${cap} slice is not the capability shape` }
          : { kind: 'answered', items: minted }
      const resolution = mirror.resolve(deviceId, outcome)
      if (resolution.status === 'unknown') {
        this.ctx.logger.warn(
          'ha-export: a per-item slice is not the capability shape and nothing was exported yet, announcing the device without its items',
          { tags: { deviceId }, meta: { capName: cap, reason: resolution.reason } },
        )
        entities[cap] = []
        continue
      }
      if (resolution.status !== 'fresh') held = true
      this.logHeldRead(deviceId, cap, resolution)
      entities[cap] = resolution.items
    }
    return { entities, held }
  }

  /** One WARN per held part, with the device tag and the reason. */
  private logHeldRead(deviceId: number, part: string, resolution: MirrorResolution<unknown>): void {
    if (resolution.status === 'fresh') return
    const kept = resolution.status === 'unknown' ? 0 : resolution.items.length
    const message =
      resolution.status === 'unknown'
        ? 'ha-export: a read did not answer and nothing was exported yet, the device is not announced this pass'
        : resolution.status === 'held-failed'
          ? 'ha-export: a read did not answer, keeping the last exported components'
          : 'ha-export: a read dropped components, keeping them until a second answer agrees'
    this.ctx.logger.warn(message, {
      tags: { deviceId },
      meta: { part, reason: resolution.reason, kept },
    })
  }

  /** Retry soon after a held-back read: the provider usually registers seconds later. */
  private scheduleReadRetry(): void {
    if (this.readTimer !== null) return
    this.readTimer = setTimeout(() => {
      this.readTimer = null
      void this.reconcile('read-retry')
    }, READ_RETRY_MS)
  }

  /**
   * Every stream of the camera, as the hub's own picker lists them.
   *
   * `webrtcSession.listStreams` rather than
   * `cameraStreams.getProfileRtspEntries`: the component negotiates live
   * video through `webrtcSession.handleOffer` and needs the `target`, not
   * an address. Reading the RTSP entries instead cost this export three
   * things it no longer pays — a `hostname` argument (the broker binds
   * `127.0.0.1`, so a camera on a hub with no reachable base url got NO
   * camera entity at all), a refusal for a credentialed url, and a whole
   * value plane nothing consumed.
   *
   * `listStreams` also reports the camera's raw substreams, which the
   * profile view could not express.
   */
  private async loadStreamChoices(deviceId: number): Promise<ReadOutcome<CatalogStreamChoice>> {
    try {
      const choices = await this.ctx.api.webrtcSession.listStreams.query({
        deviceId,
      })
      return {
        kind: 'answered',
        items: choices.map((choice) => ({
          id: choice.id,
          label: choice.label,
          target: choice.target,
          ...(choice.resolution === null ? {} : { height: choice.resolution.height }),
        })),
      }
    } catch (err) {
      return { kind: 'failed', reason: errMsg(err) }
    }
  }

  private async loadBoundCaps(deviceId: number): Promise<ReadOutcome<string>> {
    try {
      const bindings = await this.ctx.api.deviceManager.getBindings.query({
        deviceId,
      })
      return {
        kind: 'answered',
        items: bindings.entries.map((entry) => entry.capName),
      }
    } catch (err) {
      return { kind: 'failed', reason: errMsg(err) }
    }
  }

  private async loadZones(deviceId: number): Promise<ReadOutcome<CatalogZone>> {
    try {
      const snapshot = await this.ctx.api.zoneAnalytics.getCurrentSnapshot.query({ deviceId })
      if (snapshot === null) return { kind: 'answered', items: [] }
      return {
        kind: 'answered',
        items: snapshot.zones.map((zone) => ({
          id: zone.zoneId,
          name: zone.zoneName,
        })),
      }
    } catch (err) {
      return { kind: 'failed', reason: errMsg(err) }
    }
  }

  /**
   * `pipelineOrchestrator.getCameraStatuses`, for every exported camera in
   * ONE call (Task C3). Best-effort for the WHOLE batch: a failure here means
   * `status`, `recording_active` and every `broker-audio` control degrade for
   * this pass — never a value invented from a previous pass's answer.
   */
  private async readCameraStatuses(
    deviceIds: readonly number[],
  ): Promise<Map<number, CameraStatus>> {
    if (deviceIds.length === 0) return new Map()
    const startedAt = Date.now()
    try {
      const statuses = await this.ctx.api.pipelineOrchestrator.getCameraStatuses.query({
        deviceIds: [...deviceIds],
      })
      this.ctx.logger.debug('ha-export: read camera statuses for the pass', {
        meta: { cameraStatusMs: Date.now() - startedAt, cameras: deviceIds.length },
      })
      return new Map(statuses.map((status) => [status.deviceId, status]))
    } catch (err) {
      this.ctx.logger.warn(
        'ha-export: could not read camera statuses — status, recording_active and ' +
          'broker-audio degrade for every exported camera this pass',
        { meta: { error: errMsg(err), cameras: deviceIds.length } },
      )
      return new Map()
    }
  }

  /**
   * The eight per-camera function authorities (Task A1), assembled into
   * {@link CameraFunctionReads}. Every source degrades INDEPENDENTLY with a
   * WARN carrying `tags: { deviceId }` — a dropped authority must never look
   * like "this function does not exist" (D62).
   *
   * `bindableCapsByType`/`mutedDeviceIds` are the reconcile pass's shared
   * caches when the caller has them (a per-TYPE lookup and a flat list read
   * once for the whole pass); omitted, each is read fresh — the one-off
   * command path (`dispatch`) has no pass to share.
   */
  private async readCameraFunctions(input: {
    readonly deviceId: number
    readonly deviceType: string
    readonly deviceDisabled: boolean
    readonly privacySlice: SliceRecord | undefined
    readonly sourceNodeId: string | null
    readonly bindableCapsByType?: Map<string, readonly string[] | null>
    readonly mutedDeviceIds?: readonly number[] | null
  }): Promise<CameraFunctionReads> {
    const { deviceId, deviceType, deviceDisabled, privacySlice, sourceNodeId } = input
    const bindableCache = input.bindableCapsByType

    let bindableCapNames = bindableCache?.get(deviceType)
    if (bindableCache === undefined || bindableCapNames === undefined) {
      bindableCapNames = await this.ctx.api.deviceManager.listBindableCapsForDeviceType
        .query({ deviceType })
        .then((entries) => entries.filter((e) => e.wrappers.length > 0).map((e) => e.capName))
        .catch((err: unknown): null => {
          this.ctx.logger.warn(
            'ha-export: could not read bindable caps for a device type, camera functions degrade',
            { tags: { deviceId }, meta: { deviceType, error: errMsg(err) } },
          )
          return null
        })
      bindableCache?.set(deviceType, bindableCapNames)
    }

    const wrapperAddonIdByCap = new Map<string, string>()
    const wrappedCapNames = await this.ctx.api.deviceManager.getBindings
      .query({ deviceId })
      .then((bindings) => {
        const active: string[] = []
        for (const entry of bindings.entries) {
          if (entry.kind !== 'wrapped') continue
          active.push(entry.capName)
          if (entry.providerAddonId !== '')
            wrapperAddonIdByCap.set(entry.capName, entry.providerAddonId)
        }
        return active
      })
      .catch((err: unknown): null => {
        this.ctx.logger.warn('ha-export: could not read bindings, camera functions degrade', {
          tags: { deviceId },
          meta: { error: errMsg(err) },
        })
        return null
      })

    const recordingEnabled = await this.ctx.api.recordingArchive.getDeviceConfig
      .query({ deviceId })
      .then((config) => config.enabled)
      .catch((err: unknown): null => {
        this.ctx.logger.warn(
          'ha-export: could not read recording config, the recording function degrades',
          { tags: { deviceId }, meta: { error: errMsg(err) } },
        )
        return null
      })

    const mutedDeviceIds =
      input.mutedDeviceIds !== undefined
        ? input.mutedDeviceIds
        : await this.ctx.api.notificationRules.listDeviceMutes
            .query({})
            .then((r) => r.mutedDeviceIds)
            .catch((err: unknown): null => {
              this.ctx.logger.warn(
                'ha-export: could not read notification mutes, the notifications function degrades',
                { tags: { deviceId }, meta: { error: errMsg(err) } },
              )
              return null
            })
    const notificationsMuted = mutedDeviceIds === null ? null : mutedDeviceIds.includes(deviceId)

    /**
     * The `privacy-mask` slice already in the snapshot this pass downloaded
     * (D224: a camera fact's freshness lives in the provider that owns it) —
     * zero new dialers to the camera.
     */
    const privacy: CameraPrivacyReads | null =
      privacySlice === undefined
        ? null
        : {
            maskEnabled: privacySlice['enabled'] === true,
            audioEnabled:
              typeof privacySlice['audioEnabled'] === 'boolean'
                ? privacySlice['audioEnabled']
                : null,
          }

    const brokerAudioMuted =
      sourceNodeId === null
        ? null
        : await this.ctx.api.streamBroker.getDeviceAudioMute
            .query({ deviceId }, nodePin(sourceNodeId))
            .then((r) => r.muted)
            .catch((err: unknown): null => {
              this.ctx.logger.warn(
                'ha-export: could not read broker audio mute, the broker-audio function degrades',
                { tags: { deviceId }, meta: { sourceNodeId, error: errMsg(err) } },
              )
              return null
            })

    return {
      deviceDisabled,
      bindableCapNames,
      wrappedCapNames,
      wrapperAddonIdByCap,
      recordingEnabled,
      notificationsMuted,
      privacy,
      brokerAudioMuted,
    }
  }

  private async loadPresets(deviceId: number): Promise<ReadOutcome<string>> {
    try {
      const device = await this.ctx.fetchDevice(deviceId)
      if (device.ptz === undefined) return { kind: 'answered', items: [] }
      const presets = await device.ptz.getPresets({})
      return { kind: 'answered', items: presets.map((preset) => preset.name) }
    } catch (err) {
      return { kind: 'failed', reason: errMsg(err) }
    }
  }

  // ── Brokers ─────────────────────────────────────────────────────────

  /**
   * Resolve every Home Assistant broker, and open a push client for the
   * ones the operator ticked.
   *
   * Credentials come through the `broker` cap — the sanctioned no-import
   * path — and EVERY call carries the owning `addonId`: `broker` is a
   * COLLECTION cap, so an unpinned call is answered by the
   * first-registered provider (Homematic, on the operator's hub), which
   * knows nothing about `ha_*`. `broker-source.ts` holds the pin and the
   * reasoning.
   */
  private async refreshBrokers(): Promise<void> {
    const haBrokers = await listHomeAssistantBrokers((input) =>
      this.ctx.api.broker.list.query(input),
    )
    const known: KnownBroker[] = haBrokers.map((broker) => ({
      id: broker.id,
      name: broker.name,
    }))

    /**
     * NEVER prune on an empty enumeration.
     *
     * `broker.list` is a fan-out union, so it answers `[]` for the whole window
     * in which `provider-homeassistant` has not finished registering — and it
     * registers its caps only at the END of an `initialize()` that restores 239
     * devices. An empty list there means "I do not know yet", never "the
     * operator deleted their instance", and the two were indistinguishable to
     * this code: every boot pruned the membership to nothing and PERSISTED it,
     * so the operator's exported cameras silently switched themselves off. Seen
     * live on 2026-08-09 — two cameras exposed, `devices=4`, addon redeployed,
     * `devices=2` and both switches back to `false` with no line anywhere.
     *
     * This is D49 exactly: a destructive step gated on a fallible read must not
     * fire on the reading that destroys work. A broker that really was deleted
     * is pruned on the next pass that returns a NON-empty list without it,
     * which costs one interval and cannot cost the operator their config.
     */
    const pruned =
      haBrokers.length === 0
        ? this.config.membership
        : pruneBrokers(
            this.config.membership,
            haBrokers.map((broker) => broker.id),
          )
    if (haBrokers.length === 0 && Object.keys(this.config.membership).length > 0) {
      this.ctx.logger.warn(
        'ha-export: no Home Assistant broker answered — keeping the export membership rather than pruning it',
        { meta: { brokers: Object.keys(this.config.membership) } },
      )
    }
    /**
     * ONE key per thing that actually changed — see `brokerRefreshPatch`.
     *
     * This used to write `knownBrokers` and `membership` together whenever
     * EITHER differed. A boot-window settings read that answers empty leaves
     * `this.config` on its constructor defaults, and that joint write then
     * persisted `membership: {}` over the operator's real export list on a
     * pass whose only news was the broker roster. It cost this hub three days
     * of Home Assistant: 2026-08-24 21:55:13.
     */
    const patch = brokerRefreshPatch(
      { knownBrokers: this.config.knownBrokers, membership: this.config.membership },
      { knownBrokers: known, membership: pruned },
    )
    if (patch !== null) {
      await this.updateGlobalSettings(patch)
    }
    await this.refreshEnabledBrokers(known)

    const wanted = new Set(this.enabledBrokerIds())
    for (const [brokerId, link] of this.links) {
      if (wanted.has(brokerId)) continue
      await link.client.dispose()
      this.links.delete(brokerId)
      // A broker that comes back is a component that may have been updated
      // while it was gone; nothing negotiated survives its absence.
      this.componentSupport.forget(brokerId)
      this.ctx.logger.info('ha-export: stopped exporting to a broker', {
        meta: { brokerId },
      })
    }

    for (const broker of haBrokers) {
      if (!wanted.has(broker.id)) continue
      if (this.links.has(broker.id)) continue
      const resolved = await this.resolveBrokerConnection(broker.id, broker.addonId)
      if (resolved === null) continue
      const client = new PushClient({
        transport: (message) => postToHomeAssistant(resolved.baseUrl, resolved.token, message),
        logger: this.ctx.logger,
        brokerId: broker.id,
        onLinkRestored: (brokerId) => this.reachability.request(brokerId),
      })
      client.start()
      // A link opened now has an empty dedup cache and a receiver we have not
      // spoken to: the pass that follows is a full resync.
      this.resync.markGap('broker-connected')
      this.links.set(broker.id, {
        brokerId: broker.id,
        name: broker.name,
        baseUrl: resolved.baseUrl,
        token: resolved.token,
        client,
      })
      this.ctx.logger.info('ha-export: exporting to Home Assistant', {
        meta: { brokerId: broker.id, baseUrl: resolved.baseUrl },
      })
    }
  }

  /**
   * Ask every live link what its component builds.
   *
   * Sequential and cheap — one GET per Home Assistant per reconcile, and
   * there is one Home Assistant on almost every installation. A link that
   * does not answer keeps whatever was negotiated last: the tracker treats
   * silence as no information, because the alternative is that one
   * timeout migrates every native entity back to a sensor.
   */
  private async refreshComponentSupport(): Promise<void> {
    for (const [brokerId, link] of this.links) {
      const probe = await this.probeComponent(link)
      const change = this.componentSupport.observe(brokerId, probe)
      if (change.withheldDowngrade) {
        /**
         * D49. The read that DESTROYS work needs a second read to agree,
         * and the operator gets to see that this is what happened rather
         * than watching their entities migrate on one bad answer.
         */
        this.ctx.logger.warn(
          'ha-export: the Home Assistant component reports fewer platforms than before — holding the old set until a second read agrees',
          {
            meta: {
              brokerId,
              current: supportSignature(change.support),
              reported:
                probe.kind === 'reported' ? supportSignature(probe.report.platforms) : 'none',
            },
          },
        )
        continue
      }
      if (!change.changed) continue
      this.ctx.logger.info('ha-export: negotiated the Home Assistant component platform set', {
        meta: {
          brokerId,
          componentVersion:
            probe.kind === 'reported' ? (probe.report.version ?? 'unknown') : 'pre-0.4.0',
          platforms: supportSignature(change.support),
        },
      })
    }
  }

  /**
   * One `GET /api/camstack/version`, turned into the three answers the
   * tracker distinguishes.
   *
   * A 404 is the OLD component saying it has no such endpoint, which is
   * information. Anything else — a timeout, a 500, a rotated token — is
   * not, and must not be read as one.
   */
  private async probeComponent(link: BrokerLink): Promise<ComponentProbe> {
    try {
      const response = await fetch(`${link.baseUrl.replace(/\/+$/, '')}${COMPONENT_VERSION_PATH}`, {
        headers: { authorization: `Bearer ${link.token}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (response.status === 404 || response.status === 405) return { kind: 'absent' }
      if (!response.ok)
        return {
          kind: 'unknown',
          error: `Home Assistant answered ${response.status}`,
        }
      const report = parseComponentReport(await response.json())
      if (report === null) {
        return {
          kind: 'unknown',
          error: 'the component answered without a platform list',
        }
      }
      return { kind: 'reported', report }
    } catch (err) {
      return { kind: 'unknown', error: errMsg(err) }
    }
  }

  private async resolveBrokerConnection(
    brokerId: string,
    addonId: string,
  ): Promise<{ baseUrl: string; token: string } | null> {
    try {
      const raw = await this.ctx.api.broker.getBrokerConfig.query({
        id: brokerId,
        addonId,
      })
      if (raw === null) {
        this.ctx.logger.warn('ha-export: broker returned no configuration, not exporting to it', {
          meta: { brokerId },
        })
        return null
      }
      const supervisorToken = readString(raw, 'supervisorToken')
      if (supervisorToken !== null) {
        /**
         * A Home Assistant OS install has no `baseUrl` — the supervisor
         * proxies Core on a fixed internal address. Handling this branch
         * is the difference between working and pushing at `undefined`.
         */
        return { baseUrl: 'http://supervisor/core', token: supervisorToken }
      }
      const baseUrl = readString(raw, 'baseUrl')
      const accessToken = readString(raw, 'accessToken')
      if (baseUrl === null || accessToken === null) {
        this.ctx.logger.warn('ha-export: broker configuration has no URL or token, skipping it', {
          meta: { brokerId },
        })
        return null
      }
      return { baseUrl, token: accessToken }
    } catch (err) {
      this.ctx.logger.warn('ha-export: could not read broker configuration', {
        meta: { brokerId, error: errMsg(err) },
      })
      return null
    }
  }

  /**
   * The brokers switched on, as of the last {@link refreshEnabledBrokers}.
   *
   * NOT read from `this.config`: `exportTo:<brokerId>` is a dynamic key and
   * `BaseAddon.resolveConfig` copies only keys present in `DEFAULT_CONFIG`, so
   * it is `undefined` there for ever — see `enabledBrokerIds` in
   * `membership.ts` for what that cost. The store is the authority; this is a
   * read-through cache of it, refreshed at the top of every reconcile pass and
   * before the per-device panel renders, never written to.
   */
  private enabled: readonly string[] = []

  private async refreshEnabledBrokers(known: readonly KnownBroker[]): Promise<void> {
    const store = await this.resolveGlobalStore()
    this.enabled = enabledBrokerIds(
      store,
      known.map((broker) => broker.id),
    )
  }

  private enabledBrokerIds(): readonly string[] {
    return this.enabled
  }

  private brokerName(brokerId: string): string {
    return this.config.knownBrokers.find((broker) => broker.id === brokerId)?.name ?? brokerId
  }

  // ── Commands ────────────────────────────────────────────────────────

  private async handleCommandRoute(
    body: unknown,
    reply: { status(code: number): unknown; send(payload: unknown): unknown },
  ): Promise<void> {
    const topic = readString(body, 'topic')
    const value = readString(body, 'value')
    if (topic === null || value === null) {
      reply.status(422)
      reply.send({ error: 'expected {topic, value}' })
      return
    }
    const parsed = parseCommandTopic(topic)
    if (parsed === null) {
      this.ctx.logger.warn('ha-export: dropping a command on a malformed topic', {
        meta: { topic },
      })
      reply.status(422)
      reply.send({ error: 'malformed topic' })
      return
    }
    const exported = this.exported.get(parsed.deviceKey)
    if (exported === undefined) {
      this.ctx.logger.warn('ha-export: dropping a command for a device that is not exported', {
        meta: { topic, deviceKey: parsed.deviceKey },
      })
      reply.status(422)
      reply.send({ error: 'device not exported' })
      return
    }
    /**
     * A synthetic device has no camstack device behind it, so
     * `resolveCommand` — which routes by device type and bound caps — cannot
     * speak for it. Its commands go straight to the authority that already
     * owns the function, exactly as a camera switch does: the export writes
     * `setRuleEnabled`, never a store of its own. A second knob that can
     * disagree with the admin UI is worse than no knob (D62).
     */
    if (
      this.exportedEntities !== null &&
      parsed.deviceKey === syntheticDeviceKeyFor(EXPORTED_ENTITIES_STABLE_ID)
    ) {
      const outcome = await this.exportedEntities.handleCommand(parsed.entity, value)
      if (!outcome.handled) {
        this.ctx.logger.warn('ha-export: dropping a command for an entity that is not exported', {
          meta: { topic, entity: parsed.entity },
        })
        reply.status(422)
        reply.send({ error: 'entity not exported' })
        return
      }
      reply.status(outcome.applied ? 200 : 422)
      reply.send(outcome.applied ? {} : { error: 'command not applied' })
      return
    }
    if (isSyntheticDeviceKey(parsed.deviceKey)) {
      const ruleId = ruleIdFromEntity(parsed.entity, this.syntheticRules)
      if (ruleId === null) {
        this.ctx.logger.warn(
          'ha-export: dropping a synthetic command with no authority behind it',
          {
            meta: { topic, entity: parsed.entity },
          },
        )
        reply.status(422)
        reply.send({ error: 'unroutable command' })
        return
      }
      const enabled = value.toLowerCase() === 'true'
      try {
        await this.ctx.api.notificationRules.setRuleEnabled.mutate({
          ruleId,
          enabled,
        })
        this.ctx.logger.info('ha-export: notification rule toggled from Home Assistant', {
          meta: { ruleId, enabled },
        })
        // Publish the new value at once rather than waiting for the next
        // reconcile: HA's optimistic switch would otherwise snap back if the
        // operator looked at it within the interval.
        await this.reconcile('synthetic-command')
        reply.status(200)
        reply.send({})
      } catch (err) {
        this.ctx.logger.warn('ha-export: could not apply a notification-rule toggle', {
          meta: { ruleId, enabled, error: errMsg(err) },
        })
        reply.status(422)
        reply.send({ error: 'command not applied' })
      }
      return
    }
    const resolution = resolveCommand(exported.target, parsed.entity, value)
    if (!resolution.ok) {
      /**
       * The reason is NAMED. "Unroutable" covered five different faults —
       * a typo in a topic, a capability the device does not declare, a
       * payload the platform cannot carry, and a control the catalog
       * advertised with no route behind it — and an operator watching a
       * switch snap back in Home Assistant could not tell which.
       */
      this.ctx.logger.warn('ha-export: dropping a command it cannot route', {
        tags: { deviceId: exported.deviceId },
        meta: {
          topic,
          entity: parsed.entity,
          reason: resolution.reason,
          ...(resolution.capName !== undefined ? { capName: resolution.capName } : {}),
        },
      })
      reply.status(422)
      reply.send({ error: `unroutable command (${resolution.reason})` })
      return
    }
    const applied = await this.dispatch(resolution.command)
    reply.status(applied ? 200 : 422)
    reply.send(applied ? {} : { error: 'command not applied' })
  }

  private async dispatch(command: ExportCommand): Promise<boolean> {
    try {
      /**
       * The capability half goes through the route table that NAMED the
       * method — `lockControl.lock`, `brightness.setBrightness`,
       * `alarmPanel.arm`, `switch.setState`. It used to end here
       * regardless of the capability, calling `device.switch.setState`
       * for all of them, so a lock got `noProvider` and a 422 and a
       * brightness command never arrived at all.
       */
      if (isCapCommand(command)) {
        const device = await this.ctx.fetchDevice(command.deviceId)
        const outcome = await applyCapCommand(device, command)
        if (outcome.ok) return true
        if (outcome.reason === 'no-provider') {
          return this.noProvider(command.deviceId, outcome.capName)
        }
        this.ctx.logger.warn('ha-export: the device refused the command', {
          tags: { deviceId: command.deviceId },
          meta: {
            capName: outcome.capName,
            kind: command.kind,
            ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          },
        })
        return false
      }
      switch (command.kind) {
        case 'camera-function': {
          const parsed = CameraSwitchIdSchema.safeParse(command.switchId)
          if (!parsed.success) {
            this.ctx.logger.warn('ha-export: dropping a command for an unknown camera function', {
              tags: { deviceId: command.deviceId },
              meta: { switchId: command.switchId },
            })
            return false
          }
          /**
           * A FRESH read for this one device — the pass-level caches are up to
           * `reconcileIntervalSec` old, and an availability decision that
           * writes belongs to the moment of the command, not the last poll.
           */
          const device = await this.ctx.api.deviceManager.getDevice.query({
            deviceId: command.deviceId,
          })
          if (device === null) {
            this.ctx.logger.warn(
              'ha-export: dropping a camera-function command, the device is not in the registry',
              { tags: { deviceId: command.deviceId } },
            )
            return false
          }
          const privacySlice = await this.ctx.api.deviceState.getCapSlice
            .query({ deviceId: command.deviceId, capName: 'privacy-mask' })
            .catch((err: unknown): null => {
              this.ctx.logger.warn(
                'ha-export: could not read the privacy slice for a camera-function command',
                { tags: { deviceId: command.deviceId }, meta: { error: errMsg(err) } },
              )
              return null
            })
          /**
           * The source node comes from the last reconcile's `CameraStatus`
           * batch (Task C3) rather than a fresh per-command call: it changes
           * rarely, and only `broker-audio` needs it — a stale pin degrades
           * that ONE function for this command, not the other seven.
           */
          const sourceNodeId =
            this.cameraStatusByDeviceId.get(command.deviceId)?.assignment.sourceNodeId ?? null
          const reads = await this.readCameraFunctions({
            deviceId: command.deviceId,
            deviceType: device.type,
            deviceDisabled: device.disabled,
            privacySlice: privacySlice ?? undefined,
            sourceNodeId,
          })
          const write = resolveCameraFunctionWrite(parsed.data, command.enabled, reads)
          if (write === null) {
            /**
             * Refused, never approximated. No optimistic ack: the next
             * reconcile corrects Home Assistant's toggle back to reality.
             */
            this.ctx.logger.warn(
              'ha-export: dropping a camera-function command, the function is not available',
              { tags: { deviceId: command.deviceId }, meta: { switchId: parsed.data } },
            )
            return false
          }
          await applyCameraFunctionWrite(this.ctx.api, command.deviceId, write, sourceNodeId)
          return true
        }
        case 'reboot': {
          const device = await this.ctx.fetchDevice(command.deviceId)
          if (device.reboot === undefined) return this.noProvider(command.deviceId, 'reboot')
          await device.reboot.reboot({})
          return true
        }
        case 'ptz-move': {
          const device = await this.ctx.fetchDevice(command.deviceId)
          if (device.ptz === undefined) return this.noProvider(command.deviceId, 'ptz')
          await device.ptz.move(PTZ_MOVE_BY_DIRECTION[command.direction] ?? {})
          return true
        }
        case 'ptz-preset': {
          const device = await this.ctx.fetchDevice(command.deviceId)
          if (device.ptz === undefined) return this.noProvider(command.deviceId, 'ptz')
          const presets = await device.ptz.getPresets({})
          const preset = presets.find((entry) => entry.name === command.preset)
          if (preset === undefined) {
            this.ctx.logger.warn('ha-export: dropping a preset command, no preset by that name', {
              tags: { deviceId: command.deviceId },
              meta: { preset: command.preset },
            })
            return false
          }
          await device.ptz.goToPreset({ presetId: preset.id })
          return true
        }
      }
    } catch (err) {
      /**
       * No optimistic ack. Every writable entity promises HA that the
       * state topic is reality; acking a failed call makes that a lie in
       * the only case that matters. The next reconcile corrects HA's UI.
       */
      this.ctx.logger.warn('ha-export: command not applied', {
        tags: { deviceId: command.deviceId },
        meta: { kind: command.kind, error: errMsg(err) },
      })
      return false
    }
  }

  /** A cap the device does not provide. Refused, and never silently. */
  private noProvider(deviceId: number, capName: string): boolean {
    this.ctx.logger.warn('ha-export: dropping a command, the device has no provider for it', {
      tags: { deviceId },
      meta: { capName },
    })
    return false
  }

  /**
   * A public, signed, expiring route Home Assistant can fetch bytes from.
   *
   * Public because the fetcher is HA's frontend or a phone, neither of
   * which holds a camstack token; signed and expiring so a leaked link
   * stops working on its own.
   */
  private async serveMediaPlane(): Promise<void> {
    const dataPlane = this.ctx.dataPlane
    if (dataPlane === undefined) {
      this.ctx.logger.warn(
        'ha-export: no data plane on this runner — image entities will carry no URL',
      )
      return
    }
    const served = await dataPlane.serve({
      prefix: 'ha-media',
      access: 'public',
      handler: async (req, res) => {
        await this.serveMedia(req, res)
      },
    })
    this.ctx.addDisposer(async () => {
      await served.dispose()
    })
  }

  private async serveMedia(
    req: { url?: string },
    res: {
      statusCode: number
      setHeader(name: string, value: string): void
      end(chunk?: Buffer | string): void
    },
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const segments = url.pathname.split('/').filter((part) => part.length > 0)
    const id = segments[segments.length - 1]
    if (id === undefined) {
      res.statusCode = 400
      res.end()
      return
    }
    const compositeId = decodeURIComponent(id)
    const ok = verifyMediaSignature({
      secret: this.mediaSecret,
      id: compositeId,
      exp: url.searchParams.get('exp') ?? undefined,
      sig: url.searchParams.get('sig') ?? undefined,
      nowMs: Date.now(),
    })
    if (!ok) {
      res.statusCode = 403
      res.end()
      return
    }
    // `<deviceId>:<trackId>` — signed as one string (see mintTrackMediaUrl).
    // Links minted before the composite form fail the split and get a 400;
    // they re-mint on the next track event and expire inside the 6 h TTL.
    const sep = compositeId.indexOf(':')
    const deviceId = sep > 0 ? Number(compositeId.slice(0, sep)) : NaN
    const trackId = sep > 0 ? compositeId.slice(sep + 1) : ''
    if (!Number.isInteger(deviceId) || deviceId <= 0 || trackId.length === 0) {
      res.statusCode = 400
      res.end()
      return
    }
    try {
      const media = await this.ctx.api.pipelineAnalytics.getTrackMedia.query({
        trackId,
        deviceId,
        kinds: ['thumbnailSmall', 'thumbnail', 'crop'],
      })
      const first = media[0]
      if (first === undefined) {
        res.statusCode = 404
        res.end()
        return
      }
      const bytes = Buffer.from(first.base64, 'base64')
      res.statusCode = 200
      res.setHeader('content-type', 'image/jpeg')
      res.setHeader('cache-control', 'public, max-age=3600')
      res.end(bytes)
    } catch (err) {
      this.ctx.logger.warn('ha-export: media fetch failed', {
        meta: { trackId, error: errMsg(err) },
      })
      res.statusCode = 502
      res.end()
    }
  }

  /**
   * Mint a link, or `null`.
   *
   * `null` when the hub has no reachable base URL: a URL Home Assistant
   * cannot open is worse than no image, because it renders as a broken
   * entity rather than an empty one.
   */
  private mintTrackMediaUrl(trackId: string, deviceId: number): string | null {
    if (this.mediaBaseUrl === null || this.mediaSecret.length === 0) return null
    return buildMediaUrl({
      baseUrl: this.mediaBaseUrl,
      routePrefix: MEDIA_ROUTE_PREFIX,
      // The signed id carries the owning device: `getTrackMedia` requires the
      // deviceId (it is the authorization subject and the store's read
      // scope), and folding it into the SIGNED id means a forged one breaks
      // the signature rather than reading another camera's media.
      id: `${String(deviceId)}:${trackId}`,
      secret: this.mediaSecret,
      expMs: Date.now() + MEDIA_URL_TTL_MS,
    })
  }

  private async refreshMediaBaseUrl(): Promise<void> {
    if (this.config.publicBaseUrl.length > 0) {
      this.mediaBaseUrl = this.config.publicBaseUrl
      return
    }
    try {
      // `haMediaBaseUrl`: the `internal` role, never loopback — a link Home
      // Assistant cannot open is worse than no image, because it renders as a
      // broken entity rather than an empty one. Ranked by `local-network`.
      this.mediaBaseUrl = haMediaBaseUrl(await this.ctx.api.localNetwork.getAddresses.query())
    } catch (err) {
      this.mediaBaseUrl = null
      this.ctx.logger.debug('ha-export: could not resolve a media base URL', {
        meta: { error: errMsg(err) },
      })
    }
    if (this.mediaBaseUrl === null) {
      this.ctx.logger.warn(
        'ha-export: no reachable hub URL — image entities will carry no value until one is set',
      )
    }
  }

  // ── Membership ──────────────────────────────────────────────────────

  /**
   * The cap-level expose/unexpose applies to EVERY enabled broker.
   *
   * The `device-export` cap is the COMMON surface across export targets
   * and has no notion of a broker; per-broker granularity lives in the
   * derived Export panel, over the same store. There is exactly one
   * authority either way.
   */
  private async setMembershipEverywhere(deviceId: string, exposed: boolean): Promise<void> {
    let next = this.config.membership
    for (const brokerId of this.enabledBrokerIds()) {
      next = setExposed(next, brokerId, deviceId, exposed)
    }
    if (next === this.config.membership) {
      this.ctx.logger.debug('ha-export: membership already in that state, nothing to do', {
        tags: { deviceId: Number(deviceId) },
        meta: { exposed },
      })
      return
    }
    await this.updateGlobalSettings({ membership: next })
    this.ctx.logger.info('ha-export: export membership changed', {
      tags: { deviceId: Number(deviceId) },
      meta: { exposed, brokers: this.enabledBrokerIds() },
    })
    await this.reconcile(exposed ? 'expose' : 'unexpose')
  }

  // ── UI ──────────────────────────────────────────────────────────────

  protected globalSettingsSchema(): ConfigUISchema {
    const brokerFields = this.config.knownBrokers.map((broker) => ({
      type: 'boolean' as const,
      key: `exportTo:${broker.id}`,
      label: broker.name,
      style: 'switch' as const,
      default: false,
    }))
    return {
      sections: [
        {
          id: 'ha-export-brokers',
          title: 'Home Assistant instances',
          titleKey: 'provider-homeassistant:globalSettings.s_ha-export-brokers.title',
          description:
            brokerFields.length > 0
              ? 'An instance that is off receives nothing; its exported devices resume when it is turned back on.'
              : 'No Home Assistant broker is registered yet.',
          columns: 1,
          fields:
            brokerFields.length > 0
              ? brokerFields
              : [
                  {
                    type: 'info' as const,
                    key: 'ha-export:__no-brokers',
                    label: 'No brokers',
                    labelKey:
                      'provider-homeassistant:globalSettings.s_ha-export-brokers.ha-export___no-brokers.label',
                    content: 'Register a Home Assistant broker to enable the export.',
                    variant: 'warning' as const,
                  },
                ],
        },
        {
          id: 'ha-export-transport',
          title: 'Connection',
          titleKey: 'provider-homeassistant:globalSettings.s_ha-export-transport.title',
          columns: 1,
          fields: [
            {
              type: 'text' as const,
              key: 'publicBaseUrl',
              label: 'Hub URL Home Assistant can reach',
              labelKey:
                'provider-homeassistant:globalSettings.s_ha-export-transport.publicBaseUrl.label',
              description:
                'Used for the signed image links Home Assistant fetches; leave empty to derive one automatically.',
              descriptionKey:
                'provider-homeassistant:globalSettings.s_ha-export-transport.publicBaseUrl.description',
              default: '',
            },
          ],
        },
        // Tuning, not setup: collapsed so the page opens on what an operator
        // has to check (the exporter page pattern).
        {
          id: 'ha-export-advanced',
          title: 'Advanced',
          titleKey: 'provider-homeassistant:globalSettings.s_ha-export-advanced.title',
          style: 'accordion' as const,
          defaultCollapsed: true,
          columns: 1,
          fields: [
            {
              type: 'number' as const,
              key: 'reconcileIntervalSec',
              label: 'Reconcile interval (s)',
              labelKey:
                'provider-homeassistant:globalSettings.s_ha-export-advanced.reconcileIntervalSec.label',
              description: 'Full re-announce and re-push cadence.',
              descriptionKey:
                'provider-homeassistant:globalSettings.s_ha-export-advanced.reconcileIntervalSec.description',
              default: DEFAULT_CONFIG.reconcileIntervalSec,
            },
          ],
        },
      ],
    }
  }

  /**
   * Per-device Export panel — one switch PER BROKER.
   *
   * Field keys are namespaced `haExport:<deviceId>:<brokerId>`: the
   * device-details form flattens fields by key across every contributing
   * section, so a bare `enabled` collides with the Alexa and HomeKit
   * exporters' identically-named fields and the operator sees another
   * exporter's value in this one's toggle.
   */
  private async buildContribution(deviceId: number): Promise<ConfigUISchemaWithValues> {
    // Refreshed here, not just on the reconcile: the panel is opened straight
    // after the operator flips an instance on, and a switch list one reconcile
    // behind renders "Not configured" over a broker that IS enabled.
    await this.refreshEnabledBrokers(this.config.knownBrokers)
    const idStr = String(deviceId)
    const enabled = this.enabledBrokerIds()
    const fields = enabled.map((brokerId) => ({
      type: 'boolean' as const,
      key: `haExport:${deviceId}:${brokerId}`,
      label: `Export to ${this.brokerName(brokerId)}`,
      style: 'switch' as const,
      value: isExposed(this.config.membership, brokerId, idStr),
      immediate: true,
    }))
    return {
      tabs: [{ id: 'export', label: 'Export', icon: 'share-2', order: 80 }],
      sections: [
        {
          id: 'ha-export',
          title: 'Home Assistant',
          titleKey: 'provider-homeassistant:contribution.s_ha-export.title',
          description:
            enabled.length > 0
              ? 'Each instance receives only the devices switched on for it.'
              : 'No Home Assistant instance is enabled for export.',
          tab: 'export',
          columns: 1,
          order: 30,
          fields:
            fields.length > 0
              ? fields
              : [
                  {
                    type: 'info' as const,
                    key: `haExport:${deviceId}:__none`,
                    label: 'Not configured',
                    content: 'Enable a Home Assistant instance in the addon settings first.',
                    variant: 'info' as const,
                  },
                ],
        },
      ],
    }
  }

  private async applyDeviceSettingsPatch(
    deviceId: number,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<{ success: true }> {
    const idStr = String(deviceId)
    let next = this.config.membership
    let touched = false
    /**
     * Driven by the PATCH KEYS, not by the enabled-broker list.
     *
     * The key already carries the broker (`haExport:<deviceId>:<brokerId>`) —
     * the operator could not have been shown the switch otherwise — so reading
     * the broker from it needs no other state to be warm. Iterating
     * `enabledBrokerIds()` instead made this depend on a read-through cache,
     * and when that cache was cold the loop matched nothing, `touched` stayed
     * false, and the method returned `{success: true}` HAVING DONE NOTHING.
     * The admin UI showed the switch flip and it silently did not persist;
     * measured live on 2026-08-09 with two cameras that would not stay
     * exported. A no-op that reports success is worse than an error.
     */
    const prefix = `haExport:${deviceId}:`
    for (const [key, value] of Object.entries(patch)) {
      if (!key.startsWith(prefix)) continue
      const brokerId = key.slice(prefix.length)
      if (brokerId.length === 0) continue
      next = setExposed(next, brokerId, idStr, value === true)
      touched = true
    }
    if (!touched) {
      this.ctx.logger.warn('ha-export: a device patch carried no export key — nothing applied', {
        tags: { deviceId },
        meta: { keys: Object.keys(patch) },
      })
      return { success: true }
    }
    await this.updateGlobalSettings({ membership: next })
    this.ctx.logger.info('ha-export: per-broker export membership changed', {
      tags: { deviceId },
      meta: { brokers: brokersExposing(next, idStr) },
    })
    await this.reconcile('device-panel')
    return { success: true }
  }

  private buildStatus(): {
    linkState: 'linked' | 'unlinked' | 'error'
    exposedDeviceCount: number
    error?: string
    setup: {
      fields: readonly { label: string; value: string }[]
      note: string
    }
  } {
    const enabled = this.enabledBrokerIds()
    const healthy = [...this.links.values()].filter((link) => link.client.healthy).length
    const linkState =
      enabled.length === 0 ? 'unlinked' : healthy === this.links.size ? 'linked' : 'error'
    return {
      linkState,
      exposedDeviceCount: exposedDeviceIds(this.config.membership, enabled).length,
      ...(this.lastError !== undefined ? { error: this.lastError } : {}),
      setup: {
        fields: [
          {
            label: 'Home Assistant instances',
            value: `${healthy} / ${this.links.size} reachable`,
          },
          { label: 'Entities pushed', value: String(this.entityCount) },
          { label: 'Push endpoint', value: PUSH_PATH },
          {
            label: 'Capabilities unclassified',
            value: this.unclassified.length === 0 ? 'none' : this.unclassified.join(', '),
          },
        ],
        note: 'CamStack pushes to the CamStack custom component in Home Assistant. Home Assistant never polls the hub for a value; when the heartbeat stops, every entity is marked unavailable.',
      },
    }
  }

  private startTimer(): void {
    this.stopTimer()
    const ms = Math.max(30, this.config.reconcileIntervalSec) * 1000
    this.reconcileTimer = setInterval(() => void this.reconcile('periodic'), ms)
  }

  private stopTimer(): void {
    if (this.reconcileTimer !== null) clearInterval(this.reconcileTimer)
    this.reconcileTimer = null
  }
}

/**
 * Device kinds the picker offers.
 *
 * Every kind camstack models: coverage is decided by a device's
 * CAPABILITIES, not its type, and restricting the picker by type is what
 * confined the previous exporter to cameras.
 */
/**
 * POST one message to Home Assistant's push view.
 *
 * Authenticated with the broker's OWN long-lived token: the component
 * registers its view behind HA auth, so there is no second shared secret
 * to configure or rotate. A non-2xx throws, which is how the push client
 * learns the instance is unreachable.
 */
async function postToHomeAssistant(
  baseUrl: string,
  token: string,
  message: unknown,
): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${PUSH_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`Home Assistant answered ${response.status}`)
  }
}

function randomSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

type SliceRecord = Readonly<Record<string, unknown>>

function toSnapshot(raw: unknown): Readonly<Record<string, SliceRecord>> {
  if (raw === null || raw === undefined || typeof raw !== 'object') return {}
  const out: Record<string, SliceRecord> = {}
  for (const [cap, slice] of Object.entries(raw)) {
    if (slice !== null && typeof slice === 'object') out[cap] = { ...slice }
  }
  return out
}

/** `CameraStatus` → the narrower shape `projectCameraStatus` needs. */
function toCameraStatusInput(status: CameraStatus): CameraStatusInput {
  return {
    switchedOff: status.switchedOff,
    degradedStages: status.degraded.map((d) => d.stage),
    recording: status.recording === null ? null : { active: status.recording.active },
  }
}

function toCountRecord(raw: unknown): Readonly<Record<string, number>> {
  if (raw === null || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number') out[key] = value
  }
  return out
}

function readRecordField(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return undefined
  return Reflect.get(source, key)
}

function readString(source: unknown, key: string): string | null {
  const value = readRecordField(source, key)
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(source: unknown, key: string): number | null {
  const value = readRecordField(source, key)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readRecord(source: unknown, key: string): SliceRecord | null {
  const value = readRecordField(source, key)
  if (value === null || typeof value !== 'object') return null
  return { ...value }
}

function readStringArray(source: unknown, key: string): readonly string[] {
  const value = readRecordField(source, key)
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default HaExportAddon
