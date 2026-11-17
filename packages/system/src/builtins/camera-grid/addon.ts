/**
 * Camera Grids — several cameras composed into one, emitted as an ordinary
 * camera.
 *
 * ## What it is
 *
 * A grid is a core block (planning#580) with a `grid` helper spec. The composer
 * owns its camera row `composed-<blockId>` and its name; this engine builds a
 * `GridCameraDevice` ON that row and serves every camera cap there as a
 * cross-addon native (D663, resolved through the bindings, D13). Everything
 * downstream treats it as a camera: it records, it appears in the timeline, it
 * has a profile slot — with ONE deliberate exception, object detection, which
 * is switched off the first time the engine hosts the device (see
 * `silence-analysis.ts`, and the per-device flag below).
 *
 * The engine keeps no list of its own (D3): each pass reads the blocks
 * (`coreBlocks.listCompositions`) and the composer's rows. `not-loaded` or a
 * failed read changes nothing, and a hosted grid is withdrawn only after two
 * consecutive trusted reads agree it is gone (D49).
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
  CompositionListRead,
  CompositionSourceRef,
  DeviceProxy,
  EngineHostedBlock,
  GridHelperSpec,
  GridLayoutPatch,
  GridLayoutView,
  HostedEngineDevice,
  ProfileSlot,
  ProviderRegistration,
} from '@camstack/types'
import {
  BaseAddon,
  bareAddonId,
  cameraGridLayoutCapability,
  COMPOSER_ADDON_ID,
  EventCategory,
  HostedWithdrawalGate,
  hostEngineDevice,
  MOTION_CLOSE_AFTER_MS,
  type CamProfile,
  declarationOwnerNodeId,
  errMsg,
  memoizePinnedFfmpeg,
  selectEngineHostedBlocks,
  legacySweepDone,
  sweepLegacyEngineRows,
  type DetectionResultPayload,
  type MotionOnMotionChangedPayload,
  type PipelineAudioInferenceResultPayload,
} from '@camstack/types'
import { GridCameraDevice, installGridCameraRuntime } from './grid-camera-device.js'
import { acquireWithRetry } from './acquire-retry.js'
import {
  type GridComposition,
  gridComposition,
  gridSpecFromPatch,
  resolveGridCells,
  sourceRefKey,
} from './grid-blocks.js'
import { buildGridLayoutNativeProvider } from './grid-layout-native-provider.js'
import { gridPlanFor } from './grid-plan.js'
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

/** The integration the pre-block grid cameras were declared under; only its leftovers are swept. */
const LEGACY_INTEGRATION_NAME = 'Camera Grids'
const RECONCILE_MS = 60_000
/** The per-device flag that analysis was silenced once (`ctx.settings` device store, D865). */
const ANALYSIS_SILENCED_KEY = 'analysisSilenced'
/**
 * How long a source acquire may keep asking while a provider is still coming up.
 * Long enough to cover the republish window after a hub restart, short enough
 * that a genuinely missing profile fails while the operator is still looking.
 */
const SOURCE_ACQUIRE_BUDGET_MS = 8_000
const SOURCE_ACQUIRE_PAUSE_MS = 700

/** The grids are core blocks (planning#580); the addon keeps no settings of its own. */
type CameraGridAddonConfig = Record<string, never>

const DEFAULTS: CameraGridAddonConfig = {}

/** One composition per (grid, profile) — a grid composes each separately. */
function sessionKey(blockId: string, profile: CamProfile): string {
  return `${blockId}::${profile}`
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
    readonly blockId: string,
    readonly profile: CamProfile,
    readonly session: GridStreamSession,
  ) {}

  isRunning(): boolean {
    return this.session.isRunning()
  }
}

/** A grid block this engine hosts: the block as last read, its cells resolved, its device. */
interface HostedGrid {
  readonly block: EngineHostedBlock<GridHelperSpec>
  readonly layout: GridComposition
  readonly hosted: HostedEngineDevice<GridCameraDevice>
}

/** Device ids by source identity, and the source addons whose rows could not be read. */
interface SourceIndex {
  readonly ids: ReadonlyMap<string, number>
  readonly unreadAddons: ReadonlySet<string>
}

export class CameraGridAddon extends BaseAddon<CameraGridAddonConfig> {
  private relay: GridStreamRelay | null = null
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  /** Keyed by session key — ONE composition per (grid, profile). */
  private readonly sessions = new Map<string, GridSessionEntry>()
  /** The grids this engine hosts, by block id. */
  private grids: ReadonlyMap<string, HostedGrid> = new Map()
  private readonly withdrawalGate = new HostedWithdrawalGate()
  /** One pass at a time: a save and the timer must not host the same block twice. */
  private passChain: Promise<void> = Promise.resolve()
  /** True once a pass found no legacy `camera-grid` row left to remove. */
  private legacySwept = false
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
  private readonly plansByBlockId = new Map<string, readonly GridProfilePlan[]>()
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

  constructor() {
    super({ ...DEFAULTS })
  }

  protected async onInitialize(): Promise<AddonInitResult> {
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
        addonId: bareAddonId(this.ctx.id),
        gridsForSource: (sourceDeviceId) => this.gridsForSource(sourceDeviceId),
        now: () => Date.now(),
      })
      this.subscribeSourceActivity()
      installGridCameraRuntime({
        descriptorsFor: (blockId) => this.descriptorsFor(blockId),
        getLayout: (deviceId) => this.gridViewFor(deviceId),
        isGrid: (deviceId) => this.gridForDevice(deviceId) !== null,
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
      isGrid: (deviceId) => this.gridForDevice(deviceId) !== null,
      saveLayout: (patch) => this.saveGridLayout(patch),
    })
    const providers: ProviderRegistration[] = [
      { capability: cameraGridLayoutCapability, provider: layoutProvider },
    ]
    return { providers }
  }

  protected async onShutdown(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    this.reconcileTimer = null
    installGridCameraRuntime(null)
    await this.relay?.dispose()
    this.relay = null
    for (const entry of this.sessions.values()) await entry.session.dispose()
    this.sessions.clear()
    for (const grid of this.grids.values()) await grid.hosted.withdraw().catch(() => undefined)
    this.grids = new Map()
    this.snapshots = null
    this.frameSampler = null
  }

  // ── Hosting ─────────────────────────────────────────────────────────────

  private gridById(blockId: string): HostedGrid | null {
    return this.grids.get(blockId) ?? null
  }

  private gridForDevice(deviceId: number): HostedGrid | null {
    for (const grid of this.grids.values()) {
      if (grid.block.deviceId === deviceId) return grid
    }
    return null
  }

  /** One pass at a time, in order: a save waits for a running pass and the reverse. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.passChain.then(work, work)
    this.passChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private reconcile(): Promise<void> {
    return this.serialized(async () => {
      if (!this.relay) return
      await this.sweepLegacyCameras()
      await this.hostGridBlocks()
    })
  }

  /** Read the grid blocks and host what they name. A read that cannot be trusted changes nothing (D49). */
  private async hostGridBlocks(): Promise<void> {
    let compositions: CompositionListRead
    let composerRows: readonly { readonly id: number; readonly stableId: string }[]
    try {
      compositions = await this.ctx.api.coreBlocks.listCompositions.query({})
      composerRows = await this.ctx.api.deviceManager.listAll.query({
        addonId: COMPOSER_ADDON_ID,
        projection: 'slim',
      })
    } catch (error: unknown) {
      this.ctx.logger.warn('camera grid: the grid blocks could not be read - nothing changes', {
        meta: { error: errMsg(error) },
      })
      return
    }
    const read = selectEngineHostedBlocks('grid', compositions, composerRows)
    if (read.kind === 'untrusted') {
      this.ctx.logger.info('camera grid: the blocks are not loaded yet - nothing changes', {
        meta: { reason: read.reason },
      })
      return
    }
    const wanted = read.blocks.filter((block) => block.enabled)
    const { withdraw } = this.withdrawalGate.judge(
      this.grids.keys(),
      new Set(wanted.map((block) => block.blockId)),
    )
    for (const blockId of withdraw) await this.unhost(blockId, 'its block is gone or switched off')

    const sources = await this.readSources(wanted)
    const next = new Map(this.grids)
    for (const block of wanted) {
      const hosted = await this.hostOne(block, sources)
      if (hosted !== null) next.set(block.blockId, hosted)
    }
    this.grids = next
    await this.refreshSourcePlans()
    for (const grid of this.grids.values()) {
      this.ensureSessions(grid.block.blockId, grid.block.deviceId)
    }
  }

  /** Build (or refresh) one grid. A failure is logged per device and leaves the previous state. */
  private async hostOne(
    block: EngineHostedBlock<GridHelperSpec>,
    sources: SourceIndex,
  ): Promise<HostedGrid | null> {
    const previous = this.gridById(block.blockId)
    const layout = this.layoutOf(block, sources, previous)
    if (previous !== null) {
      if (previous.block.deviceId === block.deviceId) {
        const changed = JSON.stringify(previous.layout) !== JSON.stringify(layout)
        if (changed) await this.applyLayoutChanges(block.blockId)
        return { block, layout, hosted: previous.hosted }
      }
      await this.unhost(block.blockId, 'its row changed')
    }
    let hosted: HostedEngineDevice<GridCameraDevice>
    try {
      hosted = await hostEngineDevice(
        this.ctx.kernel.devices,
        { id: block.deviceId, stableId: block.stableId },
        { blockId: block.blockId },
        GridCameraDevice,
      )
    } catch (error: unknown) {
      this.ctx.logger.error('camera grid: a grid block could not be hosted', {
        tags: { deviceId: block.deviceId },
        meta: { blockId: block.blockId, error: errMsg(error) },
      })
      return null
    }
    this.ctx.logger.info('camera grid: hosting a grid block on its camera row', {
      tags: { deviceId: block.deviceId },
      meta: { blockId: block.blockId, cells: layout.cells.length },
    })
    // Never throws: once its natives are registered the device is kept, so a
    // later pass withdraws it rather than building a second one.
    await this.silenceOnce(block.deviceId)
    return { block, layout, hosted }
  }

  /**
   * The grid's cells resolved to device ids. A source whose addon could not be
   * read keeps the previous resolution; a source that has no row is left out
   * and named.
   */
  private layoutOf(
    block: EngineHostedBlock<GridHelperSpec>,
    sources: SourceIndex,
    previous: HostedGrid | null,
  ): GridComposition {
    const blind = block.spec.cells.some((cell) => sources.unreadAddons.has(cell.source.addonId))
    if (blind && previous !== null) return { ...previous.layout, fps: block.spec.fps }
    const { cells, unresolved } = resolveGridCells(
      block.spec,
      (ref) => sources.ids.get(sourceRefKey(ref)) ?? null,
    )
    if (unresolved.length > 0) {
      this.ctx.logger.warn('camera grid: a cell names a source with no device - it is left out', {
        tags: { deviceId: block.deviceId },
        meta: { blockId: block.blockId, missing: unresolved.map(sourceRefKey) },
      })
    }
    return { fps: block.spec.fps, publishedProfiles: block.spec.publishedProfiles, cells }
  }

  /** One indexed read per source addon (`listAll({ addonId })`), never the fleet. */
  private async readSources(
    blocks: readonly EngineHostedBlock<GridHelperSpec>[],
  ): Promise<SourceIndex> {
    const addonIds = new Set(blocks.flatMap((b) => b.spec.cells.map((c) => c.source.addonId)))
    const ids = new Map<string, number>()
    const unreadAddons = new Set<string>()
    for (const addonId of addonIds) {
      try {
        const rows = await this.ctx.api.deviceManager.listAll.query({
          addonId,
          projection: 'slim',
        })
        for (const row of rows) ids.set(sourceRefKey({ addonId, stableId: row.stableId }), row.id)
      } catch (error: unknown) {
        unreadAddons.add(addonId)
        this.ctx.logger.warn('camera grid: the sources of one addon could not be read', {
          meta: { addonId, error: errMsg(error) },
        })
      }
    }
    return { ids, unreadAddons }
  }

  private async unhost(blockId: string, reason: string): Promise<void> {
    const grid = this.gridById(blockId)
    if (grid === null) return
    const deviceId = grid.block.deviceId
    this.ctx.logger.info('camera grid: no longer hosting a grid block', {
      tags: { deviceId },
      meta: { blockId, reason },
    })
    for (const [key, entry] of [...this.sessions]) {
      if (entry.blockId !== blockId) continue
      this.sessions.delete(key)
      await entry.session.dispose()
    }
    this.activity?.forget(deviceId)
    this.plansByBlockId.delete(blockId)
    grid.hosted.device.setAddonOnline(false)
    try {
      await grid.hosted.withdraw()
    } catch (error: unknown) {
      this.ctx.logger.warn('camera grid: withdrawing a grid device failed', {
        tags: { deviceId },
        meta: { blockId, error: errMsg(error) },
      })
    }
    this.grids = new Map([...this.grids].filter(([id]) => id !== blockId))
  }

  /**
   * Analysis is silenced the FIRST time this engine hosts the device, and the
   * fact is kept per device (`ctx.settings` device store, cleared with the
   * device, D865). An operator who turns detection back on must win: it is
   * never re-asserted.
   */
  private async silenceOnce(deviceId: number): Promise<void> {
    const settings = this.ctx.settings
    if (!settings) {
      // Without the flag the silence would be re-asserted on every boot, over
      // an operator who turned detection back on. Refused by name instead.
      this.ctx.logger.warn('camera grid: no settings store - analysis is not silenced', {
        tags: { deviceId },
      })
      return
    }
    try {
      const store = await settings.readDeviceStore(deviceId)
      if (store[ANALYSIS_SILENCED_KEY] === true) return
      await silenceAnalysisFor({ api: this.ctx.api, logger: this.ctx.logger }, deviceId)
      await settings.writeDeviceStore(deviceId, { [ANALYSIS_SILENCED_KEY]: true })
    } catch (error) {
      // Thrown by design when a BOUND analyzer refused the write — the grid
      // would then run a full detection pipeline over a picture whose subjects
      // are already counted on the cameras it was composed from. A store that
      // could not be read lands here too. Not marked, so the next hosting
      // asks again.
      this.ctx.logger.error('camera grid: a new grid could not be silenced', {
        tags: { deviceId },
        meta: { error: errMsg(error) },
      })
    }
  }

  /**
   * The grid cameras declared before grids were blocks are not carried over
   * (planning#580: the operator recreates them as blocks). Every row this addon
   * still owns under its old integration is removed through the declared sweep
   * (`removeDevice` → tombstone, D865). No integration means nothing was ever
   * declared, and nothing is minted to find out.
   */
  private async sweepLegacyCameras(): Promise<void> {
    if (this.legacySwept) return
    const addonId = bareAddonId(this.ctx.id)
    try {
      const sweep = await sweepLegacyEngineRows(
        {
          logger: this.ctx.logger.child('legacy-sweep'),
          addonId,
          devices: this.ctx.kernel.devices,
          localNodeId: this.ctx.kernel.localNodeId,
          getIntegration: (owner) =>
            this.ctx.api.integrations.getByAddonId.query({ addonId: owner }),
          // `{ addonId }` takes device-manager's INDEXED branch.
          listAddonRows: (owner) => this.ctx.api.deviceManager.listAll.query({ addonId: owner }),
        },
        LEGACY_INTEGRATION_NAME,
      )
      if (sweep.kind === 'swept' && sweep.removed.length > 0) {
        this.ctx.logger.info('camera grid: legacy grid cameras removed - recreate them as blocks', {
          meta: { removed: [...sweep.removed] },
        })
      }
      if (legacySweepDone(sweep)) this.legacySwept = true
    } catch (error: unknown) {
      this.ctx.logger.warn('camera grid: the legacy grid cameras could not be swept - retried', {
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
    for (const grid of this.grids.values()) {
      const deviceId = grid.block.deviceId
      const layout = grid.layout
      // A grid never forwards its OWN events back into itself. One grid used as
      // a cell of another is a shape this addon permits, and without this the
      // pair would echo each other for ever.
      if (sourceDeviceId === deviceId) continue
      const cells = layout.cells.filter((cell) => cell.deviceId === sourceDeviceId)
      if (cells.length === 0) continue
      targets.push({
        deviceId,
        canvas: this.canvasFor(grid.block.blockId) ?? { width: 0, height: 0 },
        cellsForSource: (id) =>
          layout.cells
            .filter((cell) => cell.deviceId === id)
            .map((cell) => ({ source: cell.source, cell: cell.cell })),
        sourceDeviceIds: [...new Set(layout.cells.map((cell) => cell.deviceId))],
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
  private async refreshSourcePlans(): Promise<void> {
    const grids = [...this.grids.values()]
    let slots: readonly ProfileSlot[]
    try {
      slots = await this.ctx.api.streamBroker.listAllProfileSlots.query()
    } catch (error) {
      this.ctx.logger.warn(
        'camera grid: could not read the broker profile slots - keeping the last answer',
        { meta: { error: errMsg(error), grids: grids.length } },
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
    for (const grid of grids) {
      const plans = gridProfilePlans({
        publishedProfiles: grid.layout.publishedProfiles,
        cells: grid.layout.cells.map((cell) => ({
          deviceId: cell.deviceId,
          source: cell.source,
          cell: cell.cell,
        })),
        // A camera the broker never mentioned is UNKNOWN, not empty - but the
        // broker lists a slot for every device it knows, so a device missing
        // from the list is one it has never published. Both are a refusal.
        profilesServedBy: (deviceId: number) => servedBy.get(deviceId) ?? null,
      })
      const previous = this.plansByBlockId.get(grid.block.blockId)
      this.plansByBlockId.set(grid.block.blockId, plans)
      this.logSourcePlan(grid, plans, previous)
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
    grid: HostedGrid,
    plans: readonly GridProfilePlan[],
    previous: readonly GridProfilePlan[] | undefined,
  ): void {
    const shape = (value: readonly GridProfilePlan[]): string => JSON.stringify(value)
    if (previous !== undefined && shape(previous) === shape(plans)) return
    const deviceId = grid.block.deviceId
    for (const row of plans) {
      if (row.offered || row.missingSources.length === 0) continue
      this.ctx.logger.info('camera grid: a profile is NOT on offer', {
        tags: { deviceId },
        meta: {
          blockId: grid.block.blockId,
          profile: row.profile,
          missingSources: [...row.missingSources],
        },
      })
    }
    this.ctx.logger.info('camera grid: published profiles', {
      tags: { deviceId },
      meta: {
        blockId: grid.block.blockId,
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

  private plansFor(blockId: string): readonly GridProfilePlan[] | null {
    return this.plansByBlockId.get(blockId) ?? null
  }

  private planFor(blockId: string, profile: CamProfile): GridProfilePlan | null {
    return this.plansFor(blockId)?.find((row) => row.profile === profile) ?? null
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
  private canvasFor(blockId: string): { readonly width: number; readonly height: number } | null {
    for (const row of this.plansFor(blockId) ?? []) {
      if (row.offered) return row.canvas
    }
    return null
  }

  // ── Sessions ────────────────────────────────────────────

  private ensureSessions(blockId: string, deviceId: number): void {
    for (const profile of GRID_PROFILES) {
      const key = sessionKey(blockId, profile)
      const plan = this.planFor(blockId, profile)
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
            meta: { blockId, profile },
          },
        )
        void this.resolveFfmpeg()
        continue
      }
      this.sessions.set(
        key,
        new GridSessionEntry(
          blockId,
          profile,
          this.makeSession(blockId, deviceId, profile, binaryPath),
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
    blockId: string,
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
                    meta: { blockId, profile, sourceDeviceId, waitedMs },
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
              blockId,
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
        const grid = this.gridById(blockId)
        const plan = this.planFor(blockId, profile)
        // Re-read on every (re)start rather than captured: a layout saved while
        // a composition runs changes the canvas this profile derives, and the
        // next start must build the new picture, not the one it was made with.
        if (grid === null || plan === null || !plan.offered || !plan.published) return null
        return gridPlanFor(grid.layout, {
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

  /** The session a dial is asking for, or `null` - which the relay answers 404 to. The relay's `instanceId` is the block id. */
  private sessionFor(request: GridStreamRequest): GridStreamSession | null {
    return this.sessions.get(sessionKey(request.instanceId, request.profile))?.session ?? null
  }

  /** This grid's sessions, in DESCENDING quality — the snapshot takes the first running one. */
  private sessionsForDevice(deviceId: number): readonly GridSessionEntry[] {
    const grid = this.gridForDevice(deviceId)
    if (grid === null) return []
    const entries: GridSessionEntry[] = []
    for (const profile of GRID_PROFILES) {
      const entry = this.sessions.get(sessionKey(grid.block.blockId, profile))
      if (entry) entries.push(entry)
    }
    return entries
  }

  /**
   * A geometry change is a NEW composition. The running child is composing the
   * old one, and ffmpeg has no way to be told otherwise, so it is stopped: the
   * consumer's next read re-dials and gets the new picture.
   */
  private async applyLayoutChanges(blockId: string): Promise<void> {
    const deviceId = this.gridById(blockId)?.block.deviceId ?? 0
    for (const entry of this.sessions.values()) {
      if (entry.blockId !== blockId || !entry.session.isRunning()) continue
      this.ctx.logger.info('camera grid: the layout changed - restarting the composition', {
        tags: { deviceId },
        meta: { blockId, profile: entry.profile },
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
  private descriptorsFor(blockId: string): readonly CamStreamDescriptor[] | null {
    const grid = this.gridById(blockId)
    const relay = this.relay
    const plans = this.plansFor(blockId)
    if (grid === null || !relay || plans === null) return null
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
          fps: grid.layout.fps,
          url: relay.streamUrl({ instanceId: blockId, profile: row.profile }),
        }),
      )
  }

  /**
   * The grid's name is its DEVICE row's: the composer owns the row and keeps
   * it in step with the block, and an operator rename lands there. Asked at
   * the moment the editor reads, never kept here (D224).
   */
  private async gridViewFor(deviceId: number): Promise<GridLayoutView | null> {
    const grid = this.gridForDevice(deviceId)
    if (grid === null) return null
    const device = await this.ctx.api.deviceManager.getDevice
      .query({ deviceId })
      .catch((error: unknown) => {
        this.ctx.logger.warn('camera grid: the grid row could not be read for its name', {
          tags: { deviceId },
          meta: { error: errMsg(error) },
        })
        return null
      })
    return {
      blockId: grid.block.blockId,
      deviceId,
      name: device?.name ?? grid.block.name,
      fps: grid.layout.fps,
      cells: grid.layout.cells.map((cell) => ({
        deviceId: cell.deviceId,
        source: cell.source,
        cell: cell.cell,
      })),
      // Not yet asked reads as "nothing on offer" HERE and only here: the
      // editor renders a report, not a catalog, and a report that said
      // "unknown" for the two seconds after a boot would be noise. The CATALOG
      // refuses instead (see `descriptorsFor`).
      profiles: (this.plansByBlockId.get(grid.block.blockId) ?? []).map((row) => ({
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

  /** The identity `(addonId, stableId)` of each source device, by one targeted read. */
  private async sourceRefs(
    deviceIds: readonly number[],
  ): Promise<ReadonlyMap<number, CompositionSourceRef>> {
    const unique = [...new Set(deviceIds)]
    if (unique.length === 0) return new Map()
    const rows = await this.ctx.api.deviceManager.listAll.query({
      deviceIds: unique,
      projection: 'slim',
    })
    return new Map(rows.map((row) => [row.id, { addonId: row.addonId, stableId: row.stableId }]))
  }

  /**
   * A layout save writes the BLOCK: its spec, sources by identity, with the
   * block's `updatedAt` as the optimistic guard. The name is not the editor's
   * to write (it is the block's, renamed through the block).
   */
  private saveGridLayout(input: GridLayoutPatch): Promise<GridLayoutView> {
    return this.serialized(async () => {
      const grid = this.gridForDevice(input.deviceId)
      if (grid === null) {
        throw new Error(`camera-grid: device ${String(input.deviceId)} is not a grid camera`)
      }
      const refs = await this.sourceRefs(input.cells.map((cell) => cell.deviceId))
      const spec = gridSpecFromPatch(grid.block.spec, input, (id) => refs.get(id) ?? null)
      const composition = gridComposition(spec)
      const result = await this.ctx.api.coreBlocks.updateComposition.mutate({
        blockId: grid.block.blockId,
        expectedUpdatedAt: grid.block.updatedAt,
        block: { composition },
      })
      this.ctx.logger.info('camera grid: layout saved', {
        tags: { deviceId: input.deviceId },
        meta: {
          blockId: grid.block.blockId,
          cells: spec.cells.length,
          sources: [...new Set(input.cells.map((cell) => cell.deviceId))],
          // No canvas here: it is derived per profile and is not known until
          // the next plan refresh reads the sources' sizes. `published
          // profiles` carries it, with the profile it belongs to.
          fps: spec.fps,
        },
      })
      const saved: HostedGrid = {
        hosted: grid.hosted,
        block: { ...grid.block, updatedAt: result.block.updatedAt, composition, spec },
        layout: {
          fps: spec.fps,
          publishedProfiles: spec.publishedProfiles,
          cells: input.cells.map((cell) => ({
            deviceId: cell.deviceId,
            source: cell.source,
            cell: cell.cell,
          })),
        },
      }
      this.grids = new Map([...this.grids, [grid.block.blockId, saved]])
      await this.applyLayoutChanges(grid.block.blockId)
      // A new cell list is a new set of sources, so what is on offer may have
      // changed. Asked NOW rather than at the next reconcile: the editor shows
      // the answer, and a report a minute out of date is a report that lies.
      await this.refreshSourcePlans()
      this.ensureSessions(grid.block.blockId, input.deviceId)
      const view = await this.gridViewFor(input.deviceId)
      if (view === null) throw new Error('camera-grid: the grid vanished while it was being saved')
      return view
    })
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
}

export type { DeviceProxy }
