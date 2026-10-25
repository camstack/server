/**
 * Camera Grids — several cameras composed into one, emitted as an ordinary
 * camera.
 *
 * ## What it is
 *
 * A grid is a DEVICE this addon declares, with one stream that is composed
 * rather than dialled. Everything downstream treats it as a camera: it records,
 * it appears in the timeline, it has a profile slot, it is bound like any other
 * — with ONE deliberate exception, object detection, which is switched off at
 * creation (see `silence-analysis.ts` for why, and for why it is never
 * re-asserted afterwards).
 *
 * ## Hub-only, one process
 *
 * `placement: hub-only`, `instanceMode: unique`, and NOT in any `execution.group`
 * (D2/D29): it runs ffmpeg children over live media, and a co-located crash
 * would respawn the whole runner.
 *
 * ## The lifecycle, in one line
 *
 * No prebuffer. The composition runs while a consumer is reading it and not one
 * second longer — see `grid-stream-session.ts`, which owns that rule, and
 * `grid-stream-relay.ts`, where an open socket IS the consumer.
 */
import type {
  AddonInitResult,
  CamStreamDescriptor,
  ConfigUISchema,
  DeviceProxy,
  GridLayoutPatch,
  GridLayoutView,
  ProfileSlot,
} from '@camstack/types'
import {
  BaseAddon,
  cameraGridLayoutCapability,
  DeclaredDevices,
  DeviceType,
  EventCategory,
  MOTION_CLOSE_AFTER_MS,
  type CamProfile,
  declarationOwnerNodeId,
  errMsg,
  memoizePinnedFfmpeg,
  type DetectionResultPayload,
  type MotionOnMotionChangedPayload,
  type PipelineAudioInferenceResultPayload,
} from '@camstack/types'
import {
  buildGridCameraDeclarations,
  gridCameraReconciliationIndex,
  type GridCameraDeclaration,
} from './grid-camera-declarations.js'
import { GridCameraDevice, installGridCameraRuntime } from './grid-camera-device.js'
import { acquireWithRetry } from './acquire-retry.js'
import { readGridInstances, type GridInstance } from './grid-instances.js'
import { buildGridLayoutNativeProvider } from './grid-layout-native-provider.js'
import { gridPlanFor } from './grid-plan.js'
import { normalizeGridRows } from './grid-row-normalization.js'
import { GridActivityForwarder, type GridActivityTarget } from './grid-activity.js'
import { GridFrameSampler } from './grid-frame-sample.js'
import { GridLastFrameFileStore } from './grid-last-frame-store.js'
import {
  GRID_PROFILES,
  gridProfilePlans,
  type GridProfilePlan,
  type ServedProfile,
} from './grid-profiles.js'
import { gridSourceDial } from './grid-sentry-sources.js'
import { GridSnapshotSource, type GridSnapshotImage } from './grid-snapshot.js'
import { GridStreamRelay, type GridStreamRequest } from './grid-stream-relay.js'
import { gridStreamDescriptor } from './grid-stream-descriptor.js'
import { GridStreamSession } from './grid-stream-session.js'
import { silenceAnalysisFor } from './silence-analysis.js'
import { type GridChildContext } from './grid-child.js'
import { startGridCompositorChild } from './grid-compositor-child.js'

const INTEGRATION_NAME = 'Camera Grids'
const RECONCILE_MS = 60_000
/**
 * How long a source acquire may keep asking while a provider is still coming up.
 * Long enough to cover the republish window after a hub restart, short enough
 * that a genuinely missing profile fails while the operator is still looking.
 */
const SOURCE_ACQUIRE_BUDGET_MS = 8_000
const SOURCE_ACQUIRE_PAUSE_MS = 700

interface CameraGridAddonConfig {
  /** Operator-written rows. Name only on creation; geometry is added later. */
  readonly cameraGrids: readonly Record<string, unknown>[]
  /** Durable deletion intent, so a removed grid is not re-adopted by a sweep. */
  readonly cameraGridTombstones: readonly string[]
}

const DEFAULTS: CameraGridAddonConfig = {
  cameraGrids: [],
  cameraGridTombstones: [],
}

/** One composition per (grid, profile) — a grid composes each separately. */
function sessionKey(instanceId: string, profile: CamProfile): string {
  return `${instanceId}::${profile}`
}

/**
 * One grid's composition of one profile.
 *
 * The profile is back in the key after a spell with a single output. What made
 * the per-profile shape painful was never the count: it was that a rebuild
 * meant a blank screen until the slowest source produced a key frame. An output
 * clock (D530) shows the picture at once and fills the cells in, so a rung the
 * adaptive can stand on costs what it is worth.
 */
class GridSessionEntry {
  constructor(
    readonly instanceId: string,
    readonly profile: CamProfile,
    readonly session: GridStreamSession,
  ) {}

  isRunning(): boolean {
    return this.session.isRunning()
  }
}

export class CameraGridAddon extends BaseAddon<CameraGridAddonConfig> {
  private relay: GridStreamRelay | null = null
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  /** Keyed by instance id — ONE composition per grid. */
  private readonly sessions = new Map<string, GridSessionEntry>()
  private readonly deviceIdByInstanceId = new Map<string, number>()
  private readonly tombstones = new Set<string>()
  /**
   * What each grid can honestly publish, per profile.
   *
   * ABSENT means "not asked yet", and it is a REFUSAL to describe — the device
   * throws rather than answering an empty catalog, because an empty catalog
   * retracts every stream the broker holds for the grid. It is refreshed on
   * every reconcile and on every layout save; the window belongs to the READER
   * (D224), and 60 s is the window for a fact — "does 101 have a low assigned"
   * — that only changes when an operator changes it.
   */
  private readonly plansByInstanceId = new Map<string, readonly GridProfilePlan[]>()
  private activity: GridActivityForwarder | null = null
  private snapshots: GridSnapshotSource<GridSessionEntry> | null = null
  private frameSampler: GridFrameSampler | null = null
  /** The node's pinned ffmpeg (D540). `null` until init resolved it — a
   *  composition then refuses by name; there is no PATH default. */
  private ffmpegBinaryPath: string | null = null
  /** The node's pinned build, remembered only on success (D540). */
  private readonly pinnedFfmpeg = memoizePinnedFfmpeg(() => this.ctx.deps.ensureFfmpeg())
  /** A resolution in flight, so a reconcile pass never starts a second. */
  private ffmpegResolving: Promise<void> | null = null
  private integrationId: string | null | undefined

  constructor() {
    super({ ...DEFAULTS })
  }

  protected async onInitialize(): Promise<AddonInitResult> {
    this.replaceTombstones(this.config.cameraGridTombstones)
    await this.normalizeRows()

    if (declarationOwnerNodeId(this.ctx.kernel.localNodeId) === 'hub') {
      // A boot-time miss is logged and ASKED AGAIN by the next pass that wants
      // a composition (`ensureSessions`) — never fatal to the addon, never a
      // `null` kept for good, never PATH (D540).
      await this.resolveFfmpeg()
      const relay = new GridStreamRelay({
        logger: this.ctx.logger.child('relay'),
        sessionFor: (request) => this.sessionFor(request),
      })
      await relay.start()
      this.relay = relay
      this.snapshots = new GridSnapshotSource<GridSessionEntry>({
        logger: this.ctx.logger.child('snapshot'),
        sessionsFor: (deviceId) => this.sessionsForDevice(deviceId),
        sampleFrame: async (session) => this.sampleFrame(session),
        // The addon's OWN directory. A composition's last frame is this
        // addon's fact about its own camera, and it has to survive the
        // restarts that empty every RAM cache in the process.
        store: new GridLastFrameFileStore({
          dataDir: this.ctx.dataDir,
          logger: this.ctx.logger.child('snapshot'),
        }),
      })
      this.activity = new GridActivityForwarder({
        eventBus: this.ctx.eventBus,
        logger: this.ctx.logger.child('activity'),
        addonId: this.ctx.id,
        gridsForSource: (sourceDeviceId) => this.gridsForSource(sourceDeviceId),
        now: () => Date.now(),
      })
      this.subscribeSourceActivity()
      installGridCameraRuntime({
        descriptorsFor: (instanceId) => this.descriptorsFor(instanceId),
        getLayout: (deviceId) => this.gridViewFor(deviceId),
        saveLayout: async (patch) => this.saveGridLayout(patch),
        getSnapshot: async (deviceId) => this.getSnapshot(deviceId),
        motionStatus: (deviceId) => {
          const state = this.activity?.motionStatusFor(deviceId, Date.now()) ?? {
            detected: false,
            lastDetectedAt: null,
          }
          return {
            ...state,
            // `MOTION_CLOSE_AFTER_MS` while detected, `null` otherwise — the
            // one authority every Camera writes here (D475). Descriptive: it
            // mirrors the expiry the mirror already applies, it arms nothing.
            autoClearAfterMs: state.detected ? MOTION_CLOSE_AFTER_MS : null,
          }
        },
      })
      await this.reconcile().catch((error: unknown) => {
        this.ctx.logger.warn('camera grid: initial reconciliation failed — will retry', {
          meta: { error: errMsg(error) },
        })
      })
      this.reconcileTimer = setInterval(() => {
        void this.reconcile().catch((error: unknown) => {
          this.ctx.logger.warn('camera grid: reconciliation failed', {
            meta: { error: errMsg(error) },
          })
        })
      }, RECONCILE_MS)
      this.reconcileTimer.unref?.()
    }

    // TWO registrations, one implementation — because there are two paths and
    // each reaches a different provider:
    //
    //  - the DEVICE PAGE. `device-aggregation.ts` walks the bindings and
    //    resolves the contribution with
    //    `registry.getProviderByAddon(capName, entry.providerAddonId)`, which
    //    reads the ADDON-level provider map only. A native registration is not
    //    in it, so without the provider returned here the section is dropped
    //    and nothing is logged — measured on the hub: the cap answered a direct
    //    call and the device aggregate carried 30 sections, none of them ours.
    //  - a DIRECT cap call (`cameraGridLayout.getDeviceSettingsContribution`).
    //    That one carries a `deviceId`, so `child-cap-dispatch` answers it from
    //    the DEVICE-scoped provider and throws when the method is missing
    //    there. That provider is built in `grid-camera-device.ts`, from the
    //    same factory.
    //
    // Hence one builder (`grid-layout-native-provider.ts`) and two
    // registrations, rather than two hand-written providers that would drift.
    const layoutProvider = buildGridLayoutNativeProvider({
      getLayout: (deviceId) => this.gridViewFor(deviceId),
      saveLayout: (patch) => this.saveGridLayout(patch),
    })
    return {
      providers: [{ capability: cameraGridLayoutCapability, provider: layoutProvider }],
    }
  }

  protected async onConfigChanged(): Promise<void> {
    this.replaceTombstones(this.config.cameraGridTombstones)
    await this.normalizeRows()
    await this.applyLayoutChanges()
    if (this.relay) {
      void this.reconcile().catch((error: unknown) => {
        this.ctx.logger.warn('camera grid: reconciliation after a config change failed', {
          meta: { error: errMsg(error) },
        })
      })
    }
  }

  protected async onShutdown(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    this.reconcileTimer = null
    installGridCameraRuntime(null)
    await this.relay?.dispose()
    this.relay = null
    for (const entry of this.sessions.values()) await entry.session.dispose()
    this.sessions.clear()
    this.snapshots = null
    this.frameSampler = null
  }

  // ── Rows ────────────────────────────────────────────────────────────────

  private instances(): readonly GridInstance[] {
    return readGridInstances(this.config.cameraGrids, (message) => {
      this.ctx.logger.warn(message)
    })
  }

  private instanceById(instanceId: string): GridInstance | undefined {
    return this.instances().find((instance) => instance.id === instanceId)
  }

  /**
   * Fill in everything a name-only row is missing, and persist if it changed.
   *
   * Without this a freshly typed row is unparseable, and `readGridInstances`
   * IGNORES what it cannot parse — so creation would silently do nothing.
   */
  private async normalizeRows(): Promise<void> {
    const normalized = normalizeGridRows(this.config.cameraGrids, () => crypto.randomUUID())
    if (!normalized.changed) return
    this.ctx.logger.info('camera grid: completing operator-created rows', {
      meta: { rows: normalized.rows.length, wasRows: this.config.cameraGrids.length },
    })
    await this.updateGlobalSettings({ cameraGrids: [...normalized.rows] })
  }

  private replaceTombstones(stableIds: readonly string[]): void {
    this.tombstones.clear()
    for (const stableId of stableIds) {
      if (typeof stableId === 'string' && stableId.length > 0) this.tombstones.add(stableId)
    }
  }

  // ── Declaration ─────────────────────────────────────────────────────────

  private async reconcile(): Promise<void> {
    if (!this.relay) return
    const instances = this.instances()
    const declarations = buildGridCameraDeclarations(instances)
    await this.refreshSourcePlans(instances)
    await this.retireWithdrawnSessions(instances)

    const declared = new DeclaredDevices({
      logger: this.ctx.logger.child('declaration'),
      addonId: this.ctx.id,
      devices: this.ctx.kernel.devices,
      localNodeId: this.ctx.kernel.localNodeId,
      getIntegration: async (addonId) => {
        const integration = await this.ctx.api.integrations.getByAddonId.query({ addonId })
        this.integrationId = integration?.id ?? null
        return integration
      },
      createIntegration: async (input) => {
        const integration = await this.ctx.api.integrations.create.mutate(input)
        this.integrationId = integration.id
        return integration
      },
      updateIntegration: async ({ id, info }) => {
        await this.ctx.api.integrations.update.mutate({ id, info, skipRestart: true })
      },
      listOwnDevices: async () => {
        // `{ addonId }` takes device-manager's INDEXED branch — this addon's
        // handful of rows, never the fleet.
        const rows = await this.ctx.api.deviceManager.listAll.query({ addonId: this.ctx.id })
        return gridCameraReconciliationIndex(
          rows,
          this.integrationId,
          declarations,
          this.tombstones,
        )
      },
    })

    const result = await declared.reconcile({
      integrationName: INTEGRATION_NAME,
      placement: 'hub',
      devices: declarations.map((camera: GridCameraDeclaration) => ({
        stableId: camera.stableId,
        name: camera.name,
        type: DeviceType.Camera,
        DeviceClass: GridCameraDevice,
        config: camera.config,
        role: 'camera-grid',
      })),
    })

    const declaredByStableId = new Map(
      declarations.map((camera) => [camera.stableId, camera] as const),
    )
    for (const outcome of result.devices) {
      if (!(outcome.device instanceof GridCameraDevice)) continue
      const declaration = declaredByStableId.get(outcome.stableId)
      if (!declaration) continue
      const config = outcome.device.config
      if (config.get('instanceId') !== declaration.config.instanceId) {
        await config.setAll(declaration.config)
      }
      const instanceId = declaration.config.instanceId
      this.deviceIdByInstanceId.set(instanceId, outcome.device.id)
      this.ensureSessions(instanceId, outcome.device.id)
      // ONLY on creation. An operator who deliberately turns detection back on
      // for a grid must win, and a pass that re-asserted this every minute
      // would silently overrule them.
      if (outcome.created) await this.silenceAnalysis(outcome.device.id)
      outcome.device.setAddonOnline(true)
    }
  }

  private async silenceAnalysis(deviceId: number): Promise<void> {
    try {
      await silenceAnalysisFor({ api: this.ctx.api, logger: this.ctx.logger }, deviceId)
    } catch (error) {
      // Thrown by design when a BOUND analyzer refused the write — the grid
      // would then run a full detection pipeline over a picture whose subjects
      // are already counted on the cameras it was composed from.
      this.ctx.logger.error('camera grid: a new grid could not be silenced', {
        tags: { deviceId },
        meta: { error: errMsg(error) },
      })
    }
  }

  // ── Activity forwarding ──────────────────────────────────

  /**
   * Listen to the SOURCES, so the grid can say the same things about itself.
   *
   * Filtered by source id inside the handler rather than by subscribing per
   * camera: the bus filter is per category, the set of sources changes whenever
   * an operator drags a cell, and a per-camera subscription would have to be
   * torn down and rebuilt on every layout save.
   *
   * Every handler is TOTAL — a malformed payload is ignored, never thrown out
   * of. These are telemetry events on a shared bus (D8/D11), and a throw here
   * would take the grid's forwarding down for every grid because one camera
   * emitted something unexpected.
   */
  private subscribeSourceActivity(): void {
    this.subscribe({ category: EventCategory.MotionOnMotionChanged }, (event) => {
      const data = event.data as Partial<MotionOnMotionChangedPayload>
      if (typeof data.deviceId !== 'number' || typeof data.detected !== 'boolean') return
      const at = typeof data.timestamp === 'number' ? data.timestamp : Date.now()
      this.activity?.onSourceMotion(data.deviceId, data.detected, at)
    })
    this.subscribe({ category: EventCategory.PipelineAudioInferenceResult }, (event) => {
      const data = event.data as Partial<PipelineAudioInferenceResultPayload>
      const dbfs = data.frame?.level?.dbfs
      if (typeof data.deviceId !== 'number' || typeof dbfs !== 'number') return
      this.activity?.onSourceAudio(data.deviceId, dbfs, Date.now())
    })
    this.subscribe({ category: EventCategory.DetectionResult }, (event) => {
      const data = event.data as Partial<DetectionResultPayload>
      const frame = data.frame
      if (frame === undefined || frame.kind !== 'frame') return
      this.activity?.onSourceDetections(frame)
    })
  }

  /**
   * Which grids show this camera. Empty for the overwhelming majority of
   * events, which is why it is the FIRST thing every handler asks.
   */
  private gridsForSource(sourceDeviceId: number): readonly GridActivityTarget[] {
    const targets: GridActivityTarget[] = []
    for (const [instanceId, deviceId] of this.deviceIdByInstanceId) {
      const instance = this.instanceById(instanceId)
      if (!instance || !instance.enabled) continue
      // A grid never forwards its OWN events back into itself. One grid used as
      // a cell of another is a shape this addon permits, and without this the
      // pair would echo each other for ever.
      if (sourceDeviceId === deviceId) continue
      const cells = instance.cells.filter((cell) => cell.deviceId === sourceDeviceId)
      if (cells.length === 0) continue
      targets.push({
        deviceId,
        canvas: this.canvasFor(instanceId) ?? { width: 0, height: 0 },
        cellsForSource: (id) =>
          instance.cells
            .filter((cell) => cell.deviceId === id)
            .map((cell) => ({ source: cell.source, cell: cell.cell })),
        sourceDeviceIds: [...new Set(instance.cells.map((cell) => cell.deviceId))],
      })
    }
    return targets
  }

  // ── Sources ──────────────────────────────────────────────

  /**
   * Which stream each grid reads each of its sources at, asked of the BROKER.
   *
   * `listAllProfileSlots` is the one authority on "does 101 have a low
   * assigned", and `sourceCamStreamId === null` is its way of saying no. A read
   * that FAILS leaves the previous answer in place and says so — it is not an
   * empty catalog, and turning it into one would retract the streams of every
   * grid on the hub.
   */
  private async refreshSourcePlans(instances: readonly GridInstance[]): Promise<void> {
    let slots: readonly ProfileSlot[]
    try {
      slots = await this.ctx.api.streamBroker.listAllProfileSlots.query()
    } catch (error) {
      this.ctx.logger.warn(
        'camera grid: could not read the broker profile slots - keeping the last answer',
        { meta: { error: errMsg(error), grids: instances.length } },
      )
      return
    }
    // The RESOLUTION travels with the profile. It used to be dropped here, and
    // dropping it is what made the composite soft: the choice of stream is
    // arithmetic over the crop and these numbers, not a preference.
    const servedBy = new Map<number, ServedProfile[]>()
    for (const slot of slots) {
      if (slot.sourceCamStreamId === null) continue
      const profiles = servedBy.get(slot.deviceId) ?? []
      profiles.push({
        profile: slot.profile,
        // A slot that states no size is ordered as cheapest rather than
        // discarded (`gridSourceProfiles`): unmeasurable is not absent.
        width: slot.resolution?.width ?? 0,
        height: slot.resolution?.height ?? 0,
      })
      servedBy.set(slot.deviceId, profiles)
    }
    for (const instance of instances) {
      const plans = gridProfilePlans({
        publishedProfiles: instance.publishedProfiles,
        cells: instance.cells.map((cell) => ({
          deviceId: cell.deviceId,
          source: cell.source,
          cell: cell.cell,
        })),
        // A camera the broker never mentioned is UNKNOWN, not empty - but the
        // broker lists a slot for every device it knows, so a device missing
        // from the list is one it has never published. Both are a refusal.
        profilesServedBy: (deviceId: number) => servedBy.get(deviceId) ?? null,
      })
      const previous = this.plansByInstanceId.get(instance.id)
      this.plansByInstanceId.set(instance.id, plans)
      this.logSourcePlan(instance, plans, previous)
    }
  }

  /**
   * Say WHICH stream each cell is read at, and who could not be read - once per
   * change.
   *
   * Both halves earn their line. A grid silently missing from a catalog is
   * indistinguishable from a broker that swept it, so the refusal names the
   * sources. And the chosen profiles are the answer to "why is this tile
   * soft?" — a camera whose only assigned slot is `high` is read at `high`, and
   * nothing else in the system would ever say so.
   *
   * Logged on the EDGE: a grid that cannot be composed would otherwise write a
   * line a minute for ever.
   */
  private logSourcePlan(
    instance: GridInstance,
    plans: readonly GridProfilePlan[],
    previous: readonly GridProfilePlan[] | undefined,
  ): void {
    const shape = (value: readonly GridProfilePlan[]): string => JSON.stringify(value)
    if (previous !== undefined && shape(previous) === shape(plans)) return
    const deviceId = this.deviceIdByInstanceId.get(instance.id) ?? 0
    for (const row of plans) {
      if (row.offered || row.missingSources.length === 0) continue
      this.ctx.logger.info('camera grid: a profile is NOT on offer', {
        tags: { deviceId },
        meta: {
          instanceId: instance.id,
          profile: row.profile,
          missingSources: [...row.missingSources],
        },
      })
    }
    this.ctx.logger.info('camera grid: published profiles', {
      tags: { deviceId },
      meta: {
        instanceId: instance.id,
        // The canvas beside the profile, because it is DERIVED and nothing
        // else in the system would ever say what it came out as.
        offered: Object.fromEntries(
          plans
            .filter((row) => row.offered && row.published)
            .map((row) => [
              row.profile,
              row.offered ? `${String(row.canvas.width)}x${String(row.canvas.height)}` : '',
            ]),
        ),
      },
    })
  }

  private plansFor(instanceId: string): readonly GridProfilePlan[] | null {
    return this.plansByInstanceId.get(instanceId) ?? null
  }

  private planFor(instanceId: string, profile: CamProfile): GridProfilePlan | null {
    return this.plansFor(instanceId)?.find((row) => row.profile === profile) ?? null
  }

  /**
   * The canvas of the BEST profile this grid offers.
   *
   * Used where a single geometry is needed for something that is not a
   * composition — the detection boxes a grid forwards (`grid-activity`), which
   * are normalized against whatever picture the viewer is looking at. The best
   * offered one is the honest default; a grid offering nothing has no geometry
   * and says so.
   */
  private canvasFor(
    instanceId: string,
  ): { readonly width: number; readonly height: number } | null {
    for (const row of this.plansFor(instanceId) ?? []) {
      if (row.offered) return row.canvas
    }
    return null
  }

  // ── Sessions ────────────────────────────────────────────

  private ensureSessions(instanceId: string, deviceId: number): void {
    for (const profile of GRID_PROFILES) {
      const key = sessionKey(instanceId, profile)
      const plan = this.planFor(instanceId, profile)
      if (plan === null || !plan.offered || !plan.published) {
        const stale = this.sessions.get(key)
        if (stale) {
          this.sessions.delete(key)
          void stale.session.dispose()
        }
        continue
      }
      if (this.sessions.has(key)) continue
      const binaryPath = this.ffmpegBinaryPath
      if (binaryPath === null) {
        // Stated per camera rather than spawning a PATH `ffmpeg` (D540), and
        // asked again: the next reconcile pass creates the session once the
        // pinned build resolves.
        this.ctx.logger.error(
          'camera-grid: composition refused — no pinned ffmpeg on this node (D540)',
          {
            tags: { deviceId },
            meta: { instanceId, profile },
          },
        )
        void this.resolveFfmpeg()
        continue
      }
      this.sessions.set(
        key,
        new GridSessionEntry(
          instanceId,
          profile,
          this.makeSession(instanceId, deviceId, profile, binaryPath),
        ),
      )
    }
  }

  /**
   * The source cameras' names, for the cards the canvas is seeded with.
   *
   * Asked of the device manager, which OWNS the name, at the moment the seed is
   * drawn — never kept here. A consumer that mirrored this would be stale on
   * exactly the write an operator makes (D224), for a label.
   *
   * A device that cannot be read is simply absent from the map, and its card
   * carries the device id instead. One unreadable camera never costs the other
   * cards their names, which is why these are settled rather than awaited as
   * one batch.
   */
  private async sourceNames(deviceIds: readonly number[]): Promise<ReadonlyMap<number, string>> {
    const names = new Map<number, string>()
    const results = await Promise.allSettled(
      deviceIds.map(async (deviceId) => {
        const device = await this.ctx.api.deviceManager.getDevice.query({ deviceId })
        return { deviceId, name: device?.name ?? null }
      }),
    )
    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      const { deviceId, name } = result.value
      if (name !== null) names.set(deviceId, name)
    }
    return names
  }

  private makeSession(
    instanceId: string,
    deviceId: number,
    profile: CamProfile,
    binaryPath: string,
  ): GridStreamSession {
    const childContext: GridChildContext = {
      binaryPath,
      logger: this.ctx.logger,
      deviceId,
      resolveSourceNames: (deviceIds) => this.sourceNames(deviceIds),
    }
    const session: GridStreamSession = new GridStreamSession({
      deviceId,
      deps: {
        logger: this.ctx.logger,
        acquireSource: async (sourceDeviceId) => {
          // 1:1 — this composition reads the MATCHING profile of every source.
          // There is nothing to resolve: a grid's `low` is made of `low`.
          // A provider that has not republished YET is not a provider that is
          // missing. For a few seconds after a hub restart `getStreamWithCodec`
          // answers "not published for device N", and a grid opened in that
          // window used to fail outright (observed 2026-09-18 12:02, twice, gone
          // by the next attempt). Bounded, and it changes no verdict: a camera
          // that really has no such profile still fails, with the provider's own
          // message, after a wait this logs.
          const source = await acquireWithRetry(
            () =>
              this.ctx.api.streamBroker.getStreamWithCodec.mutate({
                deviceId: sourceDeviceId,
                // A grid RE-ENCODES its composition, so the sources only have to
                // decode: a passthrough copy is the cheapest thing the broker can
                // hand over, and it rides the ONE dial that camera already has.
                video: 'copy',
                audio: 'none',
                // Each source at ITS OWN cheapest stream (`grid-profiles.ts`).
                // A tile is a fraction of the canvas, so asking a camera for
                // `high` to draw a quarter of a picture is the most expensive
                // way to produce the worst one.
                profile,
                tag: `camera-grid:${String(deviceId)}:${profile}`,
              }),
            {
              budgetMs: SOURCE_ACQUIRE_BUDGET_MS,
              now: () => Date.now(),
              sleep: () => new Promise((resolve) => setTimeout(resolve, SOURCE_ACQUIRE_PAUSE_MS)),
              onRetry: (waitedMs) => {
                this.ctx.logger.info(
                  'camera grid: a source has not republished yet — asking again',
                  {
                    tags: { deviceId },
                    meta: { instanceId, profile, sourceDeviceId, waitedMs },
                  },
                )
              },
            },
          )
          const dial = gridSourceDial(source)
          // Which cell is reading what, named. A still tile in a live picture
          // is otherwise indistinguishable from a broken one.
          this.ctx.logger.info('camera grid: source acquired', {
            tags: { deviceId },
            meta: {
              instanceId,
              profile,
              sourceDeviceId,
              mode: dial.mode,
              ...(dial.mode === 'sentry'
                ? { why: 'battery source - the sentry dial never asks for the camera' }
                : {}),
            },
          })
          return { url: dial.url, pipelineKey: dial.pipelineKey }
        },
        releaseSource: async (pipelineKey) => {
          await this.ctx.api.streamBroker.releaseStreamWithCodec.mutate({ pipelineKey })
        },
        startChild: async (plan, sources) =>
          startGridCompositorChild(childContext, plan, sources, (reason) => {
            session.onChildEnded(reason)
          }),
      },
      resolvePlan: () => {
        const instance = this.instanceById(instanceId)
        const plan = this.planFor(instanceId, profile)
        // Re-read on every (re)start rather than captured: a layout saved while
        // a composition runs changes the canvas this profile derives, and the
        // next start must build the new picture, not the one it was made with.
        if (!instance || plan === null || !plan.offered || !plan.published) return null
        return gridPlanFor(instance, {
          // Software encode, software decode. Resolving a hardware backend is
          // the DECODER ADDON's answer, per node, and asking for one here would
          // be the kernel resolver's qsv-first order - the known-bad one.
          encoder: 'libx264',
          decodeHwAccel: null,
          canvas: plan.canvas,
        })
      },
    })
    return session
  }

  /** The session a dial is asking for, or `null` - which the relay answers 404 to. */
  private sessionFor(request: GridStreamRequest): GridStreamSession | null {
    return this.sessions.get(sessionKey(request.instanceId, request.profile))?.session ?? null
  }

  /** This grid's sessions, in DESCENDING quality — the snapshot takes the first running one. */
  private sessionsForDevice(deviceId: number): readonly GridSessionEntry[] {
    const instanceId = this.instanceIdForDevice(deviceId)
    if (instanceId === null) return []
    const entries: GridSessionEntry[] = []
    for (const profile of GRID_PROFILES) {
      const entry = this.sessions.get(sessionKey(instanceId, profile))
      if (entry) entries.push(entry)
    }
    return entries
  }

  /** A grid that is gone stops immediately - it must not keep N sources dialled. */
  private async retireWithdrawnSessions(instances: readonly GridInstance[]): Promise<void> {
    const live = new Set(instances.filter((instance) => instance.enabled).map((i) => i.id))
    for (const [key, entry] of [...this.sessions]) {
      if (live.has(entry.instanceId)) continue
      this.ctx.logger.info('camera grid: retiring a withdrawn grid', {
        tags: { deviceId: this.deviceIdByInstanceId.get(entry.instanceId) ?? 0 },
        meta: { instanceId: entry.instanceId },
      })
      this.sessions.delete(key)
      await entry.session.dispose()
    }
    for (const instanceId of [...this.deviceIdByInstanceId.keys()]) {
      if (live.has(instanceId)) continue
      this.activity?.forget(this.deviceIdByInstanceId.get(instanceId) ?? 0)
      this.deviceIdByInstanceId.delete(instanceId)
      this.plansByInstanceId.delete(instanceId)
    }
  }

  /**
   * A geometry change is a NEW composition. The running child is composing the
   * old one, and ffmpeg has no way to be told otherwise, so it is stopped: the
   * consumer's next read re-dials and gets the new picture.
   */
  private async applyLayoutChanges(): Promise<void> {
    for (const entry of this.sessions.values()) {
      if (!entry.session.isRunning()) continue
      this.ctx.logger.info('camera grid: the layout changed - restarting the composition', {
        tags: { deviceId: this.deviceIdByInstanceId.get(entry.instanceId) ?? 0 },
        meta: { instanceId: entry.instanceId },
      })
      entry.session.onChildEnded('layout-changed')
    }
  }

  // ── Snapshot ────────────────────────────────────────────

  private async getSnapshot(deviceId: number): Promise<GridSnapshotImage | null> {
    const snapshots = this.snapshots
    if (snapshots === null) return null
    return snapshots.getSnapshot(deviceId)
  }

  /**
   * One frame out of a composition that is ALREADY running.
   *
   * `openIfRunning` is the whole guarantee: it refuses a cold session, so a
   * thumbnail can never be the reason N sources get acquired. A grid that is
   * not being watched has no fresh frame, and that is the honest answer.
   */
  private async sampleFrame(entry: GridSessionEntry): Promise<Buffer | null> {
    const sampler = this.frameSampler
    if (sampler === null) return null
    return sampler.sample(entry.session.deviceId, {
      attach: (onChunk) =>
        entry.session.openIfRunning({
          onData: onChunk,
          onClose: () => {
            // The composition ended under the grab. The grab's own deadline and
            // its empty output are what report that; there is nothing to add.
          },
        }),
    })
  }

  // ── Catalog + layout ─────────────────────────────────────

  /**
   * Every stream this grid offers, or `null` when the addon cannot say.
   *
   * `null` is a refusal to describe and the device turns it into a THROW. An
   * empty array would be the broker reading "this camera offers nothing" and
   * sweeping every stream it holds for the grid.
   */
  private descriptorsFor(instanceId: string): readonly CamStreamDescriptor[] | null {
    const instance = this.instanceById(instanceId)
    const relay = this.relay
    const plans = this.plansFor(instanceId)
    if (!instance || !relay || plans === null) return null
    // A profile nobody can serve is not NAMED here: naming it would have the
    // broker dial a composition that cannot start. `null` above is the
    // different answer — "this addon cannot say yet" — which the device turns
    // into a throw rather than letting the broker sweep the lot.
    return plans
      .filter((row) => row.offered && row.published)
      .map((row) =>
        gridStreamDescriptor({
          profile: row.profile,
          // DERIVED, not authored: the canvas each profile composes onto is
          // whatever its own sources imply (`grid-canvas-derivation.ts`).
          width: row.offered ? row.canvas.width : 0,
          height: row.offered ? row.canvas.height : 0,
          fps: instance.fps,
          url: relay.streamUrl({ instanceId, profile: row.profile }),
        }),
      )
  }

  private instanceIdForDevice(deviceId: number): string | null {
    for (const [instanceId, id] of this.deviceIdByInstanceId) {
      if (id === deviceId) return instanceId
    }
    return null
  }

  private instanceForDevice(deviceId: number): GridInstance | null {
    const instanceId = this.instanceIdForDevice(deviceId)
    return instanceId === null ? null : (this.instanceById(instanceId) ?? null)
  }

  private gridViewFor(deviceId: number): GridLayoutView | null {
    const instance = this.instanceForDevice(deviceId)
    if (!instance) return null
    return {
      instanceId: instance.id,
      deviceId,
      name: instance.name,
      fps: instance.fps,
      cells: instance.cells.map((cell) => ({
        deviceId: cell.deviceId,
        source: cell.source,
        cell: cell.cell,
      })),
      // Not yet asked reads as "nothing on offer" HERE and only here: the
      // editor renders a report, not a catalog, and a report that said
      // "unknown" for the two seconds after a boot would be noise. The CATALOG
      // refuses instead (see `descriptorsFor`).
      profiles: (this.plansByInstanceId.get(instance.id) ?? []).map((row) => ({
        profile: row.profile,
        offered: row.offered,
        // Serviceable is not the same as PUBLISHED: a profile can be sized and
        // deliberately left off, which is what the editor's toggle writes.
        published: row.offered && row.published,
        missingSources: row.offered ? [] : [...row.missingSources],
        // What it came out as. Reported because the operator no longer types it
        // and nothing else in the system would ever say.
        canvas: row.offered ? `${String(row.canvas.width)}x${String(row.canvas.height)}` : '',
      })),
    }
  }

  private async saveGridLayout(input: GridLayoutPatch): Promise<GridLayoutView> {
    const instance = this.instanceForDevice(input.deviceId)
    if (!instance) {
      throw new Error(`camera-grid: device ${String(input.deviceId)} is not a grid camera`)
    }
    const updated = {
      ...instance,
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.fps !== undefined ? { fps: input.fps } : {}),
      ...(input.publishedProfiles !== undefined
        ? { publishedProfiles: [...input.publishedProfiles] }
        : {}),
      cells: input.cells.map((cell) => ({ ...cell })),
    }
    this.ctx.logger.info('camera grid: layout saved', {
      tags: { deviceId: input.deviceId },
      meta: {
        cells: updated.cells.length,
        sources: [...new Set(updated.cells.map((cell) => cell.deviceId))],
        // No canvas here: it is derived per profile and is not known until the
        // next plan refresh reads the sources' sizes. `published profiles`
        // carries it, with the profile it belongs to.
        fps: updated.fps,
      },
    })
    await this.updateGlobalSettings({
      cameraGrids: this.config.cameraGrids.map((row) =>
        row['id'] === instance.id ? { ...row, ...updated } : row,
      ),
    })
    // A new cell list is a new set of sources, so what is on offer may have
    // changed. Asked NOW rather than at the next reconcile: the editor shows
    // the answer, and a report a minute out of date is a report that lies.
    await this.refreshSourcePlans(this.instances())
    this.ensureSessions(instance.id, input.deviceId)
    const view = this.gridViewFor(input.deviceId)
    if (!view) throw new Error('camera-grid: the grid vanished while it was being saved')
    return view
  }

  // ── ffmpeg ──────────────────────────────────────────────────────────────

  /**
   * Resolve the pinned build, single-flighted, and hand it to the frame sampler.
   * Never throws: a failure is an ERROR and leaves the binary unknown, so the
   * next pass that wants a composition asks again. Never PATH: the host's
   * ffmpeg is not ours (`packages/types/src/deps/ffmpeg-binary-source.ts`).
   */
  private resolveFfmpeg(): Promise<void> {
    if (this.ffmpegBinaryPath !== null) return Promise.resolve()
    if (this.ffmpegResolving !== null) return this.ffmpegResolving
    const attempt = this.pinnedFfmpeg()
      .then((binaryPath) => {
        this.ffmpegBinaryPath = binaryPath
        this.frameSampler = new GridFrameSampler({
          binaryPath,
          logger: this.ctx.logger.child('snapshot'),
        })
      })
      .catch((err: unknown) => {
        this.ctx.logger.error(
          'camera-grid: the pinned ffmpeg could not be resolved — compositions refuse until it is (D540)',
          { meta: { error: errMsg(err) } },
        )
      })
      .finally(() => {
        this.ffmpegResolving = null
      })
    this.ffmpegResolving = attempt
    return attempt
  }

  // ── Settings UI ─────────────────────────────────────────────────────────

  /**
   * The integration page: a list of grids, with a NAME.
   *
   * Deliberately nothing else. A generated form for the geometry would render
   * "cell 1 source = 592, cell 1 crop x = 0.25" and be unusable, so the
   * geometry lives in a WIDGET on the camera's own device details, declared by
   * the `camera-grid-layout` CAPABILITY (`camera-grid-layout.cap.ts`). It used
   * to be a `type:'widget'` field in this addon's own `deviceSettingsSchema()`
   * and it rendered NOWHERE: that section is only fetched for the four addons
   * hand-listed in `PIPELINE_CLUSTER_DEVICE_ADDONS`, and an addon not on the
   * list falls off silently. A cap-declared widget is placed by the framework,
   * on the camera, beside PTZ and motion zones.
   */
  protected override globalSettingsSchema(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'camera-grids',
          title: 'Camera grids',
          titleKey: 'server:globalSettings.s_camera-grids.title',
          description:
            'A grid is a composite camera: several cameras composed into one picture, recorded and played back like any other camera. Create one here with a name; open its camera to lay it out. Object detection is switched OFF on a new grid — the cameras it is composed from are already analysed.',
          descriptionKey: 'server:globalSettings.s_camera-grids.description',
          columns: 1,
          fields: [
            this.field({
              type: 'editable-array',
              key: 'cameraGrids',
              label: 'Grids',
              labelKey: 'server:globalSettings.s_camera-grids.cameraGrids.label',
              default: [],
              maxRows: 16,
              addLabel: 'Add grid',
              emptyMessage: 'No camera grids yet.',
              rowTitleTemplate: '{name}',
              defaultItem: { name: '', enabled: true },
              itemFields: [
                {
                  type: 'text',
                  key: 'name',
                  label: 'Name',
                  labelKey: 'server:globalSettings.s_camera-grids.cameraGrids.name.label',
                  required: true,
                },
                {
                  type: 'boolean',
                  key: 'enabled',
                  label: 'Enabled',
                  labelKey: 'server:globalSettings.s_camera-grids.cameraGrids.enabled.label',
                  description: 'A disabled grid withdraws its camera.',
                  descriptionKey:
                    'server:globalSettings.s_camera-grids.cameraGrids.enabled.description',
                  default: true,
                },
              ],
            }),
          ],
        },
      ],
    })
  }

  protected override integrationSettingSections(): readonly string[] {
    return ['camera-grids']
  }
}

export type { DeviceProxy }
