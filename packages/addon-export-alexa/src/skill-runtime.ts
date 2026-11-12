/**
 * ONE Alexa skill at runtime (planning#422). A skill is an instance of the `skills` record plus
 * the rows that share its id: `skill-links` (who linked it), `skill-exports` (what it exposes)
 * and `skill-state` (its ingress token and what Alexa was last told). Everything the addon once
 * built once for "the" skill is built here once PER skill: the Event Gateway, the sync engine,
 * the vision runtime, the detection feed, the state reporters and their timers. The addon keeps
 * a map of these and routes each request to the right one.
 *
 * Shared by every skill, and therefore owned by the addon (the `host`): the snapshot store and
 * its signing key, the hub access gate, the public-endpoint reader and the addon-level settings.
 */
import { randomUUID } from 'node:crypto'
import {
  type AddonContext,
  type ConfigSectionWithValues,
  DeviceType,
  errMsg,
  EventCategory,
  type ExportSetupSchema,
  type RecordKindHandle,
  RecordSecretUnavailableError,
  readExposedName,
  exposedNameStoreOf,
} from '@camstack/types'
import type { z } from 'zod'

import { ActionSceneExports } from './action-scenes.js'
import type { AlexaAccessGate } from './access/access-gate.js'
import { AccountVisibilityMirror } from './access/account-visibility.js'
import { type EndpointAccessDeps, filterEndpointsForPrincipal } from './access/endpoint-access.js'
import { applyVisibilityChanges } from './access/visibility-sync.js'
import {
  BrokerError,
  normaliseBrokerUrl,
  revokeBrokerCredential,
  rotateBrokerCredential,
} from './broker-client.js'
import { deviceSettingKey } from './device-keys.js'
import { DetectionClassSource } from './detection-sensors/detection-classes.js'
import { DetectionSensorFeed } from './detection-sensors/detection-feed.js'
import {
  effectiveSensorClasses,
  parseSensorSelection,
  SENSOR_SELECTION_KEY,
  sensorSelectionField,
  sensorSelectionFromPatch,
  sensorSelectionKey,
} from './detection-sensors/sensor-selection.js'
import { AlexaEgressPrewarm } from './egress/alexa-egress-prewarm.js'
import { renameOnSkill } from './exposed-name-rename.js'
import { alexaNameValidator } from './endpoints/alexa-name.js'
import type { AlexaEndpoint } from './endpoints/types.js'
import { GENERIC_DEVICE_TYPES } from './endpoints/generic-device.js'
import { type AlexaSettings, effectiveAlexaSettings } from './alexa-settings.js'
import { STREAM_PREFERENCE_OPTIONS } from './stream-preference.js'
import { buildEndpointsForExposedDevice } from './handlers/discovery.js'
import {
  type DetectionSensorClass,
  detectionSensorEndpointId,
  parseCameraEndpointId,
} from './handlers/endpoint-id.js'
import { heldEgressHandles } from './handlers/rtc-session.js'
import type { DirectiveRouterDeps } from './directive-router.js'
import type { RoutedSkill } from './http-server.js'
import { judgeTokenInstance } from './token-instance.js'
import { generateIngressToken } from './ingress-token.js'
import { OauthSessionListSchema, selectAlexaSessionIdsToRevoke } from './link-status.js'
import {
  buildAddOrUpdateReportPayload,
  buildDeleteReportPayload,
  LwaEventGateway,
} from './lwa-event-gateway.js'
import type { PublicEndpointReader } from './public-endpoint.js'
import { removeEndpointsFromAlexa } from './remove-endpoints.js'
import { buildAlexaSetupBlock } from './setup-block.js'
import {
  ALEXA_INSTANCE_ID,
  type AlexaSkillBody,
  EMPTY_SKILL_EXPORTS,
  EMPTY_SKILL_STATE,
  keyedByText,
  type SkillExportsBody,
  type SkillLinksBody,
  type SkillStateBody,
} from './skill-records.js'
import { SkillStateStore } from './skill-state-store.js'
import type { SnapshotStore } from './snapshots/snapshot-store.js'
import { StateChangeReporter } from './state-reports/state-change-reporter.js'
import { StateReconciler } from './state-reports/state-reconciler.js'
import { type ResyncResult, SyncEngine } from './sync-engine.js'
import {
  DEFAULT_DEVICE_SETTINGS,
  type ExportDeviceSettings,
  type ExposedDeviceEntry,
  isBrokerGrant,
  type LinkedAccount,
  type LwaTokenEntry,
  type UpsertLwaTokenInput,
} from './types.js'
import {
  AlexaVisionRuntime,
  OBJECT_DETECTION_KEY,
  objectDetectionField,
  objectDetectionKey,
} from './vision/vision-runtime.js'

type ExportSetup = z.infer<typeof ExportSetupSchema>

/** Outcome of the operator-driven account unlink. Object-literal type (not an
 *  interface) so it satisfies the action handler's `Record<string, unknown>`
 *  return contract. */
export type UnlinkAlexaResult = {
  /** Active `export-alexa` OAuth sessions actually revoked. */
  readonly revokedSessions: number
  /** Linked-account records (and their Amazon push grants) dropped. */
  readonly removedAccounts: number
}

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

/** The name of a ledger record created by a skill's first link. */
const LINKS_NAME = 'Alexa account links'

/** Delay before the boot-time reconcile pass. Long enough for device providers
 *  to have registered their caps — a device whose bindings have not landed
 *  builds a shape we must never push to Alexa. */
const BOOT_RECONCILE_DELAY_MS = 60_000

/** The legacy ledger keys of the addon settings, until the migrations have moved them. Only the
 *  default instance has them. */
export interface LegacyLedgerPort {
  read(): Pick<AlexaSettings, 'linkedAccounts' | 'tokens'>
  write(patch: {
    readonly linkedAccounts?: readonly LinkedAccount[]
    readonly tokens?: readonly LwaTokenEntry[]
  }): Promise<void>
}

/** What a skill runtime takes from the addon that owns it. */
export interface SkillRuntimeHost {
  readonly ctx: AddonContext
  readonly publicEndpoint: PublicEndpointReader
  readonly snapshotStore: SnapshotStore
  readonly accessGate: AlexaAccessGate
  /** The addon-level settings as stored (the snapshot key, the retired keys). */
  settings(): AlexaSettings
  readonly handles: {
    readonly skills: RecordKindHandle<AlexaSkillBody>
    readonly links: RecordKindHandle<SkillLinksBody>
    readonly exports: RecordKindHandle<SkillExportsBody>
    readonly state: RecordKindHandle<SkillStateBody>
  }
  /** The legacy ledger port for the default instance; null for every other. */
  legacyLedger(instanceId: string): LegacyLedgerPort | null
  /** Users linked in an instance OTHER than `instanceId`: their sessions are shared with it. */
  linkedUserIdsElsewhere(instanceId: string): Promise<ReadonlySet<string>>
}

/** Which Export section a device gets. */
export type ExportKind = 'camera' | 'generic'

/** What the shared per-device preferences did in one patch (applied once, whatever the skills). */
export interface SharedPrefsOutcome {
  readonly prefsChanged: boolean
}

export class SkillRuntime {
  private lwaGateway: LwaEventGateway | null = null
  private egressPrewarm: AlexaEgressPrewarm | null = null
  private syncEngine: SyncEngine | null = null
  /** D968: exported actions, answered as Alexa scenes. */
  private actionScenes: ActionSceneExports | null = null
  private visibilityRef: AccountVisibilityMirror | null = null
  private detectionClassSource: DetectionClassSource | null = null
  private detectionFeed: DetectionSensorFeed | null = null
  /** R4 (D779): object detection + event history. */
  private visionRef: AlexaVisionRuntime | null = null
  private stateReporter: StateChangeReporter | null = null
  private stateReconciler: StateReconciler | null = null
  /** The switches whose change re-shapes every exposed endpoint, as last applied. */
  private appliedShapeSwitches: string | null = null
  /** Per-device debounce timers for the bindings-change discovery reconcile. */
  private readonly pendingReconcileTimers = new Map<number, ReturnType<typeof setTimeout>>()
  private readonly disposers: Array<() => Promise<void> | void> = []

  /** The `skills` record of this skill. */
  private skillRow: AlexaSkillBody | null = null
  /** The `skill-links` record, once it exists; until then the legacy ledger keys answer. */
  private linksRow: SkillLinksBody | null = null
  /** The `skill-exports` record: what the skill exposes. Loaded once at start; this runtime is its only writer. */
  private exportsRow: SkillExportsBody = EMPTY_SKILL_EXPORTS
  /** The hidden state of the skill: the `skill-state` record (token, namespace, push mirrors). */
  private stateStore: SkillStateStore | null = null
  /** The keychain refused the link credentials: the ledger is read-only until it answers (D49). */
  private linksLocked = false

  constructor(
    readonly instanceId: string,
    private readonly host: SkillRuntimeHost,
  ) {}

  private get ctx(): AddonContext {
    return this.host.ctx
  }

  private get publicEndpoint(): PublicEndpointReader {
    return this.host.publicEndpoint
  }

  private get snapshotStore(): SnapshotStore {
    return this.host.snapshotStore
  }

  private get accessGate(): AlexaAccessGate {
    return this.host.accessGate
  }

  /** The default instance keeps the pre-multi URLs and the legacy ledger keys. */
  get isDefault(): boolean {
    return this.instanceId === ALEXA_INSTANCE_ID
  }

  private addDisposer(fn: () => Promise<void> | void): void {
    this.disposers.push(fn)
  }

  private get skillState(): SkillStateStore {
    if (this.stateStore === null) throw new Error('export-alexa: the skill state is not loaded yet')
    return this.stateStore
  }

  get exposedDevices(): readonly ExposedDeviceEntry[] {
    return this.exportsRow.devices
  }

  get skillName(): string {
    return this.skillRow?.name ?? this.instanceId
  }

  /** The ingress token this skill's Lambda presents. Empty until the state is loaded. */
  get ingressToken(): string {
    return this.view.ingressToken
  }

  /** The settings as the routes read them (the public-skill overlay applied). */
  effectiveSettings(): AlexaSettings {
    return effectiveAlexaSettings(this.view, this.isDefault)
  }

  /** What the link ledger shows right now (the form's status block). */
  ledgers(): Pick<AlexaSettings, 'linkedAccounts' | 'tokens' | 'skillMode'> {
    const view = this.view
    return {
      linkedAccounts: view.linkedAccounts,
      tokens: view.tokens,
      skillMode: view.skillMode,
    }
  }

  /**
   * The legacy ledger keys as lists. A store written by an older build may hold something that
   * is not a list there; the page and the gateway read a list or nothing.
   */
  private legacyLedgers(): Pick<AlexaSettings, 'linkedAccounts' | 'tokens'> {
    const port = this.host.legacyLedger(this.instanceId)
    if (port === null) return { linkedAccounts: [], tokens: [] }
    const stored = port.read()
    return {
      linkedAccounts: Array.isArray(stored.linkedAccounts) ? stored.linkedAccounts : [],
      tokens: Array.isArray(stored.tokens) ? stored.tokens : [],
    }
  }

  /**
   * The settings as this skill reads them: the records where they exist, the legacy keys until
   * the migrations have moved them. The hidden state comes from its record only.
   */
  private get view(): AlexaSettings {
    const skill = this.skillRow
    const links = this.linksRow
    const legacy = this.legacyLedgers()
    const hidden = this.stateStore?.current ?? EMPTY_SKILL_STATE
    const state = {
      ingressToken: hidden.ingressToken ?? '',
      visionNamespace: hidden.visionNamespace,
      detectionClasses: hidden.detectionClasses,
      accountVisibility: hidden.accountVisibility,
      exportedEndpoints: hidden.exportedEndpoints,
      exportedSignatures: hidden.exportedSignatures,
      advertisedBrokerUrl: hidden.advertisedBrokerUrl,
      lwaClientId: hidden.lwaClientId,
    }
    const config = this.host.settings()
    if (skill === null && links === null) return { ...config, ...legacy, ...state }
    return {
      ...config,
      ...legacy,
      ...state,
      ...(skill === null
        ? {}
        : {
            skillMode: skill.skillMode,
            region: skill.region,
            expectedAudience: skill.expectedAudience,
            detectionSensors: skill.detectionSensors,
            objectDetection: skill.objectDetection,
            snapshots: skill.snapshots,
            enforceIngressToken: skill.enforceIngressToken,
          }),
      ...(links === null ? {} : { linkedAccounts: links.linkedAccounts, tokens: links.tokens }),
    }
  }

  /** Persist a change of the exposure: the record first, the in-memory copy after it landed. */
  private async writeExports(
    patch: Partial<Pick<SkillExportsBody, 'devices' | 'actions'>>,
  ): Promise<void> {
    const next: SkillExportsBody = {
      name: this.exportsRow.name,
      devices: patch.devices ?? this.exportsRow.devices,
      actions: patch.actions ?? this.exportsRow.actions,
    }
    await this.host.handles.exports.put({ id: this.instanceId, data: next })
    this.exportsRow = next
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  /**
   * Load this skill's rows and bring its services up. A failed read of the exposure record stops
   * the start: serving an empty membership would delete every device from Alexa on the next
   * reconcile.
   */
  async start(): Promise<void> {
    await this.refreshRecords()
    this.exportsRow =
      (await this.host.handles.exports.get(this.instanceId))?.data ?? EMPTY_SKILL_EXPORTS

    // The ingress token and the vision namespace are filled once. The migrations have already
    // moved a token that existed; one that exists is NEVER replaced.
    this.stateStore = new SkillStateStore({
      handle: this.host.handles.state,
      instanceId: this.instanceId,
      logger: this.ctx.logger,
    })
    await this.stateStore.ensureIdentity({
      token: generateIngressToken,
      namespace: randomUUID,
    })

    // Backfill linked accounts from stored LWA tokens whose account wasn't
    // recorded — covers cloud-mode links completed before the /oauth/lwa-tokens
    // callback started recording the link.
    await this.backfillLinkedAccounts()

    this.detectionClassSource = new DetectionClassSource({
      readEventKinds: (deviceId) =>
        this.ctx.api.pipelineAnalytics.listEventKinds.query({ deviceId }),
      getStored: () => this.view.detectionClasses,
      setStored: (next) => this.skillState.update({ detectionClasses: keyedByText(next) }),
      logger: this.ctx.logger,
    })
    this.visibilityRef = new AccountVisibilityMirror({
      gate: this.accessGate,
      listLinkedUserIds: () => this.view.linkedAccounts.map((a) => a.userId),
      listExposedDeviceIds: () => this.exposedDevices.map((e) => e.deviceId),
      getStored: () => this.view.accountVisibility,
      setStored: (next) => this.skillState.update({ accountVisibility: keyedByText(next) }),
      logger: this.ctx.logger,
    })

    this.visionRef = new AlexaVisionRuntime({
      ctx: this.ctx,
      logger: this.ctx.logger,
      integrationOn: () => this.view.objectDetection,
      snapshotsOn: () => this.view.snapshots,
      isExposed: (deviceId) => this.exposedDevices.some((e) => e.deviceId === deviceId),
      knownClasses: (deviceId) => this.view.detectionClasses[deviceId]?.classes ?? [],
      namespace: () => this.view.visionNamespace,
      publicEndpoint: this.publicEndpoint,
      store: this.snapshotStore,
      post: (opts) => this.requireGateway().postObjectDetection(opts),
    })

    this.actionScenes = new ActionSceneExports(
      {
        api: this.ctx.api,
        logger: this.ctx.logger,
        linkedUserIds: () => this.view.linkedAccounts.map((a) => a.userId),
        isAdminUser: async (userId) => {
          const lookup = await this.accessGate.principal(userId)
          return lookup.kind === 'found' && lookup.principal.kind === 'admin'
        },
        canPush: () => this.view.tokens.length > 0,
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
        persist: (entries) => this.writeExports({ actions: [...entries] }),
      },
      this.exportsRow.actions,
    )
    const actionScenes = this.actionScenes
    // The operator may have deleted an action while this addon was down.
    void actionScenes.reconcile().catch((err: unknown) => {
      this.ctx.logger.warn('export-alexa: action scene reconcile at boot failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })

    // Spin up the Event Gateway worker. Subscribes to doorbell events
    // and runs a 60s refresh scan — both teardown in `onShutdown`.
    this.egressPrewarm = new AlexaEgressPrewarm({
      api: this.ctx.api,
      logger: this.ctx.logger,
      listExposed: () => this.exposedDevices,
      hasLiveSession: (deviceId) => heldEgressHandles().some((h) => h.deviceId === deviceId),
    })
    this.lwaGateway = new LwaEventGateway({
      ctx: this.ctx,
      logger: this.ctx.logger,
      listExposed: () => this.exposedDevices,
      onExposedDoorbellPress: (deviceId) => {
        void this.egressPrewarm?.onPress(deviceId)
      },
      listLinkedAccounts: () => this.view.linkedAccounts,
      listTokens: () => this.view.tokens,
      upsertToken: (input) => this.upsertToken(input),
      removeLinkedAccount: (userId) => this.removeLinkedAccount(userId),
      getAdvertisedBrokerUrl: () => this.view.advertisedBrokerUrl || null,
      getPublicEndpoint: this.publicEndpoint,
      getRegion: () => this.view.region,
      getExportedSignature: (deviceId) => this.view.exportedSignatures[deviceId] ?? null,
      accountMaySee: (userId, deviceId) => this.visibility.allows(userId, deviceId),
    })
    this.lwaGateway.start()

    // R1 (D772): the detection sensors' live feed. Started after the gateway it
    // posts through; the reconcile against active tracks runs inside it.
    const gatewayForFeed = this.lwaGateway
    this.detectionFeed = new DetectionSensorFeed({
      eventBus: this.ctx.eventBus,
      enabled: () => this.view.detectionSensors,
      isExposed: (deviceId) => this.exposedDevices.some((e) => e.deviceId === deviceId),
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
      getExportedEndpoints: () => this.view.exportedEndpoints,
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
      getExportedEndpoints: () => this.view.exportedEndpoints,
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
      listExposed: () => this.exposedDevices,
      listLinkedAccounts: () => this.view.linkedAccounts,
      hasProactiveCredentials: () => this.view.tokens.length > 0,
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
      getExportedEndpoints: () => this.view.exportedEndpoints,
      setExportedEndpoints: (next) =>
        this.skillState.update({ exportedEndpoints: keyedByText(next) }),
      getExportedSignatures: () => this.view.exportedSignatures,
      setExportedSignatures: (next) =>
        this.skillState.update({ exportedSignatures: keyedByText(next) }),
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
        if (!this.exposedDevices.some((e) => e.deviceId === id)) return
        // `unexposeDevice` drops the device from `exposed` AND issues the
        // DeleteReport (via the SyncEngine) — a single path, no double-fire.
        void this.unexposeDevice(String(id))
      },
    )
    this.addDisposer(async () => offRemoved())

    this.ctx.logger.info('export-alexa: initialized', {
      meta: {
        instanceId: this.instanceId,
        exposedCount: this.exposedDevices.length,
        skillMode: this.view.skillMode,
        skillIdSet: this.effectiveSettings().expectedAudience.length > 0,
        pushGrants: this.view.tokens.length,
        brokerGrants: this.view.tokens.filter(isBrokerGrant).length,
      },
    })
  }

  /** Stop every service and timer of this skill. Idempotent. */
  async stop(): Promise<void> {
    const disposers = this.disposers.splice(0)
    for (const dispose of disposers) {
      try {
        await dispose()
      } catch (err: unknown) {
        this.ctx.logger.warn('export-alexa: a skill disposer failed', {
          meta: { instanceId: this.instanceId, error: errMsg(err) },
        })
      }
    }
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

  /** The routes' view of this skill: what a directive or a Lambda callback acts on. */
  routed(): RoutedSkill {
    const hasLinkedUser = (userId: string): boolean =>
      this.view.linkedAccounts.some((a) => a.userId === userId)
    return {
      id: this.instanceId,
      getSettings: () => this.effectiveSettings(),
      directiveDeps: this.directiveDeps(),
      hasLinkedUser,
      lwaTokensCallbackDeps: {
        ctx: this.ctx,
        logger: this.ctx.logger,
        upsertToken: (input) => this.upsertToken(input),
        recordLinkedAccount: (input) => this.recordLinkedAccount(input),
        instanceId: this.instanceId,
        judgeInstance: (caller) =>
          judgeTokenInstance(caller, { id: this.instanceId, hasLinkedUser }),
      },
      onBrokerAdvertised: (raw) => this.rememberAdvertisedBroker(raw),
    }
  }

  private directiveDeps(): DirectiveRouterDeps {
    const actionScenes = this.requireActionScenes()
    return {
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
        listExposed: async () => this.exposedDevices,
        buildEndpoints: (deviceId) => this.buildEndpointsForOneDevice(deviceId),
      },
      cameraStream: {
        ctx: this.ctx,
        logger: this.ctx.logger,
        listExposed: () => this.exposedDevices,
      },
      rtcSession: {
        ctx: this.ctx,
        logger: this.ctx.logger,
        listExposed: () => this.exposedDevices,
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
        detectionPresent: (deviceId, cls) => this.detectionFeed?.isPresent(deviceId, cls) ?? false,
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
      fanController: {
        ctx: this.ctx,
        logger: this.ctx.logger,
      },
      mediaPlayerController: {
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
        enabled: () => this.view.snapshots,
        publicEndpoint: this.publicEndpoint,
      },
      vision: this.vision.context(),
      access: this.endpointAccess,
      actionScenes: {
        exports: actionScenes,
        api: this.ctx.api,
        logger: this.ctx.logger,
      },
      afterDiscovery: (userId, endpoints) =>
        this.requireGateway().scheduleInitialConnectivity(userId, endpoints),
    }
  }

  private requireActionScenes(): ActionSceneExports {
    if (this.actionScenes === null) throw new Error('export-alexa: action scenes not initialized')
    return this.actionScenes
  }

  /** The action scenes this skill exposes (the device-export provider reads and edits them). */
  get scenes(): ActionSceneExports {
    return this.requireActionScenes()
  }

  async exposeDevice(deviceIdRaw: string): Promise<void> {
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

    const next: ExposedDeviceEntry[] = this.exposedDevices.filter((e) => e.deviceId !== deviceId)
    next.push({
      deviceId,
      exposedAt: Date.now(),
      settings: DEFAULT_DEVICE_SETTINGS,
    })
    await this.writeExports({ devices: next })

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

  async unexposeDevice(deviceIdRaw: string): Promise<void> {
    const deviceId = Number.parseInt(deviceIdRaw, 10)
    if (!Number.isFinite(deviceId)) return // idempotent on bogus input

    const next = this.exposedDevices.filter((e) => e.deviceId !== deviceId)
    if (next.length === this.exposedDevices.length) return // already absent
    await this.writeExports({ devices: next })
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
      snapshots: this.view.snapshots,
      // D778: offered (the pipeline) ∩ chosen (the camera's saved selection).
      ...(this.view.detectionSensors
        ? {
            detectionClasses: async (id: number) =>
              effectiveSensorClasses(
                await classesOf(id),
                parseSensorSelection(await vision.readPrefs(id)),
              ),
          }
        : {}),
      // D1049: this skill's exposed name for the device, same endpoint id.
      alexaName: async (id: number) =>
        readExposedName(await vision.readPrefs(id), this.instanceId, alexaNameValidator),
      // D779: the camera's object detection + history.
      ...(this.view.objectDetection
        ? {
            objectDetection: async (id: number) => vision.buildClasses(id, await classesOf(id)),
          }
        : {}),
    })
  }

  /** The settings that change every exposed endpoint's shape, as one key. */
  private shapeSwitches(): string {
    return JSON.stringify({
      detectionSensors: this.view.detectionSensors,
      snapshots: this.view.snapshots,
      objectDetection: this.view.objectDetection,
    })
  }

  /**
   * A shape switch was flipped: re-push every exposed device. The signature
   * reconcile pushes only what changed, and the push retires the endpoints a
   * device no longer builds (the detection sensors, when switched off).
   */
  async applyShapeSwitches(): Promise<void> {
    const now = this.shapeSwitches()
    if (this.appliedShapeSwitches === null || now === this.appliedShapeSwitches) return
    this.appliedShapeSwitches = now
    // Switched off: every URL already handed to Alexa dies now, not in ten
    // minutes (the route also refuses while off).
    if (!this.view.snapshots) this.snapshotStore.clear()
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
      if (!this.view.detectionSensors && !this.view.objectDetection) return
      void this.requireSyncEngine()
        .reconcileAllExposed()
        .catch((err: unknown) => {
          this.ctx.logger.warn('export-alexa: detection-class refresh failed', {
            meta: { error: errMsg(err) },
          })
        })
    }, DETECTION_CLASS_REFRESH_MS)
    timer.unref?.()
    this.addDisposer(async () => clearInterval(timer))
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
    this.addDisposer(async () => {
      clearTimeout(first)
      clearInterval(every)
    })
  }

  /** The exposed set + the user gate, as every enforcement point reads them. */
  private get endpointAccess(): EndpointAccessDeps {
    return {
      gate: this.accessGate,
      isExposed: (deviceId) => this.exposedDevices.some((e) => e.deviceId === deviceId),
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
        if (!this.exposedDevices.some((e) => e.deviceId === deviceId)) return
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
    this.addDisposer(async () => {
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
    this.addDisposer(async () => clearTimeout(timer))
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
  async resyncDiscovery(): Promise<ResyncResult> {
    if (this.view.linkedAccounts.length === 0) {
      throw new Error('No linked Amazon account. Link the skill from the Alexa app first.')
    }
    if (this.view.tokens.length === 0) {
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

  async unlinkAlexaAccounts(): Promise<UnlinkAlexaResult> {
    const rawSessions: unknown = await this.ctx.api.userManagement.listOauthSessions.query()
    const parsed = OauthSessionListSchema.safeParse(rawSessions)
    if (!parsed.success) {
      throw new Error(
        `export-alexa: listOauthSessions returned an unrecognised shape — refusing to unlink: ${parsed.error.message}`,
      )
    }
    // The OAuth client is one per addon, so a session belongs to a USER, not to a skill. A user
    // also linked to another skill keeps the session that skill is using: unlinking this skill
    // must not cut the other one.
    const shared = await this.host.linkedUserIdsElsewhere(this.instanceId)
    const ids = selectAlexaSessionIdsToRevoke(parsed.data, shared)

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
    await this.revokeAtBroker(this.view.tokens)

    const removedAccounts = this.view.linkedAccounts.length
    await this.writeLedger({ linkedAccounts: [], tokens: [] })
    await this.skillState.update({
      exportedEndpoints: {},
      exportedSignatures: {},
      accountVisibility: {},
    })
    this.ctx.logger.warn('export-alexa: operator unlinked the Amazon account(s)', {
      meta: { revokedSessions, sessionsFound: ids.length, removedAccounts },
    })
    return { revokedSessions, removedAccounts }
  }

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
    const next: LwaTokenEntry[] = this.view.tokens.filter((t) => t.userId !== input.userId)
    next.push(entry)
    await this.writeLedger({ tokens: next })
  }

  private async removeLinkedAccount(userId: string): Promise<void> {
    await this.writeLedger({
      tokens: this.view.tokens.filter((t) => t.userId !== userId),
      linkedAccounts: this.view.linkedAccounts.filter((a) => a.userId !== userId),
    })
    this.ctx.logger.warn('export-alexa: unlinked revoked account', {
      meta: { userId },
    })
  }

  private async recordLinkedAccount(input: { userId: string; username: string }): Promise<void> {
    if (this.view.linkedAccounts.some((a) => a.userId === input.userId)) {
      return // idempotent — already recorded
    }
    const next: LinkedAccount[] = [
      ...this.view.linkedAccounts,
      { userId: input.userId, username: input.username, linkedAt: Date.now() },
    ]
    await this.writeLedger({ linkedAccounts: next })
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
    const linked = new Set(this.view.linkedAccounts.map((a) => a.userId))
    const missing = this.view.tokens.filter((t) => !linked.has(t.userId))
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

  private rememberAdvertisedBroker(raw: string): void {
    const url = normaliseBrokerUrl(raw)
    if (!url) {
      this.ctx.logger.warn(
        'export-alexa: ignored a broker advertisement that is not an https origin',
      )
      return
    }
    if (url === this.view.advertisedBrokerUrl) return
    void this.skillState
      .update({ advertisedBrokerUrl: url })
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
  async rotateBrokerCredentials(): Promise<{
    rotated: number
    failed: number
  }> {
    if (!this.view.tokens.some(isBrokerGrant)) {
      throw new Error(
        "No link is held at the skill's token broker, so there is no credential to rotate. Link the skill from the Alexa app first.",
      )
    }
    let rotated = 0
    let failed = 0
    for (const t of this.view.tokens) {
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
   * Rotate the ingress token, invalidating the old value. The operator must
   * paste the new token into their Lambda's HUB_INGRESS_TOKEN env afterwards.
   * Backs the "Regenerate token" settings button.
   */
  async regenerateIngressToken(): Promise<{ ingressToken: string }> {
    const ingressToken = generateIngressToken()
    await this.skillState.update({ ingressToken })
    this.ctx.logger.info('export-alexa: regenerated ingress token')
    return { ingressToken }
  }

  async buildSetupBlock(): Promise<ExportSetup> {
    const publicEndpoint = await this.publicEndpoint()
    return buildAlexaSetupBlock({
      publicEndpoint,
      ingressToken: this.view.ingressToken,
      skillMode: this.view.skillMode,
      instanceId: this.instanceId,
      legacyUrls: this.isDefault,
    })
  }

  async refreshRecords(): Promise<void> {
    try {
      this.skillRow = (await this.host.handles.skills.getResolved(this.instanceId))?.data ?? null
    } catch (err: unknown) {
      this.ctx.logger.warn('export-alexa: the skill record could not be read', {
        meta: { error: errMsg(err) },
        tags: { topic: 'export-alexa', phase: 'records-read-failed' },
      })
    }
    try {
      this.linksRow = (await this.host.handles.links.getResolved(this.instanceId))?.data ?? null
      this.linksLocked = false
    } catch (err: unknown) {
      if (!(err instanceof RecordSecretUnavailableError)) {
        this.ctx.logger.warn('export-alexa: the link record could not be read', {
          meta: { error: errMsg(err) },
          tags: { topic: 'export-alexa', phase: 'records-read-failed' },
        })
        return
      }
      // A locked keychain is a failed read of the credentials: the ledger keeps what it had
      // and takes no write, so an upsert cannot replace the record with a half-read one (D49).
      this.linksLocked = true
      this.ctx.logger.warn('export-alexa: the keychain is locked; the link ledger is read-only', {
        tags: { topic: 'export-alexa', phase: 'keychain-locked' },
      })
    }
  }

  /**
   * Write the account-link ledgers: to the `skill-links` record once it exists, to the legacy
   * settings keys until then (the migration moves them).
   */
  private async writeLedger(patch: {
    readonly linkedAccounts?: readonly LinkedAccount[]
    readonly tokens?: readonly LwaTokenEntry[]
  }): Promise<void> {
    if (this.linksRow === null) {
      const legacy = this.host.legacyLedger(this.instanceId)
      if (legacy !== null) {
        await legacy.write(patch)
        return
      }
      // A skill added after the migrations has no ledger record until its first link.
      const first: SkillLinksBody = {
        name: LINKS_NAME,
        linkedAccounts: patch.linkedAccounts ?? [],
        tokens: patch.tokens ?? [],
      }
      await this.host.handles.links.put({ id: this.instanceId, data: first }, { ifRev: 0 })
      this.linksRow = first
      return
    }
    if (this.linksLocked) {
      throw new Error('the keychain is locked: the Amazon link ledger cannot be changed right now')
    }
    const next: SkillLinksBody = {
      name: this.linksRow.name,
      linkedAccounts: patch.linkedAccounts ?? this.linksRow.linkedAccounts,
      tokens: patch.tokens ?? this.linksRow.tokens,
    }
    await this.host.handles.links.put({ id: this.instanceId, data: next })
    this.linksRow = next
  }

  /**
   * This skill's section of a device's Export panel. The enable switch and the stream settings
   * belong to the skill (their keys carry its id); the Alexa name and the detection fields are
   * the DEVICE's own preferences, shared by every skill, so only one section (`shared`) draws
   * them.
   */
  async buildDeviceSection(
    deviceId: number,
    kind: ExportKind,
    opts: {
      readonly title: string
      readonly order: number
      readonly shared: boolean
    },
  ): Promise<ConfigSectionWithValues> {
    const entry = this.findEntry(deviceId)
    const settings = entry?.settings ?? DEFAULT_DEVICE_SETTINGS
    const enabled = entry !== null
    // Field keys are namespaced per exporter AND per skill — the device-aggregate form
    // flattens fields by `key` across sections, so a generic `'enabled'` / `'streamPreference'`
    // would collide with HAP's same-named fields and with another skill's.
    const enabledKey = deviceSettingKey(this.instanceId, deviceId, 'enabled')
    const linkedCount = this.view.linkedAccounts.length
    const statusLabel = enabled
      ? `Exposed${linkedCount > 0 ? `, ${linkedCount} linked Alexa account(s)` : ' (no linked Alexa account yet)'}`
      : linkedCount > 0
        ? `${linkedCount} linked Alexa account(s) — device not exposed`
        : 'Not exposed'
    return {
      id: this.isDefault ? 'export-alexa' : `export-alexa:${this.instanceId}`,
      title: opts.title,
      description:
        kind === 'camera'
          ? 'Surface this camera to the linked Alexa Smart Home skill.'
          : 'Surface this device to the linked Alexa Smart Home skill (locks, sensors, switches and lights each become one Alexa device).',
      tab: 'export',
      columns: 1,
      order: opts.order,
      fields: [
        {
          type: 'info' as const,
          key: `__alexa-status:${this.instanceId}`,
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
          // Auto-save on click: a single toggle has no draft state to review, and the
          // expose / unexpose lifecycle (including the AddOrUpdateReport / DeleteReport push to
          // the Alexa Event Gateway) must not wait for a manual save.
          immediate: true,
        },
        ...(kind === 'camera' ? this.cameraOnlyExportFields(deviceId, settings, enabledKey) : []),
        ...(kind === 'camera' && opts.shared
          ? await this.cameraDetectionFields(deviceId, enabledKey)
          : []),
      ],
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
        masterOn: this.view.detectionSensors,
      }),
      objectDetectionField({
        deviceId,
        store,
        enabledKey,
        integrationOn: this.view.objectDetection,
      }),
    ]
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
    const streamPreferenceKey = deviceSettingKey(this.instanceId, deviceId, 'streamPreference')
    const allowTranscodeKey = deviceSettingKey(this.instanceId, deviceId, 'allowTranscode')
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
   * The device's own preferences in a patch (detection classes, object detection): shared by
   * every skill, so they are saved ONCE, before any skill applies its own part (an expose in
   * the same patch then builds with them).
   */
  async applySharedPrefs(
    deviceId: number,
    patch: Record<string, unknown>,
  ): Promise<SharedPrefsOutcome> {
    const prefsChanged = await this.applyDetectionPrefsPatch(deviceId, patch)
    return { prefsChanged }
  }

  /** D1049: this skill's exposed name for a device, or null (the device's own name). */
  async exposedNameOf(deviceId: number): Promise<string | null> {
    return readExposedName(
      await this.vision.readPrefs(deviceId),
      this.instanceId,
      alexaNameValidator,
    )
  }

  /**
   * D1049: save this skill's name for a device (`device-export.setExposedName`); an exposed
   * device is pushed again under the same endpoint id. `renameOnSkill` holds the rule.
   */
  async setExposedName(deviceIdRaw: string, raw: unknown, dryRun = false): Promise<void> {
    await renameOnSkill(
      {
        instanceId: this.instanceId,
        // A strict read (it throws): a read that answered {} would erase the other skills' names.
        store: {
          read: (id) => exposedNameStoreOf(this.ctx.settings, 'export-alexa').read(id),
          write: (id, patch) => this.vision.writePrefs(id, patch),
        },
        logger: this.ctx.logger,
        isExposed: (id) => this.findEntry(id) !== null,
        push: (id) => this.requireSyncEngine().pushDevice(id),
      },
      deviceIdRaw,
      raw,
      { dryRun },
    )
  }

  /**
   * Apply this skill's part of a patch produced by the device-details "Export" panel. Flips
   * the expose/unexpose lifecycle on `enabled` transitions and persists
   * the addon-specific preferences. Live `streamPreference` updates do
   * NOT propagate to Alexa today — the skill caches the stream URL in
   * its directive cache, and "swap stream without re-discovery" needs
   * an Alexa.ChangeReport on the camera endpoint. For the first
   * iteration we unexpose + re-expose so the next discovery picks up
   * the new preference. See remaining-work notes in CLAUDE.md.
   */
  async applyEntryPatch(
    deviceId: number,
    patch: Record<string, unknown>,
    shared: SharedPrefsOutcome,
  ): Promise<{ success: true }> {
    const { prefsChanged } = shared
    const idStr = String(deviceId)
    const current = this.findEntry(deviceId)
    const wasEnabled = current !== null

    // `alexa:<id>:sourceProfile` had a writer here and no field anywhere — a
    // handler with no caller, describing a second pin for a function
    // `streamPreference` already owned. Removed with the read
    // (`rtc-session.ts`), which explains what the leftover cost. A stale
    // persisted value is now inert rather than invisibly authoritative.

    // ── Standard keys (enabled / streamPreference) ─────────────────
    // Both keys are namespaced per-exporter — see buildDeviceSettingsContribution.
    const enabledKey = deviceSettingKey(this.instanceId, deviceId, 'enabled')
    const streamPreferenceKey = deviceSettingKey(this.instanceId, deviceId, 'streamPreference')
    const allowTranscodeKey = deviceSettingKey(this.instanceId, deviceId, 'allowTranscode')
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
  async exportKindOf(deviceId: number): Promise<'camera' | 'generic' | null> {
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

  findEntry(deviceId: number): ExposedDeviceEntry | null {
    return this.exposedDevices.find((e) => e.deviceId === deviceId) ?? null
  }

  private async patchEntrySettings(
    deviceId: number,
    settings: ExportDeviceSettings,
  ): Promise<void> {
    const next = this.exposedDevices.map<ExposedDeviceEntry>((e) =>
      e.deviceId === deviceId ? { ...e, settings } : e,
    )
    await this.writeExports({ devices: next })
  }

  /** "Show ingress token": the one read surface that returns it in clear. */
  revealIngressToken(): { ingressToken: string } {
    this.ctx.logger.info('export-alexa: an administrator revealed the ingress token', {
      meta: { instanceId: this.instanceId },
    })
    return { ingressToken: this.view.ingressToken }
  }

  /** "Remove ids from Alexa": a DeleteReport for ids the operator typed. */
  async removeAlexaEndpoints(endpointIds: string) {
    const result = await removeEndpointsFromAlexa({
      raw: endpointIds,
      purge: (ids) => this.requireGateway().purgeEndpoints(ids),
      getTracked: () => this.view.exportedEndpoints,
      setTracked: (next) => this.skillState.update({ exportedEndpoints: keyedByText(next) }),
    })
    this.ctx.logger.info('export-alexa: operator removed endpoint ids from Alexa', {
      meta: { ...result, endpointIds, instanceId: this.instanceId },
    })
    return result
  }
}
