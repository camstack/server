/**
 * Alexa Smart Home Skill export addon — hub-side.
 *
 * Architecture:
 *   Alexa Cloud --> user-owned AWS Lambda --> HTTPS --> this addon
 *                                                       (hub Fastify)
 *
 *   The Lambda template lives in a separate dispatch. Operators stand
 *   up the Lambda, point it at `https://<hub>/addon/export-alexa/directive`,
 *   then paste the OAuth client id / secret shown on this addon's
 *   settings page into the Alexa Smart Home account-linking config.
 *
 * Capabilities registered:
 *   - `device-export` (collection)      — operator picks which devices to
 *     surface to Alexa. The exposed list drives the Discovery response.
 *   - `addon-routes` (collection)       — mounts the directive endpoints
 *     under the hub's `/addon/export-alexa/*` catch-all.
 *   - `oauth-integration` (collection)  — declares this addon as a
 *     linkable OAuth client of the hub's core `/oauth2/*` server.
 *
 * Persistence:
 *   All addon-owned data — exposed device list, linked Alexa accounts,
 *   and LWA tokens — lives on `this.config` and writes through
 *   `updateGlobalSettings`. There is NO `<dataDir>/alexa/*.json` sidecar
 *   anymore; the kernel's addon-store (a typed KV) is the single source
 *   of truth.
 *
 * Out of scope for this dispatch:
 *   - AWS Lambda template (CloudFormation + signing image) — the
 *     operator stands one up themselves; we just expose the directive
 *     endpoint.
 *   - The end-to-end LWA grant exchange (Lambda → Amazon → tokens) —
 *     the cloud Lambda performs the exchange and POSTs the resulting
 *     tokens to `/oauth/lwa-tokens`, which this addon records.
 *   - Admin-UI wizard that walks the operator through skill creation.
 */
import { randomUUID } from 'node:crypto'
import { releaseAlexaEgress } from './egress/alexa-rtc-egress.js'
import {
  EGRESS_REAP_INTERVAL_MS,
  logReaped,
  reapDeadEgressHandles,
} from './egress/egress-handle-reaper.js'
import { AlexaEgressPrewarm } from './egress/alexa-egress-prewarm.js'
import { forgetEgressHandle, heldEgressHandles } from './handlers/rtc-session.js'
import {
  type AddonInitResult,
  addonRoutesCapability,
  BaseAddon,
  buildAddonRouteProvider,
  type ConfigOption,
  type ConfigSectionWithValues,
  type ConfigUISchema,
  type ConfigUISchemaWithValues,
  DeviceType,
  deviceExportCapability,
  EventCategory,
  ExportSetupSchema,
  errMsg,
  type IAddonRouteProvider,
  type IDeviceExportProvider,
  type IOauthIntegrationProvider,
  NetworkAccessStatusSchema,
  oauthIntegrationCapability,
} from '@camstack/types'
import { z } from 'zod'

import {
  BrokerError,
  normaliseBrokerUrl,
  revokeBrokerCredential,
  rotateBrokerCredential,
} from './broker-client.js'
import { type ExportAlexaActions, exportAlexaActions } from './custom-actions.js'
import type { AlexaEndpoint } from './endpoints/types.js'
import { GENERIC_DEVICE_TYPES } from './endpoints/generic-device.js'
import {
  ALEXA_NAME_KEY,
  ALEXA_NAME_MAX_LENGTH,
  alexaNameKey,
  readAlexaName,
  validateAlexaName,
} from './endpoints/alexa-name.js'
import { buildEndpointsForExposedDevice } from './handlers/discovery.js'
import {
  type DetectionSensorClass,
  detectionSensorEndpointId,
  parseCameraEndpointId,
} from './handlers/endpoint-id.js'
import { buildRoutes } from './http-server.js'
import { generateIngressToken } from './ingress-token.js'
import { OauthSessionListSchema, selectAlexaSessionIdsToRevoke } from './link-status.js'
import {
  buildAddOrUpdateReportPayload,
  buildDeleteReportPayload,
  LwaEventGateway,
} from './lwa-event-gateway.js'
import { removeEndpointsFromAlexa } from './remove-endpoints.js'
import { buildAlexaSettingsSections } from './settings-schema.js'
import type { AlexaAccessGate } from './access/access-gate.js'
import { AccountVisibilityMirror, type StoredVisibilityMap } from './access/account-visibility.js'
import { type EndpointAccessDeps, filterEndpointsForPrincipal } from './access/endpoint-access.js'
import { createHubAccessGate } from './access/hub-access-source.js'
import { applyVisibilityChanges } from './access/visibility-sync.js'
import {
  DetectionClassSource,
  type StoredDetectionClassMap,
} from './detection-sensors/detection-classes.js'
import { DetectionSensorFeed } from './detection-sensors/detection-feed.js'
import {
  effectiveSensorClasses,
  parseSensorSelection,
  SENSOR_SELECTION_KEY,
  sensorSelectionField,
  sensorSelectionFromPatch,
  sensorSelectionKey,
} from './detection-sensors/sensor-selection.js'
import {
  AlexaVisionRuntime,
  OBJECT_DETECTION_KEY,
  objectDetectionField,
  objectDetectionKey,
} from './vision/vision-runtime.js'
import { buildAlexaOauthIntegration } from './oauth-integration.js'
import { buildAlexaSetupBlock } from './setup-block.js'
import { SnapshotStore } from './snapshots/snapshot-store.js'
import { StateChangeReporter } from './state-reports/state-change-reporter.js'
import { StateReconciler } from './state-reports/state-reconciler.js'
import { PUBLIC_SKILL_ID } from './public-skill.js'
import { type ResyncResult, SyncEngine } from './sync-engine.js'
import { type ActionSceneEntry, ActionSceneExports } from './action-scenes.js'
import {
  type ExportDeviceSettings,
  type ExposedDeviceEntry,
  isBrokerGrant,
  type LinkedAccount,
  type LwaTokenEntry,
  type UpsertLwaTokenInput,
} from './types.js'
import { DEFAULT_DEVICE_SETTINGS } from './types.js'

/** Per-device debounce for the bindings-change → discovery reconcile. A
 *  provider respawn emits one `DeviceBindingsChanged` per cap; reconciling in
 *  the middle of that burst would read a half-registered binding set. */
const BINDINGS_RECONCILE_DEBOUNCE_MS = 5_000

/** How often each linked account's visibility is recomputed from the live
 *  user grants (S1). Also the bound on how long an event keeps reaching a user
 *  whose grant was just revoked. */
const VISIBILITY_REFRESH_INTERVAL_MS = 60_000

/** First visibility pass after boot — soon, because until an account has an
 *  entry its events are refused (fail closed). */
const BOOT_VISIBILITY_DELAY_MS = 5_000

/** How often every exposed camera's endpoint shape is re-checked while the
 *  detection sensors are on — a camera whose pipeline gained or (confirmed)
 *  lost a class gets its sensors added or removed. */
const DETECTION_CLASS_REFRESH_MS = 15 * 60_000

/** Delay before the boot-time reconcile pass. Long enough for device providers
 *  to have registered their caps — a device whose bindings have not landed
 *  builds a shape we must never push to Alexa. */
const BOOT_RECONCILE_DELAY_MS = 60_000

// ── Stream preference options ────────────────────────────────────────
//
// The operator picks ONE source-stream slot for Alexa. Options are the
// three camstack profile slots (`high`/`mid`/`low`) plus the smart
// `auto` default — NOT raw native camStream ids. The runtime picker
// (`pickPreferredRtspEntry`) translates the choice to a broker
// brokerId at session start, falling back to the closest-resolution
// slot when `auto` is selected. Native ids would couple the operator
// to per-provider naming (`native:main` vs `rtmp:sub`) which churns
// when a camera is replaced or the broker reassigns slots.

const STREAM_PREFERENCE_OPTIONS: readonly ConfigOption[] = [
  { value: 'auto', label: 'Auto (closest to 720p)' },
  { value: 'high', label: 'High' },
  { value: 'mid', label: 'Mid' },
  { value: 'low', label: 'Low' },
]

// ── Config schema ────────────────────────────────────────────────────

export type AlexaRegion = 'NA' | 'EU' | 'FE'

export type SkillMode = 'public' | 'custom'

export interface AlexaSettings {
  /**
   * Which Alexa skill backs this export. `public` uses the built-in CamStack
   * skill (its id is in `public-skill.ts`) so no Amazon developer setup is
   * needed. `custom` uses the operator's own skill (`expectedAudience`) and
   * the operator's own copy of the skill Lambda. Either way the hub holds NO
   * LWA client secret: the skill's Lambda brokers Event Gateway tokens (D753).
   */
  readonly skillMode: SkillMode
  /** Alexa skill id (e.g. `amzn1.ask.skill.xxxx`). Operator-pasted. Used only
   *  in `skillMode: 'custom'` (public mode reads `PUBLIC_SKILL_ID`). */
  readonly expectedAudience: string
  /** @deprecated D753 — never read. The skill Lambda holds the LWA client;
   *  kept only so an old stored value parses. */
  readonly lwaClientId: string
  /** @deprecated D753 — never read, and scrubbed to '' on boot: the hub must
   *  not hold the LWA client secret. */
  readonly lwaClientSecret: string
  /**
   * Origin of the skill Lambda's token broker, as advertised on the last
   * verified directive (`x-camstack-broker`). Hidden state. Used only to
   * migrate a pre-D753 push grant; a broker grant carries its own URL.
   */
  readonly advertisedBrokerUrl: string
  /** Region the operator's skill is published in (NA / EU / FE). Drives
   *  the Event Gateway URL. */
  readonly region: AlexaRegion
  /** Operator-curated list of devices to surface to Alexa. Hidden state
   *  — written via the `device-export` cap, NOT operator-editable. */
  readonly exposed: readonly ExposedDeviceEntry[]
  /** Actions exported as Alexa scenes (D967). Hidden state, written through
   *  `exposeEntity` / `unexposeEntity` only. */
  readonly exposedActions: readonly ActionSceneEntry[]
  /** Alexa users that have completed account-linking (cloud-mode
   *  `/oauth/lwa-tokens` callback). Hidden state. */
  readonly linkedAccounts: readonly LinkedAccount[]
  /** Per-user LWA tokens harvested from the cloud-mode
   *  `/oauth/lwa-tokens` callback for the Event Gateway. Hidden state. */
  readonly tokens: readonly LwaTokenEntry[]
  /**
   * Per-device map of the Alexa endpoint ids we last pushed (deviceId →
   * endpoint ids). The single piece of sync state the `SyncEngine` owns: a
   * push records what it sent here, and a later `DeleteReport` addresses these
   * exact ids even after the device is gone from the registry. Replaces the
   * fingerprint-diff reconcile cache + synced-account latch the old sync
   * machinery used.
   */
  readonly exportedEndpoints: Readonly<Record<number, readonly string[]>>
  /**
   * Per-device map of the endpoint SHAPE we last pushed (deviceId →
   * `endpointsSignature(...)`). Alexa's copy of an endpoint's capability list
   * is refreshed by NOTHING but an `AddOrUpdateReport` from us, so this is the
   * only way to know whether the cloud still believes a stale shape: a camera
   * that gains the `doorbell` cap after it was exposed keeps a cloud-side
   * endpoint with no `Alexa.DoorbellEventSource`, and every press is then
   * accepted (2xx) and silently discarded. See `sync-engine.ts`.
   */
  readonly exportedSignatures: Readonly<Record<number, string>>
  /**
   * Public HTTPS URL of this hub. Baked into every Alexa-bound JWT
   * as the `hubUrl` claim so the camstack-hosted Alexa Lambda can
   * route requests back to this hub (Option-2 architecture: one
   * Lambda + one published skill serves many hubs, routing is in
   * the JWT).
   *
   * Defaults on first boot to the first HTTPS endpoint from the
   * `network-access` cap's `listEndpoints` aggregate. The operator picks
   * which connected external-access endpoint to use via the "External
   * address" picker in settings, whose options are read live
   * (`listExternalAddresses`).
   */
  readonly publicHubUrl: string
  /**
   * Shared ingress token the user-owned Lambda presents (header
   * `X-CamStack-Ingress`) on its server-to-server hub calls. Generated on
   * first boot; rotated via the "Regenerate token" action. Defense-in-depth
   * on top of the per-user OAuth bearer — see `ingress-token.ts`. Custom skill
   * only: the public skill's shared Lambda cannot carry a per-hub token.
   */
  readonly ingressToken: string
  /**
   * When true, `/directive` + `/oauth/lwa-tokens` reject calls lacking a
   * matching ingress token. Off by default so the token can be rolled into
   * the Lambda before enforcement is switched on. Ignored in public mode
   * (`effectiveAlexaSettings`).
   */
  readonly enforceIngressToken: boolean
  /**
   * Per linked account, the exposed devices its hub user may view (S1, D767).
   * Hidden state, owned by `AccountVisibilityMirror`: the event path reads it
   * synchronously, and a loss persisted here survives a restart until the
   * confirming read deletes the device from that user's Alexa account.
   */
  readonly accountVisibility: StoredVisibilityMap
  /**
   * Integration switch, default ON: the master gate of the detection sensors
   * (R1, D772). WHICH classes a camera publishes is a per-camera choice since
   * D778 (`detection-sensors/sensor-selection.ts`, default none); this switch
   * still removes every one of them at once (DeleteReport).
   */
  readonly detectionSensors: boolean
  /** Per camera, the detection classes last published, with pending
   *  removals (`DetectionClassSource`). Hidden state. */
  readonly detectionClasses: StoredDetectionClassMap
  /**
   * Integration switch, default ON (operator decision, 2026-10-08): every
   * exposed camera declares `Alexa.SmartVision.SnapshotProvider`, so the Alexa
   * app shows its still (R2, D773). Images of the home go to Amazon while it is
   * on. Off removes the capability and kills every URL already handed out.
   */
  readonly snapshots: boolean
  /** HMAC key for snapshot URLs. Hidden; generated on first boot; never on a
   *  read surface. */
  readonly snapshotSigningKey: string
  /**
   * Integration switch, default ON (operator decision, 2026-10-08): every
   * exposed camera declares `Alexa.SmartVision.ObjectDetectionSensor` +
   * `Alexa.DataController` and posts person/package events (R4, D779). An
   * en-US-only interface, on as an experiment; this is the one switch that
   * takes it off every camera (the next push re-sends the camera without it).
   */
  readonly objectDetection: boolean
  /** UUID namespace of this hub's object/event identifiers (R4). Hidden;
   *  generated on first boot. */
  readonly visionNamespace: string
}

const DEFAULT_CONFIG: AlexaSettings = {
  skillMode: 'public',
  expectedAudience: '',
  lwaClientId: '',
  lwaClientSecret: '',
  advertisedBrokerUrl: '',
  region: 'NA',
  exposed: [],
  exposedActions: [],
  linkedAccounts: [],
  tokens: [],
  exportedEndpoints: {},
  exportedSignatures: {},
  publicHubUrl: '',
  ingressToken: '',
  enforceIngressToken: false,
  accountVisibility: {},
  detectionSensors: true,
  detectionClasses: {},
  snapshots: true,
  snapshotSigningKey: '',
  objectDetection: true,
  visionNamespace: '',
}

/** Outcome of the operator-driven account unlink. Object-literal type (not an
 *  interface) so it satisfies the action handler's `Record<string, unknown>`
 *  return contract — same reason as `DiscoverySyncResult`. */
export type UnlinkAlexaResult = {
  /** Active `export-alexa` OAuth sessions actually revoked. */
  readonly revokedSessions: number
  /** Linked-account records (and their Amazon push grants) dropped. */
  readonly removedAccounts: number
}

/** The one field of `oauthVerifyAccessToken`'s answer the snapshot route
 *  reads. */
const VerifiedTokenSchema = z.object({ userId: z.string() }).nullable()

/**
 * Settings as the runtime reads them. In `skillMode: 'public'` the skill id is
 * the built-in skill's, and the ingress token is never required: the public
 * skill's Lambda is shared by every hub and sends one `HUB_INGRESS_TOKEN` for
 * all of them, so enforcing a per-hub token would refuse every directive. The
 * persisted values stay untouched, so switching back to `custom` restores
 * them. There is no credential to overlay any more (D753).
 */
export function effectiveAlexaSettings(config: AlexaSettings): AlexaSettings {
  if (config.skillMode !== 'public') return config
  return {
    ...config,
    expectedAudience: PUBLIC_SKILL_ID,
    enforceIngressToken: false,
  }
}

/** UI filter for the Export picker. `alarm-panel` publishes an
 *  `Alexa.SecurityPanelController` endpoint (`endpoints/builder.ts`). */
const SUPPORTED_KINDS: readonly string[] = [
  'camera',
  'doorbell',
  DeviceType.AlarmPanel,
  // R5 (D775): non-camera devices with an Alexa interface — see
  // `endpoints/generic-device.ts` for which caps map and which do not.
  DeviceType.Light,
  DeviceType.Switch,
  DeviceType.Siren,
  DeviceType.Sensor,
  DeviceType.Lock,
  DeviceType.Presence,
  DeviceType.Thermostat,
  // D874: an air conditioner (Gree) is a `climate` device, not a thermostat.
  DeviceType.Climate,
  // D869: blinds, shutters, awnings, curtains (a garage door or gate is selectable
  // but withheld until the confirmation-gated phase).
  DeviceType.Cover,
  DeviceType.Generic,
]

/** Generic `device-export` setup block — copyable account-linking rows. */
type ExportSetup = z.infer<typeof ExportSetupSchema>

// ── Addon ───────────────────────────────────────────────────────────

export class ExportAlexaAddon extends BaseAddon<AlexaSettings> {
  /** Hidden state that is a credential — kept in the keychain, never the blob (D787). */
  protected override readonly secretStatePaths = [
    'ingressToken',
    'snapshotSigningKey',
    'tokens[userId].accessToken',
    'tokens[userId].refreshToken',
    'tokens[userId].brokerCredential',
  ]
  private lwaGateway: LwaEventGateway | null = null
  private egressPrewarm: AlexaEgressPrewarm | null = null
  private syncEngine: SyncEngine | null = null
  /** D967: exported actions, answered as Alexa scenes. */
  private actionScenes: ActionSceneExports | null = null
  /** S1 (D767): the linking user's live grants. Built in `onInitialize`, the
   *  first point `ctx` exists. */
  private accessGateRef: AlexaAccessGate | null = null
  private visibilityRef: AccountVisibilityMirror | null = null
  private detectionClassSource: DetectionClassSource | null = null
  /** The images handed to Alexa, behind signed URLs (R2). In memory only: a
   *  restart answers 410 and Alexa asks again. */
  private readonly snapshotStore = new SnapshotStore(() => this.config.snapshotSigningKey)
  private detectionFeed: DetectionSensorFeed | null = null
  /** R4 (D779): object detection + event history. */
  private visionRef: AlexaVisionRuntime | null = null
  private stateReporter: StateChangeReporter | null = null
  private stateReconciler: StateReconciler | null = null
  /** The switches whose change re-shapes every exposed endpoint, as last
   *  applied — `onConfigChanged` runs on EVERY settings write. */
  private appliedShapeSwitches: string | null = null
  /** Per-device debounce timers for the bindings-change discovery reconcile. */
  private readonly pendingReconcileTimers = new Map<number, ReturnType<typeof setTimeout>>()

  constructor() {
    super({ ...DEFAULT_CONFIG })
  }

  protected async onInitialize(): Promise<AddonInitResult<ExportAlexaActions>> {
    // Ensure an ingress token exists on first boot (shown in settings; the
    // operator pastes it into the Lambda's HUB_INGRESS_TOKEN env). Enforcement
    // is opt-in (`enforceIngressToken`) so this never breaks an existing link.
    if (!this.config.ingressToken) {
      await this.updateGlobalSettings({ ingressToken: generateIngressToken() })
    }

    // The snapshot URL signing key (R2). Generated once, hidden, rotated by
    // nothing: a minted URL lives ten minutes.
    if (!this.config.snapshotSigningKey) {
      await this.updateGlobalSettings({
        snapshotSigningKey: generateIngressToken(),
      })
    }
    // R4 (D779): the namespace every object/event identifier is derived under.
    if (!this.config.visionNamespace) {
      await this.updateGlobalSettings({ visionNamespace: randomUUID() })
    }

    // D753: the hub never holds the skill's LWA client secret. A custom-skill
    // hub configured before D753 may still have one stored — remove it.
    if (this.config.lwaClientSecret) {
      await this.clearSecrets(['lwaClientSecret'])
      this.ctx.logger.warn(
        'export-alexa: removed a stored LWA client secret — the hub no longer uses one; your skill Lambda holds it (D753)',
      )
    }

    // Backfill linked accounts from stored LWA tokens whose account wasn't
    // recorded — covers cloud-mode links completed before the /oauth/lwa-tokens
    // callback started recording the link (so getStatus shows 'linked' and the
    // Event Gateway has an audience without the operator re-linking).
    await this.backfillLinkedAccounts()

    // Public-hub-URL auto-detect makes a cross-addon `ctx.api` call
    // (`networkAccess.listEndpoints`). Awaiting it inline blocked
    // `onInitialize` from returning during hub boot — so `device-export`
    // / `addon-routes` (and the addon's `settings` Moleculer service)
    // never registered, and the addon sat in "Still waiting for
    // capability" forever. It is best-effort and the providers read
    // `config.publicHubUrl` lazily, so detach it.
    void this.autoDetectPublicHubUrl().catch((err: unknown) => {
      this.ctx.logger.warn('export-alexa: public hub URL auto-detect failed', {
        meta: { error: errMsg(err) },
      })
    })

    this.accessGateRef = createHubAccessGate(this.ctx)
    this.detectionClassSource = new DetectionClassSource({
      readEventKinds: (deviceId) =>
        this.ctx.api.pipelineAnalytics.listEventKinds.query({ deviceId }),
      getStored: () => this.config.detectionClasses,
      setStored: (next) => this.updateGlobalSettings({ detectionClasses: next }),
      logger: this.ctx.logger,
    })
    this.visibilityRef = new AccountVisibilityMirror({
      gate: this.accessGateRef,
      listLinkedUserIds: () => this.config.linkedAccounts.map((a) => a.userId),
      listExposedDeviceIds: () => this.config.exposed.map((e) => e.deviceId),
      getStored: () => this.config.accountVisibility,
      setStored: (next) => this.updateGlobalSettings({ accountVisibility: next }),
      logger: this.ctx.logger,
    })

    this.visionRef = new AlexaVisionRuntime({
      ctx: this.ctx,
      logger: this.ctx.logger,
      integrationOn: () => this.config.objectDetection,
      snapshotsOn: () => this.config.snapshots,
      isExposed: (deviceId) => this.config.exposed.some((e) => e.deviceId === deviceId),
      knownClasses: (deviceId) => this.config.detectionClasses[deviceId]?.classes ?? [],
      namespace: () => this.config.visionNamespace,
      publicHubUrl: () => this.config.publicHubUrl,
      store: this.snapshotStore,
      post: (opts) => this.requireGateway().postObjectDetection(opts),
    })

    this.actionScenes = new ActionSceneExports(
      {
        api: this.ctx.api,
        logger: this.ctx.logger,
        linkedUserIds: () => this.config.linkedAccounts.map((a) => a.userId),
        isAdminUser: async (userId) => {
          const lookup = await this.accessGate.principal(userId)
          return lookup.kind === 'found' && lookup.principal.kind === 'admin'
        },
        canPush: () => this.config.tokens.length > 0,
        postAddOrUpdate: (userId, endpoints) =>
          this.requireGateway().postReport(
            userId,
            (accessToken) => buildAddOrUpdateReportPayload(userId, endpoints, accessToken),
            `action scenes add/update (${endpoints.length})`,
          ),
        postDelete: (userId, ids) =>
          this.requireGateway().postReport(
            userId,
            (accessToken) => buildDeleteReportPayload(userId, ids, accessToken),
            `action scenes delete (${ids.length})`,
          ),
        persist: (entries) => this.updateGlobalSettings({ exposedActions: [...entries] }),
      },
      this.config.exposedActions ?? [],
    )
    const actionScenes = this.actionScenes
    // The operator may have deleted an action while this addon was down.
    void actionScenes.reconcile().catch((err: unknown) => {
      this.ctx.logger.warn('export-alexa: action scene reconcile at boot failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })

    const deviceExportProvider: IDeviceExportProvider = {
      getStatus: async () => ({
        linkState: this.config.linkedAccounts.length > 0 ? 'linked' : 'unlinked',
        exposedDeviceCount: this.config.exposed.length,
        setup: this.buildSetupBlock(),
      }),
      listSupportedDeviceKinds: async () => [...SUPPORTED_KINDS],
      listExposedDevices: async () =>
        this.config.exposed.map((e) => ({
          deviceId: String(e.deviceId),
        })),
      exposeDevice: async ({ deviceId }) => this.exposeDevice(deviceId),
      unexposeDevice: async ({ deviceId }) => this.unexposeDevice(deviceId),
      listSupportedEntityKinds: async () => ['device', 'action'],
      listExposedEntities: async () => {
        await actionScenes.reconcile()
        return [
          ...this.config.exposed.map((e) => ({
            entity: { kind: 'device' as const, deviceId: String(e.deviceId) },
          })),
          ...actionScenes.list(),
        ]
      },
      exposeEntity: async ({ entity }) => {
        if (entity.kind === 'device') return this.exposeDevice(entity.deviceId)
        if (entity.kind === 'action') return actionScenes.expose(entity.actionId)
        throw new Error('export-alexa: a notification target cannot be exported to Alexa')
      },
      unexposeEntity: async ({ entity }) => {
        if (entity.kind === 'device') return this.unexposeDevice(entity.deviceId)
        if (entity.kind === 'action') return actionScenes.unexpose(entity.actionId)
        throw new Error('export-alexa: a notification target cannot be exported to Alexa')
      },
      getDeviceSettingsContribution: (input) =>
        // `device-export` types deviceId as a string; our exposed entries key
        // on numbers — coerce so `findEntry`'s strict === matches (otherwise an
        // exposed camera renders as "off" in device-details).
        this.buildDeviceSettingsContribution(Number(input.deviceId)),
      getDeviceLiveContribution: async () => null,
      applyDeviceSettingsPatch: (input) =>
        this.applyDeviceSettingsPatch(Number(input.deviceId), input.patch),
    }

    const routes = buildRoutes({
      ctx: this.ctx,
      logger: this.ctx.logger,
      getSettings: () => this.effectiveSettings(),
      directiveDeps: {
        discovery: {
          ctx: this.ctx,
          logger: this.ctx.logger,
          // An in-process read of this addon's OWN store — no cap-router
          // round-trip for a value we already hold.
          //
          // This used to be justified by "first-provider-wins routing would
          // pull the HomeKit or HA-MQTT provider's exposed list". That hazard
          // was real and is fixed: `rejectUnresolvedAddonPin` refuses an
          // unresolvable `addonId` instead of answering from another provider,
          // and every `device-export` reader pins. The reason was left here
          // describing a bug that no longer exists, which reads as
          // verification — the correct rule is simply that a provider reads
          // its own store directly and every OTHER reader pins by addonId.
          listExposed: async () => this.config.exposed,
          buildEndpoints: (deviceId) => this.buildEndpointsForOneDevice(deviceId),
        },
        cameraStream: {
          ctx: this.ctx,
          logger: this.ctx.logger,
          listExposed: () => this.config.exposed,
        },
        rtcSession: {
          ctx: this.ctx,
          logger: this.ctx.logger,
          listExposed: () => this.config.exposed,
        },
        ptzPreset: {
          ctx: this.ctx,
          logger: this.ctx.logger,
        },
        ptzDirection: {
          ctx: this.ctx,
          logger: this.ctx.logger,
        },
        powerController: {
          ctx: this.ctx,
          logger: this.ctx.logger,
        },
        brightnessController: {
          ctx: this.ctx,
          logger: this.ctx.logger,
        },
        reportState: {
          ctx: this.ctx,
          logger: this.ctx.logger,
          detectionPresent: (deviceId, cls) =>
            this.detectionFeed?.isPresent(deviceId, cls) ?? false,
        },
        securityPanel: {
          ctx: this.ctx,
          logger: this.ctx.logger,
        },
        lockController: {
          ctx: this.ctx,
          logger: this.ctx.logger,
        },
        climateController: {
          ctx: this.ctx,
          logger: this.ctx.logger,
        },
        coverController: {
          ctx: this.ctx,
          logger: this.ctx.logger,
          // Resolved when the answer is due: the gateway is built after the routes.
          sendAsyncResponse: (input) => this.requireGateway().sendAsyncResponse(input),
        },
        snapshotProvider: {
          ctx: this.ctx,
          logger: this.ctx.logger,
          store: this.snapshotStore,
          enabled: () => this.config.snapshots,
          publicHubUrl: () => this.config.publicHubUrl,
        },
        vision: this.vision.context(),
        access: this.endpointAccess,
        actionScenes: { exports: actionScenes, api: this.ctx.api, logger: this.ctx.logger },
        afterDiscovery: (userId, endpoints) =>
          this.requireGateway().scheduleInitialConnectivity(userId, endpoints),
      },
      lwaTokensCallbackDeps: {
        ctx: this.ctx,
        logger: this.ctx.logger,
        upsertToken: (input) => this.upsertToken(input),
        recordLinkedAccount: (input) => this.recordLinkedAccount(input),
      },
      redetectPublicHubUrl: () => this.redetectPublicHubUrl(),
      onBrokerAdvertised: (raw) => this.rememberAdvertisedBroker(raw),
      snapshotRoute: {
        store: this.snapshotStore,
        enabled: () => this.config.snapshots,
        verifyToken: (token) => this.verifyAccountLinkToken(token),
        mayView: async (userId, deviceId) => {
          const lookup = await this.accessGate.principal(userId)
          if (lookup.kind !== 'found') return false
          return (await this.accessGate.allows(lookup.principal, deviceId, 'view')) === 'allowed'
        },
        logger: this.ctx.logger,
      },
    })
    const routeProvider: IAddonRouteProvider = buildAddonRouteProvider('export-alexa', routes)

    // The `export-alexa` OAuth client. Static apart from the operator's chosen
    // public origin — see oauth-integration.ts. Read on the authorize path, so
    // it must never sit behind an await, and this addon must not register it
    // behind one either: a provider goes live only when `onInitialize` returns.
    const oauthIntegrationProvider: IOauthIntegrationProvider = {
      getDescriptor: async () => buildAlexaOauthIntegration(this.config.publicHubUrl),
    }

    // Spin up the Event Gateway worker. Subscribes to doorbell events
    // and runs a 60s refresh scan — both teardown in `onShutdown`.
    this.egressPrewarm = new AlexaEgressPrewarm({
      api: this.ctx.api,
      logger: this.ctx.logger,
      listExposed: () => this.config.exposed,
      hasLiveSession: (deviceId) => heldEgressHandles().some((h) => h.deviceId === deviceId),
    })
    this.lwaGateway = new LwaEventGateway({
      ctx: this.ctx,
      logger: this.ctx.logger,
      listExposed: () => this.config.exposed,
      onExposedDoorbellPress: (deviceId) => {
        void this.egressPrewarm?.onPress(deviceId)
      },
      listLinkedAccounts: () => this.config.linkedAccounts,
      listTokens: () => this.config.tokens,
      upsertToken: (input) => this.upsertToken(input),
      removeLinkedAccount: (userId) => this.removeLinkedAccount(userId),
      getAdvertisedBrokerUrl: () => this.config.advertisedBrokerUrl || null,
      getPublicHubUrl: () => this.config.publicHubUrl,
      getRegion: () => this.config.region,
      getExportedSignature: (deviceId) => this.config.exportedSignatures[deviceId] ?? null,
      accountMaySee: (userId, deviceId) => this.visibility.allows(userId, deviceId),
    })
    this.lwaGateway.start()

    // R1 (D772): the detection sensors' live feed. Started after the gateway it
    // posts through; the reconcile against active tracks runs inside it.
    const gatewayForFeed = this.lwaGateway
    this.detectionFeed = new DetectionSensorFeed({
      eventBus: this.ctx.eventBus,
      enabled: () => this.config.detectionSensors,
      isExposed: (deviceId) => this.config.exposed.some((e) => e.deviceId === deviceId),
      readActiveTracks: async (deviceId) => {
        const tracks = await this.ctx.api.pipelineAnalytics.getActiveTracks.query({
          deviceId,
        })
        return tracks.map((t) => ({
          trackId: t.trackId,
          className: t.className,
        }))
      },
      push: (deviceId, cls, detected, timestamp) =>
        gatewayForFeed.pushDetectionSensor({
          deviceId,
          endpointId: detectionSensorEndpointId(deviceId, cls),
          detected,
          timestamp,
        }),
      logger: this.ctx.logger,
    })
    this.detectionFeed.start()
    // R4 (D779): person/package events from the same track lifecycle.
    this.vision.start()
    this.appliedShapeSwitches = this.shapeSwitches()

    // R3 (D776): every device state change Alexa shows — alarm, privacy,
    // autotrack, accessories, connectivity — pushed as a ChangeReport.
    this.stateReporter = new StateChangeReporter({
      eventBus: this.ctx.eventBus,
      getExportedEndpoints: () => this.config.exportedEndpoints,
      reportConnectivity: (deviceId, connectivity) =>
        gatewayForFeed.reportConnectivity(deviceId, connectivity),
      postStateChange: (report) => gatewayForFeed.postStateChange(report),
      postHeldMotion: (report, detected) =>
        gatewayForFeed.pushDetectionSensor({
          deviceId: report.exposedDeviceId,
          endpointId: report.endpointId,
          detected,
          timestamp: Date.now(),
        }),
      logger: this.ctx.logger,
    })
    this.stateReporter.start()

    // D869: events are droppable, so every 15 min each exposed generic
    // endpoint's slices are re-read and only a difference is pushed.
    this.stateReconciler = new StateReconciler({
      reporter: this.stateReporter,
      getExportedEndpoints: () => this.config.exportedEndpoints,
      readSlice: (deviceId, capName) =>
        this.ctx.api.deviceState.getCapSlice.query({ deviceId, capName }),
      logger: this.ctx.logger,
    })
    this.stateReconciler.start()

    // The sync engine owns the four explicit push operations (expose →
    // pushDevice, Re-sync button → resync, account link → pushAllToAccount,
    // unexpose / device removal → removeDevice) over the single persisted
    // `exportedEndpoints` map. It replaces the fingerprint-diff /
    // synced-account-latch reconcile machinery — no boot-settle timer, no
    // DeviceProvisioned / DeviceReady debounce; pushes are explicit and
    // verifiable (the gateway POST returns a boolean).
    this.syncEngine = new SyncEngine({
      logger: this.ctx.logger,
      listExposed: () => this.config.exposed,
      listLinkedAccounts: () => this.config.linkedAccounts,
      hasProactiveCredentials: () => this.config.tokens.length > 0,
      buildEndpoints: (deviceId) => this.buildEndpointsForOneDevice(deviceId),
      filterForAccount: (userId, endpoints) => this.filterForAccount(userId, endpoints),
      afterPush: (userId, endpoints) =>
        this.requireGateway().scheduleInitialConnectivity(userId, endpoints),
      // Only a detection sensor's absence is decided by a setting / a read
      // that holds its last answer on failure; nothing else is ever deleted
      // because one build did not return it.
      mayRetire: (endpointId) => parseCameraEndpointId(endpointId).kind === 'detection',
      postAddOrUpdate: (userId, endpoints) =>
        this.requireGateway().postReport(
          userId,
          (accessToken) => buildAddOrUpdateReportPayload(userId, endpoints, accessToken),
          `add/update (${endpoints.length})`,
        ),
      postDelete: (userId, ids) =>
        this.requireGateway().postReport(
          userId,
          (accessToken) => buildDeleteReportPayload(userId, ids, accessToken),
          `delete (${ids.length})`,
        ),
      getExportedEndpoints: () => this.config.exportedEndpoints,
      setExportedEndpoints: (next) => this.updateGlobalSettings({ exportedEndpoints: next }),
      getExportedSignatures: () => this.config.exportedSignatures,
      setExportedSignatures: (next) => this.updateGlobalSettings({ exportedSignatures: next }),
    })

    // ── Discovery drift reconcile ──────────────────────────────────
    //
    // Every other push here is triggered by an operator action, and NONE of
    // them fires when a camera's capability bindings change. Alexa's copy of
    // an endpoint is refreshed by nothing else, so a camera that gained the
    // `doorbell` cap after being exposed keeps a cloud-side shape without
    // `Alexa.DoorbellEventSource`: the Event Gateway answers 2xx to every
    // DoorbellPress and the cloud drops it. Camera 101, 2026-08-07.
    //
    // Bindings are the authority for an endpoint's interfaces, so a
    // bindings-change is exactly the right trigger. The engine's signature
    // comparison makes it storm-proof: an unchanged shape costs no gateway
    // call and no write, so the boot-time binding churn collapses to nothing.
    this.subscribeBindingsChangedForReconcile()
    this.scheduleBootDiscoveryReconcile()
    this.scheduleVisibilityRefresh()
    this.scheduleDetectionClassRefresh()

    // When a device is unregistered from the kernel, drop it from Alexa
    // (DeleteReport for its stored endpoint ids) AND from our exposed list, so a
    // deleted camera doesn't linger in the Alexa app or our settings. A delete
    // that fails keeps its ids tracked, so the Re-sync button retries it.
    const offRemoved = this.ctx.eventBus.subscribe(
      { category: EventCategory.DeviceUnregistered },
      (event) => {
        const id = (event.data as { deviceId?: unknown } | null)?.deviceId
        if (typeof id !== 'number') return
        if (!this.config.exposed.some((e) => e.deviceId === id)) return
        // `unexposeDevice` drops the device from `exposed` AND issues the
        // DeleteReport (via the SyncEngine) — a single path, no double-fire.
        void this.unexposeDevice(String(id))
      },
    )
    this.ctx.addDisposer(async () => offRemoved())

    // Re-run public-hub-URL detection when a remote-access tunnel connects.
    // Closes the boot race: the addon's detached `autoDetectPublicHubUrl()`
    // above runs at boot, but a `network-access` provider (Cloudflare Tunnel /
    // Tailscale Funnel) often connects AFTER the addon — detection then saw no
    // connected HTTPS endpoint and `publicHubUrl` stayed empty, leaving the
    // Alexa Lambda with no hub URL to route to. Every tunnel provider emits
    // `NetworkTunnelStarted` (with the public `url`) the moment it connects, so
    // we re-detect on that signal. `redetectPublicHubUrl` keeps the operator's
    // current selection when it's still present, so this never clobbers a
    // manual pick — it just fills an empty value once the tunnel is up.
    const offTunnelStarted = this.ctx.eventBus.subscribe(
      { category: EventCategory.NetworkTunnelStarted },
      () => {
        void this.redetectPublicHubUrl()
          .then(({ publicHubUrl }) => {
            this.ctx.logger.info('export-alexa: re-detected public hub URL after tunnel connect', {
              meta: { publicHubUrl },
            })
          })
          .catch((err: unknown) => {
            this.ctx.logger.warn(
              'export-alexa: public hub URL re-detect after tunnel connect failed',
              { meta: { error: errMsg(err) } },
            )
          })
      },
    )
    this.ctx.addDisposer(async () => offTunnelStarted())

    // Reclaim an egress whose session died without a `SessionDisconnected`.
    // See `egress-handle-reaper.ts` for the twenty minutes of transcoding that
    // absence cost on 2026-09-13.
    const reaper = setInterval(() => {
      void this.reapDeadEgressHandles()
    }, EGRESS_REAP_INTERVAL_MS)
    reaper.unref?.()
    this.ctx.addDisposer(async () => clearInterval(reaper))

    this.ctx.logger.info('export-alexa: initialized', {
      meta: {
        exposedCount: this.config.exposed.length,
        skillMode: this.config.skillMode,
        skillIdSet: this.effectiveSettings().expectedAudience.length > 0,
        pushGrants: this.config.tokens.length,
        brokerGrants: this.config.tokens.filter(isBrokerGrant).length,
      },
    })

    return {
      providers: [
        { capability: deviceExportCapability, provider: deviceExportProvider },
        { capability: addonRoutesCapability, provider: routeProvider },
        {
          capability: oauthIntegrationCapability,
          provider: oauthIntegrationProvider,
        },
      ],
      customActions: exportAlexaActions,
      actionHandlers: {
        listExternalAddresses: async () => this.listExternalAddresses(),
        regenerateIngressToken: async () => this.regenerateIngressToken(),
        revealIngressToken: async () => {
          this.ctx.logger.info('export-alexa: an administrator revealed the ingress token')
          return { ingressToken: this.config.ingressToken }
        },
        resyncDiscovery: async () => this.resyncDiscovery(),
        removeAlexaEndpoints: async ({ endpointIds }) =>
          removeEndpointsFromAlexa({
            raw: endpointIds,
            purge: (ids) => this.requireGateway().purgeEndpoints(ids),
            getTracked: () => this.config.exportedEndpoints,
            setTracked: (next) => this.updateGlobalSettings({ exportedEndpoints: next }),
          }).then((r) => {
            this.ctx.logger.info('export-alexa: operator removed endpoint ids from Alexa', {
              meta: { ...r, endpointIds },
            })
            return r
          }),
        unlinkAlexaAccounts: async () => this.unlinkAlexaAccounts(),
        rotateBrokerCredential: async () => this.rotateBrokerCredentials(),
      },
    }
  }

  protected override async onShutdown(): Promise<void> {
    this.detectionFeed?.stop()
    this.detectionFeed = null
    this.visionRef?.stop()
    this.stateReconciler?.stop()
    this.stateReconciler = null
    this.stateReporter?.stop()
    this.stateReporter = null
    if (this.egressPrewarm) {
      await this.egressPrewarm.dispose()
      this.egressPrewarm = null
    }
    if (this.lwaGateway) {
      this.lwaGateway.stop()
      this.lwaGateway = null
    }
    this.syncEngine = null
    this.actionScenes = null
  }

  // ── Provider methods ────────────────────────────────────────────

  private async exposeDevice(deviceIdRaw: string): Promise<void> {
    const deviceId = Number.parseInt(deviceIdRaw, 10)
    if (!Number.isFinite(deviceId)) {
      throw new Error(`export-alexa: deviceId must be numeric — got "${deviceIdRaw}"`)
    }

    // Validate the device exists. We reuse the device-manager cap via
    // the typed `ctx.api` so we go through the same Moleculer path
    // every other addon uses.
    const live = await this.ctx.api.deviceManager.getDevice
      .query({ deviceId })
      .catch((err: unknown) => {
        throw new Error(`export-alexa: deviceManager.getDevice failed: ${errMsg(err)}`)
      })
    if (!live) {
      throw new Error(`export-alexa: device ${deviceId} not found`)
    }

    const next: ExposedDeviceEntry[] = this.config.exposed.filter((e) => e.deviceId !== deviceId)
    next.push({
      deviceId,
      exposedAt: Date.now(),
      settings: DEFAULT_DEVICE_SETTINGS,
    })
    await this.updateGlobalSettings({ exposed: next })

    this.ctx.logger.info('export-alexa: exposed device', {
      meta: { deviceId },
    })
    // Push this one device to every linked account (AddOrUpdateReport). Records
    // the endpoint ids in `exportedEndpoints` so a later DeleteReport can clean
    // Alexa up even after the device leaves the registry.
    void this.requireSyncEngine()
      .pushDevice(deviceId)
      .then((r) => {
        this.ctx.logger.info('export-alexa: synced exposed device', {
          meta: { ...r },
        })
        return this.refreshVisibility()
      })
      .catch((err: unknown) => {
        this.ctx.logger.warn('export-alexa: expose sync failed', {
          meta: { deviceId, error: errMsg(err) },
        })
      })
  }

  private async unexposeDevice(deviceIdRaw: string): Promise<void> {
    const deviceId = Number.parseInt(deviceIdRaw, 10)
    if (!Number.isFinite(deviceId)) return // idempotent on bogus input

    const next = this.config.exposed.filter((e) => e.deviceId !== deviceId)
    if (next.length === this.config.exposed.length) return // already absent
    await this.updateGlobalSettings({ exposed: next })
    this.ctx.logger.info('export-alexa: unexposed device', {
      meta: { deviceId },
    })
    // DeleteReport for this device's stored endpoint ids + drop it from
    // `exportedEndpoints`.
    void this.requireSyncEngine()
      .removeDevice(deviceId)
      .catch((err: unknown) => {
        this.ctx.logger.warn('export-alexa: unexpose delete failed', {
          meta: { deviceId, error: errMsg(err) },
        })
      })
  }

  /**
   * Build the Alexa endpoint objects for ONE exposed device. The single push
   * path the SyncEngine uses — reuses the same per-device builder the on-demand
   * `Discover` handler uses.
   */
  private async buildEndpointsForOneDevice(deviceId: number): Promise<readonly AlexaEndpoint[]> {
    const classSource = this.detectionClassSource
    const vision = this.vision
    // One pipeline read per build, shared by both surfaces so they never
    // disagree about what the camera detects.
    let available: Promise<readonly DetectionSensorClass[]> | null = null
    const classesOf = (id: number): Promise<readonly DetectionSensorClass[]> => {
      available ??= classSource === null ? Promise.resolve([]) : classSource.classesFor(id)
      return available
    }
    return buildEndpointsForExposedDevice(deviceId, {
      ctx: this.ctx,
      logger: this.ctx.logger,
      snapshots: this.config.snapshots,
      // D778: offered (the pipeline) ∩ chosen (the camera's saved selection).
      ...(this.config.detectionSensors
        ? {
            detectionClasses: async (id: number) =>
              effectiveSensorClasses(
                await classesOf(id),
                parseSensorSelection(await vision.readPrefs(id)),
              ),
          }
        : {}),
      // D875: the operator's Alexa name, same endpoint id.
      alexaName: async (id: number) => readAlexaName(await vision.readPrefs(id)),
      // D779: the camera's object detection + history.
      ...(this.config.objectDetection
        ? {
            objectDetection: async (id: number) => vision.buildClasses(id, await classesOf(id)),
          }
        : {}),
    })
  }

  /** The settings that change every exposed endpoint's shape, as one key. */
  private shapeSwitches(): string {
    return JSON.stringify({
      detectionSensors: this.config.detectionSensors,
      snapshots: this.config.snapshots,
      objectDetection: this.config.objectDetection,
    })
  }

  /**
   * A shape switch was flipped: re-push every exposed device. The signature
   * reconcile pushes only what changed, and the push retires the endpoints a
   * device no longer builds (the detection sensors, when switched off).
   */
  protected override async onConfigChanged(): Promise<void> {
    const now = this.shapeSwitches()
    if (this.appliedShapeSwitches === null || now === this.appliedShapeSwitches) return
    this.appliedShapeSwitches = now
    // Switched off: every URL already handed to Alexa dies now, not in ten
    // minutes (the route also refuses while off).
    if (!this.config.snapshots) this.snapshotStore.clear()
    this.ctx.logger.info(
      'export-alexa: an endpoint-shape switch changed — re-syncing every device',
      {
        meta: { switches: now },
      },
    )
    const engine = this.syncEngine
    if (engine === null) return
    void engine.reconcileAllExposed().catch((err: unknown) => {
      this.ctx.logger.warn('export-alexa: re-sync after a switch change failed', {
        meta: { error: errMsg(err) },
      })
    })
  }

  private scheduleDetectionClassRefresh(): void {
    const timer = setInterval(() => {
      // Both surfaces follow the camera's classes (package support comes and
      // goes with its package zone).
      if (!this.config.detectionSensors && !this.config.objectDetection) return
      void this.requireSyncEngine()
        .reconcileAllExposed()
        .catch((err: unknown) => {
          this.ctx.logger.warn('export-alexa: detection-class refresh failed', {
            meta: { error: errMsg(err) },
          })
        })
    }, DETECTION_CLASS_REFRESH_MS)
    timer.unref?.()
    this.ctx.addDisposer(async () => clearInterval(timer))
  }

  private get vision(): AlexaVisionRuntime {
    if (!this.visionRef) throw new Error('export-alexa: vision runtime not initialized')
    return this.visionRef
  }

  private get visibility(): AccountVisibilityMirror {
    if (!this.visibilityRef) throw new Error('export-alexa: visibility mirror not initialized')
    return this.visibilityRef
  }

  /** The endpoints one linked account may be sent (S1). `null` = its user's
   *  grants are unreadable right now; a deleted user is sent nothing. */
  private async filterForAccount(
    userId: string,
    endpoints: readonly AlexaEndpoint[],
  ): Promise<readonly AlexaEndpoint[] | null> {
    const lookup = await this.accessGate.principal(userId)
    if (lookup.kind === 'unavailable') return null
    if (lookup.kind === 'unknown-user') return []
    const filtered = await filterEndpointsForPrincipal(
      endpoints,
      lookup.principal,
      this.endpointAccess,
    )
    return filtered.kept
  }

  /** One visibility pass, applied to Alexa. Never throws. */
  private async refreshVisibility(): Promise<void> {
    try {
      const changes = await this.visibility.refresh()
      await applyVisibilityChanges(changes, this.requireSyncEngine(), this.ctx.logger)
    } catch (err) {
      this.ctx.logger.warn('export-alexa: visibility refresh failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  private scheduleVisibilityRefresh(): void {
    const first = setTimeout(() => void this.refreshVisibility(), BOOT_VISIBILITY_DELAY_MS)
    first.unref?.()
    const every = setInterval(() => void this.refreshVisibility(), VISIBILITY_REFRESH_INTERVAL_MS)
    every.unref?.()
    this.ctx.addDisposer(async () => {
      clearTimeout(first)
      clearInterval(every)
    })
  }

  /** An account-link token's hub user, or null — the snapshot route's
   *  credential check (the same verification `/directive` runs). */
  private async verifyAccountLinkToken(token: string): Promise<{ userId: string } | null> {
    const raw: unknown = await this.ctx.api.userManagement.oauthVerifyAccessToken.query({ token })
    const parsed = VerifiedTokenSchema.safeParse(raw)
    return parsed.success && parsed.data !== null ? { userId: parsed.data.userId } : null
  }

  private get accessGate(): AlexaAccessGate {
    if (!this.accessGateRef) throw new Error('export-alexa: access gate not initialized')
    return this.accessGateRef
  }

  /** The exposed set + the user gate, as every enforcement point reads them. */
  private get endpointAccess(): EndpointAccessDeps {
    return {
      gate: this.accessGate,
      isExposed: (deviceId) => this.config.exposed.some((e) => e.deviceId === deviceId),
    }
  }

  /** Narrow the nullable `lwaGateway` for the SyncEngine post closures. It is
   *  constructed + started in `onInitialize` before the SyncEngine, so its
   *  `postReport` is always reachable when the engine pushes. */
  private requireGateway(): LwaEventGateway {
    if (!this.lwaGateway) {
      throw new Error('export-alexa: lwa gateway not initialized')
    }
    return this.lwaGateway
  }

  /** Narrow the nullable `syncEngine` for the trigger call sites. It is
   *  constructed in `onInitialize` right after the gateway starts, so any
   *  trigger (expose / unexpose / link / removal) runs after it exists. */
  private requireSyncEngine(): SyncEngine {
    if (!this.syncEngine) {
      throw new Error('export-alexa: sync engine not initialized')
    }
    return this.syncEngine
  }

  /** Manual "Re-sync devices" button — awaited so the form gets the counts.
   *  Pushes EVERY exposed device to every linked account unconditionally. */
  /**
   * Reconcile ONE device's Alexa endpoint shape whenever its capability
   * bindings change. Debounced per device so the burst a provider respawn
   * produces (one event per cap) collapses into a single rebuild, and so the
   * reconcile reads the bindings AFTER the burst settles rather than in the
   * middle of it.
   */
  private subscribeBindingsChangedForReconcile(): void {
    const off = this.ctx.eventBus.subscribe(
      { category: EventCategory.DeviceBindingsChanged },
      (event) => {
        const deviceId = (event.data as { deviceId?: unknown } | null)?.deviceId
        if (typeof deviceId !== 'number') return
        if (!this.config.exposed.some((e) => e.deviceId === deviceId)) return
        const pending = this.pendingReconcileTimers.get(deviceId)
        if (pending) clearTimeout(pending)
        const timer = setTimeout(() => {
          this.pendingReconcileTimers.delete(deviceId)
          void this.reconcileDeviceDiscovery(deviceId)
        }, BINDINGS_RECONCILE_DEBOUNCE_MS)
        if (typeof timer.unref === 'function') timer.unref()
        this.pendingReconcileTimers.set(deviceId, timer)
      },
    )
    this.ctx.addDisposer(async () => {
      off()
      for (const timer of this.pendingReconcileTimers.values()) clearTimeout(timer)
      this.pendingReconcileTimers.clear()
    })
  }

  /**
   * One reconcile pass over every exposed device shortly after boot. This is
   * what heals a shape that drifted while the addon was DOWN (or under an
   * older build that had no signature at all) with no operator click — the
   * doorbell bound on 101 after it was exposed is exactly that case. Deliberately late
   * enough that device providers have registered their caps: a device whose
   * bindings have not landed yet builds a shape we must not push.
   */
  private scheduleBootDiscoveryReconcile(): void {
    const timer = setTimeout(() => {
      void this.requireSyncEngine()
        .reconcileAllExposed()
        .then((r) => {
          this.ctx.logger.info('export-alexa: boot discovery reconcile', {
            meta: {
              checked: r.checkedDeviceIds.length,
              pushed: r.pushedDeviceIds,
            },
          })
        })
        .catch((err: unknown) => {
          this.ctx.logger.warn('export-alexa: boot discovery reconcile failed', {
            meta: { error: errMsg(err) },
          })
        })
    }, BOOT_RECONCILE_DELAY_MS)
    if (typeof timer.unref === 'function') timer.unref()
    this.ctx.addDisposer(async () => clearTimeout(timer))
  }

  /** Run (and report) one device's discovery reconcile. Never throws. */
  private async reconcileDeviceDiscovery(deviceId: number): Promise<void> {
    try {
      const r = await this.requireSyncEngine().reconcileDevice(deviceId)
      if (!r.pushed) {
        this.ctx.logger.debug(
          'export-alexa: bindings changed but the Alexa endpoint shape is unchanged — no re-push',
          { tags: { deviceId } },
        )
      }
    } catch (err: unknown) {
      this.ctx.logger.warn('export-alexa: bindings-change discovery reconcile failed', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * The Re-sync button: every exposed device re-sent, and the devices still
   * tracked but no longer exposed deleted from Alexa (`SyncEngine.resync`).
   * Throws when nothing can be sent, so the button says why.
   */
  private async resyncDiscovery(): Promise<ResyncResult> {
    if (this.config.linkedAccounts.length === 0) {
      throw new Error('No linked Amazon account. Link the skill from the Alexa app first.')
    }
    if (this.config.tokens.length === 0) {
      throw new Error(
        'No Amazon push grant is stored for the linked account, so nothing can be sent. Re-link the skill from the Alexa app.',
      )
    }
    const r = await this.requireSyncEngine().resync()
    this.ctx.logger.info('export-alexa: manual discovery re-sync', {
      meta: { ...r },
    })
    return r
  }

  // ── Account unlink ──────────────────────────────────────────────

  /**
   * Sever the Amazon account link. Backs the "Unlink Amazon account" button.
   *
   * Two halves, in this order, because they fail differently:
   *
   *   1. **The hub-side session.** `oauthExchangeCode` writes one
   *      `oauth_sessions` row per completed link and never retires the
   *      previous one, and `buildAlexaOauthIntegration` sets
   *      `refreshTokenTtlSec: 'never'` — so nothing expires and revocation is
   *      the ONLY severance. `oauthRefresh` AND `oauthVerifyAccessToken` both
   *      re-read the row, so a revoked session fails the very next directive,
   *      not an hour later. We revoke EVERY active `export-alexa` row.
   *
   *   2. **The Amazon-side push grant this addon owns.** Revoking the hub
   *      session does not touch it: the LWA refresh token is Amazon's, and the
   *      Event Gateway would keep pushing motion and doorbell events at the
   *      unlinked account until Amazon happened to answer 403. Nobody else
   *      stores it, so clearing it here is not a second registry of the link —
   *      it IS the authority for that half.
   *
   * `exportedEndpoints` / `exportedSignatures` go with them: they mean "what
   * Alexa was last told", and after an unlink Alexa has been told nothing. A
   * stale signature would otherwise suppress the reconcile's re-push on the
   * next link.
   *
   * Deliberately does NOT send a `DeleteReport` first. Amazon drops the
   * endpoints itself when the account is unlinked, and a purge needs the very
   * token we are about to discard — a best-effort push here would make the
   * result claim work it cannot verify. Use "Remove ids from Alexa" if
   * ghosts survive.
   */
  private async unlinkAlexaAccounts(): Promise<UnlinkAlexaResult> {
    const rawSessions: unknown = await this.ctx.api.userManagement.listOauthSessions.query()
    const parsed = OauthSessionListSchema.safeParse(rawSessions)
    if (!parsed.success) {
      throw new Error(
        `export-alexa: listOauthSessions returned an unrecognised shape — refusing to unlink: ${parsed.error.message}`,
      )
    }
    const ids = selectAlexaSessionIdsToRevoke(parsed.data)

    let revokedSessions = 0
    for (const id of ids) {
      const result = await this.ctx.api.userManagement.revokeOauthSession.mutate({ id })
      if (result.success) {
        revokedSessions += 1
        continue
      }
      // A session the store no longer knows fails closed exactly like a revoked
      // one, so this is not fatal — but it must not be silent, or the reported
      // count would be the only trace.
      this.ctx.logger.warn(
        'export-alexa: revokeOauthSession reported failure — the session may already be gone',
        { meta: { sessionId: id } },
      )
    }

    // Delete each link at the skill's broker too, so the refresh token it holds
    // for this hub dies with the link. Best-effort: an unreachable broker must
    // not block the unlink (the item still expires on its idle TTL).
    await this.revokeAtBroker(this.config.tokens)

    const removedAccounts = this.config.linkedAccounts.length
    await this.updateGlobalSettings({
      linkedAccounts: [],
      tokens: [],
      exportedEndpoints: {},
      exportedSignatures: {},
      accountVisibility: {},
    })
    this.ctx.logger.warn('export-alexa: operator unlinked the Amazon account(s)', {
      meta: { revokedSessions, sessionsFound: ids.length, removedAccounts },
    })
    return { revokedSessions, removedAccounts }
  }

  // ── LWA token writers (called by the /oauth/lwa-tokens callback) ──

  private async upsertToken(input: UpsertLwaTokenInput): Promise<void> {
    const entry: LwaTokenEntry = {
      userId: input.userId,
      accessToken: input.accessToken,
      expiresAt: input.expiresAt,
      receivedAt: Date.now(),
      ...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
      ...(input.brokerUrl ? { brokerUrl: input.brokerUrl } : {}),
      ...(input.brokerCredential ? { brokerCredential: input.brokerCredential } : {}),
    }
    const next: LwaTokenEntry[] = this.config.tokens.filter((t) => t.userId !== input.userId)
    next.push(entry)
    await this.updateGlobalSettings({ tokens: next })
  }

  private async removeLinkedAccount(userId: string): Promise<void> {
    await this.updateGlobalSettings({
      tokens: this.config.tokens.filter((t) => t.userId !== userId),
      linkedAccounts: this.config.linkedAccounts.filter((a) => a.userId !== userId),
    })
    this.ctx.logger.warn('export-alexa: unlinked revoked account', {
      meta: { userId },
    })
  }

  private async recordLinkedAccount(input: { userId: string; username: string }): Promise<void> {
    if (this.config.linkedAccounts.some((a) => a.userId === input.userId)) {
      return // idempotent — already recorded
    }
    const next: LinkedAccount[] = [
      ...this.config.linkedAccounts,
      { userId: input.userId, username: input.username, linkedAt: Date.now() },
    ]
    await this.updateGlobalSettings({ linkedAccounts: next })
    // A genuinely new account has none of our exposed devices yet — push them
    // all to this one account so the operator's cameras appear immediately in
    // the freshly-linked Alexa app (no manual "Discover Devices"). Only on the
    // non-idempotent branch, so an existing account re-confirming the link
    // doesn't re-push.
    //
    // The engine may be absent during boot `backfillLinkedAccounts` (which runs
    // before the engine is constructed); those accounts are pre-existing links
    // from prior boots and already synced, so skipping the push is correct.
    const engine = this.syncEngine
    if (!engine) return
    void engine
      .pushAllToAccount(input.userId)
      .then((r) => {
        this.ctx.logger.info('export-alexa: pushed to newly linked account', {
          meta: { ...r },
        })
        return this.refreshVisibility()
      })
      .catch((err: unknown) => {
        this.ctx.logger.warn('export-alexa: new-account push failed', {
          meta: { userId: input.userId, error: errMsg(err) },
        })
      })
  }

  /**
   * Record a linked account for any stored LWA token whose userId isn't yet in
   * linkedAccounts. Username falls back to the userId (cosmetic — the stored
   * token carries none). Idempotent via recordLinkedAccount.
   */
  private async backfillLinkedAccounts(): Promise<void> {
    const linked = new Set(this.config.linkedAccounts.map((a) => a.userId))
    const missing = this.config.tokens.filter((t) => !linked.has(t.userId))
    for (const t of missing) {
      await this.recordLinkedAccount({ userId: t.userId, username: t.userId })
    }
    if (missing.length > 0) {
      this.ctx.logger.info('export-alexa: backfilled linked accounts from stored LWA tokens', {
        meta: { count: missing.length },
      })
    }
  }

  // ── Effective settings (public-skill overlay) ───────────────────

  /** Settings as the runtime reads them (`effectiveAlexaSettings`). */
  private effectiveSettings(): AlexaSettings {
    return effectiveAlexaSettings(this.config)
  }

  // ── Skill token broker (D753) ───────────────────────────────────

  /** Persist the broker origin the Lambda advertised on a verified directive. */
  private rememberAdvertisedBroker(raw: string): void {
    const url = normaliseBrokerUrl(raw)
    if (!url) {
      this.ctx.logger.warn(
        'export-alexa: ignored a broker advertisement that is not an https origin',
      )
      return
    }
    if (url === this.config.advertisedBrokerUrl) return
    void this.updateGlobalSettings({ advertisedBrokerUrl: url })
      .then(() => {
        this.ctx.logger.info('export-alexa: the skill Lambda advertised its token broker', {
          meta: { brokerUrl: url },
        })
      })
      .catch((err: unknown) => {
        this.ctx.logger.warn('export-alexa: could not store the advertised broker URL', {
          meta: { error: errMsg(err) },
        })
      })
  }

  private async revokeAtBroker(tokens: readonly LwaTokenEntry[]): Promise<void> {
    for (const t of tokens) {
      if (!isBrokerGrant(t)) continue
      await revokeBrokerCredential(fetch, t.brokerUrl, t.brokerCredential).catch((err: unknown) => {
        this.ctx.logger.warn(
          'export-alexa: could not delete the link at the skill broker — it expires there on its own',
          { meta: { userId: t.userId, error: errMsg(err) } },
        )
      })
    }
  }

  /**
   * Swap every broker credential this hub holds for a fresh one. The old
   * credential stops working at the broker immediately. A credential the
   * broker no longer recognises is reported, not retried — re-link instead.
   */
  private async rotateBrokerCredentials(): Promise<{
    rotated: number
    failed: number
  }> {
    if (!this.config.tokens.some(isBrokerGrant)) {
      throw new Error(
        "No link is held at the skill's token broker, so there is no credential to rotate. Link the skill from the Alexa app first.",
      )
    }
    let rotated = 0
    let failed = 0
    for (const t of this.config.tokens) {
      if (!isBrokerGrant(t)) continue
      try {
        const next = await rotateBrokerCredential(fetch, t.brokerUrl, t.brokerCredential)
        await this.upsertToken({
          userId: t.userId,
          accessToken: t.accessToken,
          expiresAt: t.expiresAt,
          brokerUrl: t.brokerUrl,
          brokerCredential: next,
        })
        rotated += 1
      } catch (err) {
        failed += 1
        this.ctx.logger.warn('export-alexa: broker credential rotation failed', {
          meta: {
            userId: t.userId,
            kind: err instanceof BrokerError ? err.kind : 'unavailable',
            error: errMsg(err),
          },
        })
      }
    }
    this.ctx.logger.info('export-alexa: broker credentials rotated', {
      meta: { rotated, failed },
    })
    return { rotated, failed }
  }

  // ── Public hub URL auto-detect ──────────────────────────────────

  /**
   * Resolve the hub's public HTTPS URL by querying the `network-access`
   * collection cap's `listEndpoints` aggregate.
   *
   * `network-access` is a proper codegen'd collection capability
   * (`scope: 'system'`) so it IS reachable cross-process via `ctx.api` —
   * unlike the `addons` core cap, which is a hub-side core tRPC router
   * NOT advertised as a Moleculer service: a forked addon (export-alexa
   * runs forked) calling `ctx.api.addons.*` would hang forever.
   *
   * `listEndpoints` with no `addonId` aggregates active ingress endpoints
   * across every connected `network-access` provider. We take the first
   * HTTPS entry. `listEndpoints` is optional on a provider (the cap doc
   * says single-endpoint providers may omit it), so we fall back to the
   * aggregate `getStatus` when `listEndpoints` yields nothing. Returns an
   * empty string when none is available — the caller persists it as-is;
   * the addon degrades gracefully (no public URL → directive endpoints
   * unset) but never hangs.
   */
  private async resolveEndpoints(): Promise<string[]> {
    const fromList = await this.detectAllFromListEndpoints()
    if (fromList.length > 0) return fromList
    const single = await this.detectFromGetStatus()
    if (single.length > 0) return [single]
    this.ctx.logger.warn(
      'export-alexa: no connected HTTPS remote-access endpoint — Alexa Lambda has no hub URL to route to. Set up Cloudflare Tunnel / Tailscale Funnel; the External address picker on the Alexa page lists it once connected.',
    )
    return []
  }

  /** Aggregate `listEndpoints` → every HTTPS entry's url, de-duplicated. */
  private async detectAllFromListEndpoints(): Promise<string[]> {
    try {
      const endpoints = await this.ctx.api.networkAccess.listEndpoints.query({})
      const urls = endpoints
        .filter((e) => e.protocol === 'https' && e.url.length > 0)
        .map((e) => this.normaliseHubUrl(e.url))
      return [...new Set(urls)]
    } catch (err) {
      this.ctx.logger.debug('export-alexa: networkAccess.listEndpoints failed', {
        meta: { error: errMsg(err) },
      })
      return []
    }
  }

  /** Aggregate `getStatus` → connected HTTPS endpoint's url. '' on failure. */
  private async detectFromGetStatus(): Promise<string> {
    try {
      // `networkAccess.getStatus`'s codegen'd wire output is `unknown`
      // (collection cap, loose object output) — safeParse narrows it to a
      // typed `NetworkAccessStatus` without a cast.
      const raw = await this.ctx.api.networkAccess.getStatus.query({})
      const parsed = NetworkAccessStatusSchema.safeParse(raw)
      const status = parsed.success ? parsed.data : null
      const endpoint = status?.endpoint
      if (
        !status?.connected ||
        !endpoint ||
        endpoint.protocol !== 'https' ||
        endpoint.url.length === 0
      ) {
        return ''
      }
      return this.normaliseHubUrl(endpoint.url)
    } catch (err) {
      this.ctx.logger.debug('export-alexa: networkAccess.getStatus failed', {
        meta: { error: errMsg(err) },
      })
      return ''
    }
  }

  /**
   * Boot-time best-effort: default the external address to the first
   * detected endpoint when the operator hasn't chosen one. The picker reads
   * its options live, so nothing is cached here.
   */
  private async autoDetectPublicHubUrl(): Promise<void> {
    if (this.config.publicHubUrl) return
    const endpoints = await this.resolveEndpoints()
    const defaulted = endpoints[0]
    if (defaulted) {
      await this.updateGlobalSettings({ publicHubUrl: defaulted })
      this.ctx.logger.info('export-alexa: defaulted public hub URL to first external address', {
        meta: { url: defaulted },
      })
    }
  }

  /**
   * Re-scan the connected `network-access` providers and keep the
   * operator's current selection when it's still present (otherwise default
   * to the first). Runs when a tunnel connects and behind the
   * `/admin/redetect-hub-url` route. Returns the URL we landed on (empty
   * string when nothing is connected).
   */
  async redetectPublicHubUrl(): Promise<{ publicHubUrl: string }> {
    const endpoints = await this.resolveEndpoints()
    const keep = this.config.publicHubUrl.length > 0 && endpoints.includes(this.config.publicHubUrl)
    const publicHubUrl = keep ? this.config.publicHubUrl : (endpoints[0] ?? '')
    if (publicHubUrl !== this.config.publicHubUrl) await this.updateGlobalSettings({ publicHubUrl })
    return { publicHubUrl }
  }

  /**
   * Rotate the ingress token, invalidating the old value. The operator must
   * paste the new token into their Lambda's HUB_INGRESS_TOKEN env afterwards.
   * Backs the "Regenerate token" settings button.
   */
  async regenerateIngressToken(): Promise<{ ingressToken: string }> {
    const ingressToken = generateIngressToken()
    await this.updateGlobalSettings({ ingressToken })
    this.ctx.logger.info('export-alexa: regenerated ingress token')
    return { ingressToken }
  }

  private normaliseHubUrl(raw: string): string {
    return raw.replace(/\/+$/, '')
  }

  // ── Export setup block ──────────────────────────────────────────

  /**
   * Build the generic `device-export` `setup` block surfaced via
   * `getStatus` and rendered by the shared `DeviceExportPanel`: the
   * OAuth client id/secret, the account-linking endpoint URLs derived
   * from the public hub URL, and the linked-account count. Each row
   * gets a copy button in the panel; the secret rows are masked.
   */
  private buildSetupBlock(): ExportSetup {
    return buildAlexaSetupBlock({
      publicHubUrl: this.config.publicHubUrl,
      ingressToken: this.config.ingressToken,
      skillMode: this.config.skillMode,
    })
  }

  /**
   * The "External address" picker's options, read live: every HTTPS endpoint
   * the connected remote-access providers report now, plus the saved choice
   * when it is not among them, so a manual pick is never dropped from view.
   */
  private async listExternalAddresses(): Promise<{
    addresses: readonly { value: string; label: string }[]
  }> {
    const detected = await this.resolveEndpoints()
    const current = this.config.publicHubUrl
    const addresses = detected.map((url) => ({ value: url, label: url }))
    return {
      addresses:
        current.length > 0 && !detected.includes(current)
          ? [...addresses, { value: current, label: `${current} (not detected now)` }]
          : addresses,
    }
  }

  // ── Settings UI ─────────────────────────────────────────────────

  /** The settings page: see `settings-schema.ts` for its layout. The account-
   *  linking rows live in the `device-export` setup block instead. */
  protected globalSettingsSchema(): ConfigUISchema {
    return {
      sections: buildAlexaSettingsSections({
        linkedAccounts: this.config.linkedAccounts,
        tokens: this.config.tokens,
        now: Date.now(),
        defaults: DEFAULT_CONFIG,
      }),
    }
  }

  /**
   * One sweep: ask the broker which held sessions are still alive, and release
   * the transcodes the dead ones are still holding.
   */
  private async reapDeadEgressHandles(): Promise<void> {
    const held = heldEgressHandles()
    if (held.length === 0) return
    const dead = await reapDeadEgressHandles({
      held,
      isAlive: async (handle) => {
        try {
          const state = await this.ctx.api.webrtcSession.getSessionState.query({
            deviceId: handle.deviceId,
            sessionId: handle.sessionId,
          })
          return state.alive
        } catch {
          // A read that failed is NOT a death. Keeping a live session's
          // transcode costs a process; releasing it blacks out a working Echo.
          return null
        }
      },
    })
    for (const handle of dead) {
      logReaped(this.ctx.logger, handle)
      forgetEgressHandle(handle)
      await releaseAlexaEgress({
        api: this.ctx.api,
        deviceId: handle.deviceId,
        pipelineKey: handle.pipelineKey,
        logger: this.ctx.logger,
      }).catch(() => {
        // `releaseAlexaEgress` never throws by contract; the catch is here so a
        // future change to it cannot take the sweep down with it.
      })
    }
  }

  // ── Device-details contribution ─────────────────────────────────
  //
  // Contributes the per-device "Alexa Export" section to the device-
  // details page. Camera-only — Alexa export only knows how to surface
  // cameras / doorbells today (see SUPPORTED_KINDS).

  private async buildDeviceSettingsContribution(
    deviceId: number,
  ): Promise<ConfigUISchemaWithValues | null> {
    const kind = await this.exportKindOf(deviceId)
    if (kind === null) return null
    const entry = this.findEntry(deviceId)
    const settings = entry?.settings ?? DEFAULT_DEVICE_SETTINGS
    const enabled = entry !== null
    // Field keys are namespaced per exporter — the device-aggregate form
    // flattens fields by `key` across sections, so a generic `'enabled'`
    // / `'streamPreference'` would collide with HAP's same-named fields.
    // Last-writer-wins meant the Alexa switch rendered HAP's value (and
    // Alexa toggles routed to HAP's writer). Namespacing keeps each
    // exporter's form state isolated.
    const enabledKey = `alexa:${deviceId}:enabled`
    const linkedCount = this.config.linkedAccounts.length
    const statusLabel = enabled
      ? `Exposed${linkedCount > 0 ? `, ${linkedCount} linked Alexa account(s)` : ' (no linked Alexa account yet)'}`
      : linkedCount > 0
        ? `${linkedCount} linked Alexa account(s) — device not exposed`
        : 'Not exposed'
    const alexaExportSection: ConfigSectionWithValues = {
      id: 'export-alexa',
      title: 'Alexa Export',
      description:
        kind === 'camera'
          ? 'Surface this camera to the linked Alexa Smart Home skill.'
          : 'Surface this device to the linked Alexa Smart Home skill (locks, sensors, switches and lights each become one Alexa device).',
      tab: 'export',
      columns: 1,
      order: 20,
      fields: [
        {
          type: 'info' as const,
          key: '__alexa-status',
          label: 'Status',
          content: statusLabel,
          variant: 'info' as const,
        },
        {
          type: 'boolean' as const,
          key: enabledKey,
          label: 'Expose to Alexa',
          description: 'Toggle to mirror this device onto the Alexa Smart Home skill.',
          style: 'switch' as const,
          value: enabled,
          // Auto-save on click — single toggle has no draft state to
          // review and the operator expects the action to fire on
          // release. Mirrors the HAP Expose toggle behaviour; without
          // this the form sits with a dirty "Save" pending while the
          // expose / unexpose lifecycle (including the
          // AddOrUpdateReport / DeleteReport push to the Alexa Event
          // Gateway) is gated on a manual save click.
          immediate: true,
        },
        await this.alexaNameField(deviceId, enabledKey),
        ...(kind === 'camera' ? this.cameraOnlyExportFields(deviceId, settings, enabledKey) : []),
        ...(kind === 'camera' ? await this.cameraDetectionFields(deviceId, enabledKey) : []),
      ],
    }
    return {
      tabs: [{ id: 'export', label: 'Export', icon: 'share-2', order: 80 }],
      sections: [alexaExportSection],
    }
  }

  /** D875: the "Alexa name" field, with the validation error of the saved value. */
  private async alexaNameField(
    deviceId: number,
    enabledKey: string,
  ): Promise<ConfigSectionWithValues['fields'][number]> {
    const saved = readAlexaName(await this.vision.readPrefs(deviceId))
    return {
      type: 'text' as const,
      key: alexaNameKey(deviceId),
      label: 'Alexa name',
      description: `What Alexa calls this device. Leave empty to use the device name. Letters, digits and spaces only (no punctuation), up to ${ALEXA_NAME_MAX_LENGTH} characters. Renaming updates the same Alexa device; it does not create a duplicate.`,
      value: saved ?? '',
      showWhen: { field: enabledKey, equals: true },
    }
  }

  /**
   * The camera's detection fields: which classes become Alexa sensors (D778;
   * only the classes its pipeline produces are offered) and its object
   * detection toggle (D779).
   */
  private async cameraDetectionFields(
    deviceId: number,
    enabledKey: string,
  ): Promise<ConfigSectionWithValues['fields']> {
    const store = await this.vision.readPrefs(deviceId)
    const available =
      this.detectionClassSource === null
        ? []
        : await this.detectionClassSource.classesFor(deviceId).catch(() => [])
    return [
      sensorSelectionField({
        deviceId,
        available,
        saved: parseSensorSelection(store),
        enabledKey,
        masterOn: this.config.detectionSensors,
      }),
      objectDetectionField({
        deviceId,
        store,
        enabledKey,
        integrationOn: this.config.objectDetection,
      }),
    ]
  }

  /**
   * D875: save the Alexa name from a device-settings patch. A name Amazon would
   * refuse throws BEFORE anything is written, so the form shows the reason and
   * the old name stays. True when the saved name changed.
   */
  private async applyAlexaNamePatch(
    deviceId: number,
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    const key = alexaNameKey(deviceId)
    if (!(key in patch)) return false
    const check = validateAlexaName(patch[key])
    if (!check.ok) throw new Error(`export-alexa: ${check.error}`)
    const before = readAlexaName(await this.vision.readPrefs(deviceId))
    if (before === check.name) return false
    await this.vision.writePrefs(deviceId, {
      [ALEXA_NAME_KEY]: check.name ?? undefined,
    })
    this.ctx.logger.info('export-alexa: Alexa name saved', {
      tags: { deviceId },
      meta: { name: check.name },
    })
    return true
  }

  /**
   * Persist the camera's detection preferences from a device-settings patch
   * into this addon's per-device store. True when anything changed — the
   * camera's Alexa shape then needs a reconcile.
   */
  private async applyDetectionPrefsPatch(
    deviceId: number,
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    const selectionKey = sensorSelectionKey(deviceId)
    const odKey = objectDetectionKey(deviceId)
    const write: Record<string, unknown> = {}
    if (selectionKey in patch) {
      write[SENSOR_SELECTION_KEY] = sensorSelectionFromPatch(patch[selectionKey])
    }
    if (odKey in patch) write[OBJECT_DETECTION_KEY] = Boolean(patch[odKey])
    if (Object.keys(write).length === 0) return false
    await this.vision.writePrefs(deviceId, write)
    this.ctx.logger.info('export-alexa: camera detection preferences saved', {
      tags: { deviceId },
      meta: { ...write },
    })
    return true
  }

  /** The stream fields of the Export section — a camera's only. */
  private cameraOnlyExportFields(
    deviceId: number,
    settings: ExportDeviceSettings,
    enabledKey: string,
  ): ConfigSectionWithValues['fields'] {
    const streamPreferenceKey = `alexa:${deviceId}:streamPreference`
    const allowTranscodeKey = `alexa:${deviceId}:allowTranscode`
    return [
      {
        // Single source-stream picker. Pinned to the three camstack
        // profile slots (`high`/`mid`/`low`) plus the smart-`auto`
        // fallback — NOT raw native camStream ids. The runtime
        // picker (`pickPreferredRtspEntry`) translates the choice to
        // a broker brokerId at session start; on `auto` it picks the
        // slot closest to the Echo's 720p sweet spot (downscale-only).
        type: 'select' as const,
        key: streamPreferenceKey,
        label: 'Source stream (Alexa / Echo)',
        description:
          'Which camstack profile slot the Echo pulls. Auto = the broker picks the slot closest to 720p at session start (the Echo doesn’t adapt mid-session, so pin a specific profile if Auto picks badly on your hardware).',
        options: STREAM_PREFERENCE_OPTIONS,
        required: true,
        value: settings.streamPreference,
        showWhen: { field: enabledKey, equals: true },
        // Auto-save: same rationale as the HAP source picker —
        // changing the source mid-life triggers an unexpose +
        // re-expose so the new RTSP profile takes effect. Operator
        // intent is "apply now".
        immediate: true,
      },
      {
        // What the operator is willing to SPEND, not what they want to see.
        // With it off, only a stream the Echo can take as it stands is
        // eligible, and a camera that publishes nothing suitable is refused
        // out loud rather than transcoded behind their back.
        type: 'boolean' as const,
        key: allowTranscodeKey,
        label: 'Allow transcoding for Alexa',
        description:
          'Let the hub re-encode this camera for the Echo when no stream is directly usable. Off means only a stream Alexa can take as-is (H.264, 480p-1080p) is offered — cheaper, but a camera that publishes only H.265, or only a small sub-stream, will not be streamable to Alexa at all.',
        style: 'switch' as const,
        value: settings.allowTranscode !== false,
        showWhen: { field: enabledKey, equals: true },
        immediate: true,
      },
    ]
  }

  /**
   * Apply a patch produced by the device-details "Export" panel. Flips
   * the expose/unexpose lifecycle on `enabled` transitions and persists
   * the addon-specific preferences. Live `streamPreference` updates do
   * NOT propagate to Alexa today — the skill caches the stream URL in
   * its directive cache, and "swap stream without re-discovery" needs
   * an Alexa.ChangeReport on the camera endpoint. For the first
   * iteration we unexpose + re-expose so the next discovery picks up
   * the new preference. See remaining-work notes in CLAUDE.md.
   */
  private async applyDeviceSettingsPatch(
    deviceId: number,
    patch: Record<string, unknown>,
  ): Promise<{ success: true }> {
    const idStr = String(deviceId)
    const current = this.findEntry(deviceId)
    const wasEnabled = current !== null
    // D778/D779: saved first, so an expose in this same patch builds with it.
    const prefsChanged = await this.applyDetectionPrefsPatch(deviceId, patch)
    const nameChanged = await this.applyAlexaNamePatch(deviceId, patch)

    // `alexa:<id>:sourceProfile` had a writer here and no field anywhere — a
    // handler with no caller, describing a second pin for a function
    // `streamPreference` already owned. Removed with the read
    // (`rtc-session.ts`), which explains what the leftover cost. A stale
    // persisted value is now inert rather than invisibly authoritative.

    // ── Standard keys (enabled / streamPreference) ─────────────────
    // Both keys are namespaced per-exporter — see buildDeviceSettingsContribution.
    const enabledKey = `alexa:${deviceId}:enabled`
    const streamPreferenceKey = `alexa:${deviceId}:streamPreference`
    const allowTranscodeKey = `alexa:${deviceId}:allowTranscode`
    const enabledValue = enabledKey in patch ? Boolean(patch[enabledKey]) : wasEnabled
    const streamPreferenceRaw =
      streamPreferenceKey in patch
        ? patch[streamPreferenceKey]
        : current?.settings?.streamPreference
    const streamPreference: 'auto' | string =
      typeof streamPreferenceRaw === 'string' && streamPreferenceRaw.trim().length > 0
        ? streamPreferenceRaw
        : 'auto'
    const allowTranscode =
      allowTranscodeKey in patch
        ? Boolean(patch[allowTranscodeKey])
        : current?.settings?.allowTranscode !== false
    const nextSettings: ExportDeviceSettings = {
      ...(current?.settings ?? DEFAULT_DEVICE_SETTINGS),
      streamPreference,
      allowTranscode,
    }

    if (!enabledValue) {
      if (wasEnabled) {
        await this.unexposeDevice(idStr)
      }
      return { success: true as const }
    }

    if (!wasEnabled) {
      await this.exposeDevice(idStr)
      await this.patchEntrySettings(deviceId, nextSettings)
      return { success: true as const }
    }

    const currentPref = current?.settings?.streamPreference ?? 'auto'
    // The transcode switch changes WHICH SOURCE the next session scores to, so
    // it refreshes the exposure for the same reason the source picker does.
    const currentAllow = current?.settings?.allowTranscode !== false
    await this.patchEntrySettings(deviceId, nextSettings)
    const sourceChanged = currentPref !== streamPreference || currentAllow !== allowTranscode
    if (nameChanged && !sourceChanged) {
      // Same endpoint id: AddOrUpdateReport renames the device in Alexa. The
      // shape signature ignores names, so the reconcile would never send it.
      void this.requireSyncEngine()
        .pushDevice(deviceId)
        .catch((err: unknown) => {
          this.ctx.logger.warn('export-alexa: push after an Alexa name change failed', {
            tags: { deviceId },
            meta: { error: errMsg(err) },
          })
        })
    }
    if (prefsChanged && !sourceChanged) {
      // A class removed retires its sensor (DeleteReport, `mayRetire`); the
      // object-detection toggle re-sends the camera with or without it.
      void this.requireSyncEngine()
        .reconcileDevice(deviceId)
        .catch((err: unknown) => {
          this.ctx.logger.warn('export-alexa: re-sync after a detection preference change failed', {
            tags: { deviceId },
            meta: { error: errMsg(err) },
          })
        })
    }
    if (sourceChanged) {
      this.ctx.logger.info('export-alexa: source settings changed — refreshing exposure', {
        tags: { deviceId },
        meta: {
          streamPreference: { from: currentPref, to: streamPreference },
          allowTranscode: { from: currentAllow, to: allowTranscode },
        },
      })
      try {
        await this.unexposeDevice(idStr)
        await this.exposeDevice(idStr)
        await this.patchEntrySettings(deviceId, nextSettings)
      } catch (err) {
        this.ctx.logger.warn('export-alexa: failed to refresh after streamPreference change', {
          meta: { deviceId, error: errMsg(err) },
        })
      }
    }
    return { success: true as const }
  }

  /**
   * Which Export section a device gets: the camera one (with stream
   * settings), the generic one (on/off only — R5, D775), or none. An
   * unreadable device reads as a camera, as before.
   */
  private async exportKindOf(deviceId: number): Promise<'camera' | 'generic' | null> {
    try {
      const dev = await this.ctx.api.deviceManager.getDevice.query({
        deviceId,
      })
      if (!dev) return 'camera'
      const type = String(dev.type)
      if (type === DeviceType.Camera) return 'camera'
      return GENERIC_DEVICE_TYPES.includes(type) ? 'generic' : null
    } catch {
      return 'camera'
    }
  }

  private findEntry(deviceId: number): ExposedDeviceEntry | null {
    return this.config.exposed.find((e) => e.deviceId === deviceId) ?? null
  }

  private async patchEntrySettings(
    deviceId: number,
    settings: ExportDeviceSettings,
  ): Promise<void> {
    const next = this.config.exposed.map<ExposedDeviceEntry>((e) =>
      e.deviceId === deviceId ? { ...e, settings } : e,
    )
    await this.updateGlobalSettings({ exposed: next })
  }
}

export default ExportAlexaAddon
