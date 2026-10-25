/**
 * recorder addon SHELL — recording + storage-evictable providers on the
 * unit-tested recorder core (`recorder/*.ts`).
 *
 * B1 scope (THIS file): the addon lifecycle + provider wiring with NO ffmpeg
 * and NO live recording. It resolves the `recordings` / `recordingsLow`
 * storage roots via the `storage` cap, hydrates the v2 `RecordingIndex` from
 * `storage.list` for every persisted-config device on boot, persists per-device
 * band config via durable-state, answers the `recording` cap reads from the
 * index, prunes footage via `selectEvictions` + `SegmentStore.evict`, and
 * mounts the v2 `StorageEvictableProvider` for disk-pressure eviction.
 *
 * DEFERRED to B2/B3 (search "B2/B3 HOOK" below for the exact insertion points):
 *   - ffmpeg `SegmentWriter` (per-profile passthrough segmenter)
 *   - segment watcher → `SegmentStore.onFinalized` (stat + relocate + index)
 *   - `BandEngine` attach/detach on enable/disable (`activeBandAt`/`bandActiveAt`)
 *   - `EventCapture` (motion/audio markers feeding events-mode bands)
 *   - playback data-plane (getPlaybackManifest currently STUBs null)
 *
 * The old recorder (`addon-pipeline/src/recorder`) stays the live `recording`
 * provider until the controller swaps the manifest entry in a later step — this
 * file ships dormant (separate tree, not wired into the manifest yet).
 */

import { spawn as childProcessSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
// eslint-disable-next-line no-restricted-imports -- createFileDataPlaneHandler / Range helpers are the battle-tested static file-serving primitives (Range/content-type/traversal) the stream-broker embed (this same bundle) also reuses; build-time serving utils, not a runtime addon coupling.
import {
  contentTypeFor,
  createFileDataPlaneHandler,
  parseRangeHeader,
  startEventLoopStallMonitor,
} from '@camstack/system/addon-utils'
import {
  type AddonInitResult,
  BaseAddon,
  type CamProfile,
  type ClipBytesOffer,
  type ConfigUISchema,
  clipExportFailure,
  DeviceType,
  EventCategory,
  type EventSource,
  type ExportRecord,
  errMsg,
  evictionPolicyForMode,
  type IngestOwner,
  type IRecordingArchiveProvider,
  type IStorageEvictableProvider,
  armRemovalReconcile,
  deviceRemovalHookCapability,
  type IDeviceRemovalHookProvider,
  loadContributionCapability,
  type OpsLogReason,
  type ProviderRegistration,
  type RecordingConfig,
  RecordingSignalStatusSchema,
  recordingArchiveCapability,
  recordingCapability,
  recordingExportCapability,
  recordingSignalCapability,
  memoizePinnedFfmpeg,
  sleep,
  storageEvictableCapability,
  storageOccupancyCapability,
  videoclipsCapability,
} from '@camstack/types'
import { ChildCostRegistry } from '@camstack/types/node'
import { subscribeEventCapture } from '../event-capture.js'
import { isMfraTableServable, MfraTableStore, readMfraTable } from '../mfra-capture.js'
import { qualifyObjectTrigger } from '../object-trigger.js'
import { ObjectTriggerHealth, type ObjectTriggerHealthReport } from '../object-trigger-health.js'
import type { DeviceRegistryRead } from '../orphan-device-lane.js'
import { PendingGate, type PendingGateReport } from '../pending-gate.js'
import { DEFAULT_RECORDING_INDEX_BUDGET, RecordingIndex } from '../recording-index.js'
import { RelocateEngine } from '../relocate-engine.js'
import { PLAYBACK_PLANE_PATH } from '../segment-directory.js'
import {
  SegmentStore,
  type SegmentStoreDeps,
  type SegmentStoreLogExtras,
  type SegmentStoreLogMeta,
} from '../segment-store.js'
import {
  buildSensorTriggerBindings,
  parseSensorStateChanged,
  SensorTriggerRouter,
} from '../sensor-trigger.js'
import { StillFrameService } from '../still/still-frame-service.js'
import type { LowSegmentRow } from '../still/still-source.js'
import { StorageEvictableProvider } from '../storage-evictable-provider.js'
import type { Accounting } from '../types.js'
import { CalendarIndex, hourSegmentsFromIndex } from './calendar-index.js'
import { ArchiveFloorReader } from './calendar-window.js'
import { archiveDeviceUsageOf, archiveUsageComplete } from './device-storage-usage.js'
import {
  loadDeviceConfig,
  migrateLegacyDeviceSignalRows,
  type RecordingConfigsState,
  readDeviceConfigs,
  recordingConfigsState,
  warnLostBands,
} from './config-store.js'
import {
  type DebugStoreCensusInput,
  handleStoreCensusAction,
  type RecorderDebugActions,
  recorderDebugActions,
} from './debug-actions.js'
import { withDirectoryRoute } from './directory-handler.js'
import { resolveEvictionDomain } from './eviction-domain.js'
import {
  type DiscardStartInput,
  type LocationDiscardActions,
  locationDiscardActions,
} from './location-discard-actions.js'
import {
  createFootageDiscardJob,
  type FootageDiscardJob,
  IDLE_DISCARD,
} from './location-discard-job.js'
import { requireReadableLocation } from './location-resolve.js'

/**
 * Hub harvests this named export into CustomActionRegistry. Actions that
 * exist only on the onInitialize envelope stay invisible to `addons.custom`.
 */
export const customActions = { ...recorderDebugActions, ...locationDiscardActions }

import { createRecordingConfigMirror, type RecordingConfigMirror } from './config-mirror.js'
import { ExportEngine } from './export-engine.js'
import { type ExportJanitorDeps, markDownloaded, sweepExpiredExports } from './export-janitor.js'
import { reconcileInterruptedExports } from './export-reconcile.js'
import { shrinkExportToBound } from './export-shrink-for-read.js'
import { writeExportSourcePlaylist } from './export-source-playlist.js'
import {
  ARTIFACTS_MEDIA_LOCATION,
  exportOutPathFor,
  getExportRecord,
  type RecordingExportsState,
  recordingExportsState,
} from './export-store.js'
import { recorderRecordKinds } from './record-kinds.js'
import { renderClip, renderGif } from './footage-render.js'
import { GhostLocationSweeper } from './ghost-location-sweep.js'
import { runAdoptionCatchUp } from './hour-adoption-catchup.js'
import { HourAdoptionSweeper } from './hour-adoption-sweep.js'
import { LedgerWalkReconciler } from './ledger-walk-reconcile.js'
import { type LocationCapacity, readLocationCapacity } from './location-capacity.js'
import { LocationRefresher } from './location-refresh.js'
import {
  createRecordingOpsLogSink,
  type RecordingOpsLogSink,
  type RecordingOpsLogState,
  recordingOpsLogState,
} from './ops-log-store.js'
import { pendingMovesSignature, pendingWriterMoves } from './pending-writer-moves.js'
import { type PeriodicPassHandle, startPeriodicPass } from './periodic-pass.js'
import { PlacementAlertPublisher, WriterRestartAlerts } from './placement-alerts.js'
import { demoteWritableAliasConflicts } from './placement-guard.js'
import {
  type PlacementAlert,
  PlacementService,
  type PlacementWorkItem,
} from './placement-service.js'
import {
  EMPTY_PLACEMENT,
  RECORDING_PLACEMENT_KEY,
  RecordingPlacementBlobSchema,
  type RecordingPlacementState,
  readPlacementState,
  replaceAssignments,
} from './placement-store.js'
import { readLocationMarker } from './placement-volume.js'
import { DEFAULT_SEGMENT_SECONDS } from './recorder-defaults.js'
import {
  brokerScope,
  makeBrokerCall,
  RecordingController,
  STAGING_DIR_NAME,
  type ReapedDirectoryRecovery,
  type ReapedDirectoryReport,
} from './recording-controller.js'
import { buildRecordingExportProvider } from './recording-export-provider.js'
import { resolveRecordingHubHostname } from './recording-hub-host.js'
import {
  buildRecordingProvider,
  type PlacementSnapshot,
  type RecordingProviderDeps,
} from './recording-provider.js'
import { createRecorderRemovalHook } from './device-removal.js'
import { buildRecordingSourceProvider } from './recording-source-provider.js'
import { RedundancySweeper } from './redundancy-sweep.js'
import { RetentionSweeper } from './retention-sweep.js'
import {
  hourDirRelPath,
  hydrateDeviceFromStorage,
  hydrateWindowFromStorage,
  locationMayBeRead,
  type RecordingsLocation,
  resolvePlacement,
  resolveRecordingsLocations,
} from './roots.js'
import { HeapDeltaProbe } from './heap-delta.js'
import { createProcessLister, nodeProcessSignaller } from './process-table.js'
import { SegmentHourLedger } from './segment-hour-ledger.js'
import { type StagingWriterGuard, StagingWriterReaper } from './staging-writer-guard.js'
import { runStagingBoot } from './staging-boot.js'
import {
  nodeStagingIo,
  recoverAllStagedOrphans,
  recoverStagingOrphans,
} from './staging-reconcile.js'
import { StoreReadCensus } from './store/read-census.js'
import { createRecorderVideoclipsProvider } from './videoclips-wiring.js'

/** Default designated recording node (`recordingNodeId` global setting). The
 *  stream-broker is hub-only and recording is a single-node global function, so
 *  the hub is the safe default — mirrors pipeline-analytics' post-processing
 *  node gate. */
const RECORDING_NODE_DEFAULT = 'hub'

/** Recorder-v2 addon-level config. */
interface RecorderV2Config {
  /** Segment length in seconds (consumed by the SegmentWriter). */
  readonly segmentSeconds: number
  /** How often the segment watcher polls `live.m3u8` (ms). */
  readonly watchIntervalMs: number
  /** SHARED cluster key (NOT perNode): which node runs recording. Empty ⇒ hub. */
  readonly recordingNodeId: string
  /** SHARED cluster key: hub host a remote recording node dials. Empty ⇒ auto-derive. */
  readonly recordingHubHostname: string
}

const DEFAULT_CONFIG: RecorderV2Config = {
  segmentSeconds: DEFAULT_SEGMENT_SECONDS,
  watchIntervalMs: 2_000,
  recordingNodeId: RECORDING_NODE_DEFAULT,
  recordingHubHostname: '',
}

/** This addon's manifest id + the playback data-plane prefix — together they
 *  form the hub reverse-proxy client path `/addon/recorder/playback`. */
/**
 * Row cap for one device's trigger reconcile query.
 *
 * The window asked for is `postBufferSec + TRIGGER_HISTORY_MARGIN_MS` (165 s at
 * the shipped defaults) and the rows all merge into a handful of windows, so
 * this bounds a pathological detector — not normal traffic. Well under the
 * cap's own `MAX_EVENT_QUERY_LIMIT`, because a truncated answer here loses the
 * OLDEST rows, which are the ones carrying an episode's start edge.
 */
const TRIGGER_RECONCILE_ROW_LIMIT = 2000

const RECORDER_ADDON_ID = 'recorder'
const PLAYBACK_PREFIX = 'playback'
/** Data-plane prefix for on-demand single stills →
 *  `/addon/recorder/still/<deviceId>/<epochSec>`. */
const STILL_PREFIX = 'still'

/**
 * Bound on pending hour-ledger writes (one per finalized segment, an RPC to
 * the hub store). Steady state completes in milliseconds and holds ~0–2; under
 * a store stall the fleet-wide finalize rate (~3.4/s) fills 256 in ~75s of
 * grace before refusals begin. Each pending write holds one hour-row copy
 * (≤360 paths ≈ ~25KB), so the lane's worst-case heap is single-digit MB —
 * a dropped write is one silent re-seed from the archive walk (D148).
 */
const LEDGER_GATE_LIMIT = 256

/**
 * Bound on pending mfra tail reads (one per finalized RECENT segment; each is
 * an open + two reads on the same 4-thread libuv pool the live writers use,
 * holding read buffers while pending). 64 bounds both the held memory and the
 * pool contention; a dropped capture costs that segment's client one extra
 * round trip to the file's tail on the first seek.
 */
const MFRA_GATE_LIMIT = 64
/** Data-plane prefix for export MP4 downloads → `/addon/recorder/exports/<id>.mp4`. */
const EXPORTS_PREFIX = 'exports'
/** How often the export janitor sweeps expired exports. */
const EXPORT_SWEEP_INTERVAL_MS = 5 * 60_000
/**
 * The staging plan keeps anything named within 1 s before its cutoff for the
 * live writer (`PREVIOUS_RUN_SKEW_MS`). A reaped directory has no live writer
 * yet, so the cutoff is moved forward by exactly that much: everything the
 * reaped writer named up to the reap is collected.
 */
const REAPED_RECOVERY_SKEW_MS = 1_000
/** How often the retention sweep prunes footage past each camera's per-device
 *  age/size policy. Retention is NOT time-critical (footage ages out over days,
 *  and the disk-pressure eviction path already bounds the worst case), so an
 *  hourly cadence keeps the storage.list/evict cost negligible while honouring
 *  the recording-spec §6 periodic retention. */
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000
/** How often the redundancy sweep removes footage a writer restart duplicated. */
const REDUNDANCY_SWEEP_INTERVAL_MS = 60 * 60_000
/**
 * How far back each redundancy pass looks.
 *
 * Twice the interval, so a pass that is skipped (single-flight) or delayed by a
 * slow predecessor still covers the window its predecessor was supposed to.
 * It is deliberately NOT "the whole archive": duplicates are made by a writer
 * restart, restarts are recent, and a full-archive selection is the ~560 MB
 * transient copy D248 removed. See `redundancy-sweep.ts`.
 */
const REDUNDANCY_SWEEP_LOOKBACK_MS = 2 * REDUNDANCY_SWEEP_INTERVAL_MS
/**
 * How often the ghost-location reconcile runs — DAILY, and deliberately the
 * slowest sweep in this addon.
 *
 * Measured against the three that already exist. The export janitor is 5 min
 * because an expiry an operator can see must not linger. Retention and
 * redundancy are hourly because both clean something that ACCRUES hourly —
 * footage ages continuously, and a writer restart duplicates ~10 s of media
 * every time it happens — so a missed pass compounds into disk pressure, and
 * redundancy's lookback is sized at twice its own interval for exactly that
 * reason.
 *
 * A ghost hour row accrues from nothing periodic. It appears only when a
 * storage location record disappears out from under the ledger, which since
 * D293 requires an operator to `force` past a refusal — an event measured in
 * months. Meanwhile the pass costs `storage.exists` syscalls on the saturated
 * recordings array, which is the resource every live read is competing for. An
 * hourly cadence would spend that budget ~8 700 times a year to answer "nothing
 * to do". Daily, bounded per pass, converges the live 32-row backlog in two
 * passes and is invisible the rest of the time.
 *
 * It also does NOT run at boot: `startPeriodicPass` fires on the interval only,
 * and boot is when the staging reconcile, the ledger load and the first
 * retention sweep are already contending for the same array.
 */
const GHOST_LOCATION_SWEEP_INTERVAL_MS = 24 * 60 * 60_000
/** A ghost pass longer than this is reported with its duration. Bounded work
 *  (16 hours, 4 000 probes) on a slow array — minutes is normal, an hour is
 *  not. */
const GHOST_LOCATION_SWEEP_SLOW_AFTER_MS = 10 * 60_000
/** Awaited every `GHOST_PROBE_BATCH` probes. The janitor's brake: it keeps a
 *  reconcile pass off the array's critical path rather than racing it. */
const GHOST_LOCATION_PROBE_PAUSE_MS = 50
/**
 * Awaited every `WALK_HOUR_BATCH` hour listings by the ledger↔disk walk (D319).
 *
 * Twice the ghost sweep's brake. That used to be because the syscall between
 * brakes was far heavier — the sweep paced one `storage.exists`, this one an
 * hour `readdir` "measured at ~650 ms on the live share under load". Both
 * halves of that have changed: the sweep paces a directory listing too since
 * D523, and the 650 ms belonged to a FUSE mount that has been retired (an hour
 * of 345–349 files on `/recordings-2` lists in ~1 ms).
 *
 * It stays at twice anyway, for the reason that never depended on the number:
 * the walk is operator-armed and one-off, so the right trade is to be slower
 * and invisible rather than fast and felt — a `find` over this array hung an
 * SSH session on 2026-08-29.
 */
const LEDGER_WALK_PAUSE_MS = 100
/**
 * How often the ADD-only hour adoption pass runs (D521).
 *
 * Daily, for the same reason the ghost sweep is daily: it spends `readdir`
 * syscalls on the array every live read competes for, and the damage it repairs
 * is made by a writer teardown — an event measured in days, not minutes. It
 * does NOT run at boot (`startPeriodicPass` fires on the interval only), which
 * is when the staging reconcile, the ledger load and the first retention sweep
 * are already contending for that array.
 */
const HOUR_ADOPTION_INTERVAL_MS = 24 * 60 * 60_000
/**
 * How long after boot the first adoption pass runs.
 *
 * Long enough that it is not competing with everything else a starting recorder
 * does (locations resolving, writers attaching, the ledger warming), short
 * enough that a hub restarted twice in an evening still repairs its archive.
 */
const HOUR_ADOPTION_FIRST_RUN_DELAY_MS = 3 * 60_000
/**
 * How long one adoption run may keep sweeping bounded locations.
 *
 * Long enough to make real progress on a damaged archive (the first pass here
 * moved ~29 k segments in about twenty seconds of listings), short enough that
 * the array is not being walked continuously — every listing is a `readdir` on
 * a spinning disk shared with live writers.
 */
const HOUR_ADOPTION_CATCHUP_BUDGET_MS = 10 * 60_000
/**
 * How long the recorder waits before resuming an adoption run that stopped on
 * its budget. Enough of a gap that the array is not walked back-to-back;
 * nothing like a day.
 */
const HOUR_ADOPTION_RESUME_MS = 5 * 60_000
/** An adoption pass longer than this is reported with its duration. Bounded
 *  work (512 hour listings, paced) — minutes is normal, an hour is not. */
const HOUR_ADOPTION_SLOW_AFTER_MS = 10 * 60_000
/** What the per-volume usage row reports when the hour ledger is unavailable:
 *  nothing measured, rather than a total counted off a partial RAM index. */
const EMPTY_ARCHIVE_ACCOUNTING: Accounting = {
  bytes: 0,
  count: 0,
  oldestMs: null,
  newestMs: null,
}
/** Grace after a completed download before a `deleteAfterDownload` file is removed. */
const EXPORT_DELETE_GRACE_MS = 60_000
/** Only `.mp4` export ids matching this shape are servable (traversal guard). */
const EXPORT_FILENAME_RE = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.mp4$/

/** Floor on the span a measured byte RATE may be extrapolated from: a camera
 *  five minutes old would otherwise report an absurd daily rate. */
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** Narrows the `unknown` extras `SegmentStore`'s logger contract accepts down
 *  to the structured `{ tags, error }` shape the device-scoped call sites
 *  (stat/relocate failures) pass — as opposed to the raw caught error most
 *  other call sites still pass directly. */
function isSegmentStoreLogExtras(extras: unknown): extras is SegmentStoreLogExtras {
  return typeof extras === 'object' && extras !== null && ('tags' in extras || 'error' in extras)
}

export default class RecorderV2Addon extends BaseAddon<RecorderV2Config> {
  private nodeId = 'hub'
  /**
   * The children this addon started, claimed at the spawn site and released at
   * their exit. It is what `load-contribution` reports: the recorder knows it
   * ran an ffmpeg for camera 101 profile `high`, so nobody else has to work it
   * out from a process table.
   *
   * One registry per PROCESS, and it dies with the process — which is correct,
   * because those children were this process's children.
   */
  private readonly costRegistry = new ChildCostRegistry()
  /**
   * This node's PINNED ffmpeg (D540), asked once and shared by every child the
   * recorder spawns: segment writers, exports, gif/clip renders and stills.
   * Each of those used to take an optional path that no one passed, and fell
   * back to a bare `'ffmpeg'` — the HOST's binary. It rejects rather than
   * naming PATH; each site logs its refusal per camera.
   */
  private readonly pinnedFfmpeg = memoizePinnedFfmpeg(() => this.ctx.deps.ensureFfmpeg())
  /** True when THIS node is the designated recording node (`recordingNodeId`).
   *  Every other node stays fully inert — registers no providers, serves no
   *  playback, runs no controller. Resolved in `onInitialize`. */
  private isRecordingNode = true

  /**
   * Resolved root of the shared `artifacts` storage location — the export
   * MP4s' home and the GIF/clip render scratch. `null` until `onHubReachable`
   * resolves it (and forever if the location is unreachable): every consumer
   * then REFUSES with a named error instead of falling back to the addon data
   * dir (D341).
   */
  private exportsRoot: string | null = null
  private readonly index = new RecordingIndex()
  /**
   * Stops the GC-attributing stall monitor armed in {@link onInitialize}.
   *
   * REUSED, never re-implemented. It used to live next door in this bundle;
   * on 2026-09-09 it moved to `@camstack/system/addon-utils` (the subpath, never
   * the barrel — that one drags the kernel into the runner) because two more
   * processes that do NOT share this bundle needed it — `pipeline-analytics` and
   * hub-main — and a per-bundle copy is how two diagnostics end up disagreeing
   * about the same freeze. The cost of the move is a slower ship chain: this
   * import is host-resolved, so a `camstack deploy` of this addon onto a hub
   * whose server closure predates the export fails to load. Deploy order is
   * closure first, addons second. See D417.
   */
  private stopStallMonitor: (() => void) | null = null
  /**
   * Durable hour-directory copy of {@link index}. Null on an inert
   * (non-recording) node. Boot reseeds the RAM index from this; the
   * deferred archive walk reconciles it against disk.
   */
  private segmentHours: SegmentHourLedger | null = null
  /** Frozen-location leftover wipe (`low/` or `high/`+`mid/`). Detached. */
  private footageDiscard: FootageDiscardJob | null = null
  /** Why the last placement pass planned nothing — latched so the line is one
   *  per episode, not one per 30 s tick. `null` ⇒ the last pass had work. */
  private placementWorkGap: string | null = null
  /**
   * When the recorder re-resolves its storage locations (D387): coalesced off
   * the `StorageLocationsChanged` doorbell, and converged on the placement
   * pass's own timer whether or not that doorbell ever arrives. Built on the
   * recording node only, with the rest of the write path.
   */
  private locationRefresher: LocationRefresher | null = null
  /** Unsubscribe handle for the `StorageLocationsChanged` subscription. */
  private locationChangeUnsub: (() => void) | null = null
  /**
   * How many live writers are recording somewhere other than their planned
   * location, latched so the line is one per episode rather than one per 30 s
   * tick. `null` ⇒ nothing pending (or nothing measured yet).
   */
  private pendingWriterMoves: string | null = null
  /**
   * The calendar rungs — which days, which hours, and a day's exact ranges.
   *
   * Hours the RAM index has already walked (or the live hour it is
   * write-through on) never touch the recordings volume. Directory reads
   * remain only for hours still `unknown` — that FUSE readdir is what queued
   * behind scrub's `locateSegment` and expired its 8 s budget (2026-08-22).
   */
  private calendarInstance: CalendarIndex | null = null

  private heapProbeInstance: HeapDeltaProbe | null = null
  /**
   * Names the pass, boot phase or inbound cap method that grows the heap.
   * Every recorder lifetime builds ~2.3 GB in one silent phase 3–5 min after
   * boot and nothing has ever said which unit of work does it (see
   * `heap-delta.ts`). LAZY for the same reason as {@link calendar}.
   */
  private get heapProbe(): HeapDeltaProbe {
    this.heapProbeInstance ??= new HeapDeltaProbe({ logger: this.ctx.logger })
    return this.heapProbeInstance
  }

  /** LAZY: a field initialiser runs before `initialize()` assigns `ctx`, and
   *  reading `this.ctx` there throws — the same trap that bit the playback tier. */
  private get calendar(): CalendarIndex {
    // The floor is the durable hour ledger's (D674): a walk never visits an
    // hour below the camera's oldest archived one. `segmentHours` is read
    // lazily — it is built later in boot and may be dropped if its declare
    // fails, and then no floor is known and the walk cap alone bounds a call.
    this.calendarInstance ??= this.buildCalendar()
    return this.calendarInstance
  }

  private buildCalendar(): CalendarIndex {
    const floors = new ArchiveFloorReader(() => this.segmentHours)
    return new CalendarIndex({
      roots: () => this.resolvedLocations.map((l) => l.root),
      logger: this.ctx.logger,
      indexHour: (deviceId, profile, hourStartMs) =>
        hourSegmentsFromIndex(this.index, deviceId, profile, hourStartMs),
      archiveFloor: (deviceId) => floors.floorOf(deviceId),
    })
  }

  private segmentStore: SegmentStore | null = null
  /** Sync-sample tables captured at finalize, served by the directory so a
   *  playback seek needs no mfra tail fetch. RAM-only, TTL-bounded. */
  private readonly mfraTables = new MfraTableStore()
  /** Bound on the per-finalize fire-and-forget lanes (item 3, 2026-08-18): a
   *  disk/store stall must throttle this work, never balloon live heap — the
   *  unbounded pending set is what fed the two `Ineffective mark-compacts`
   *  fatals. Saturation is reported loudly but throttled; every individual
   *  drop is logged with its deviceId at the call site. */
  private readonly ledgerWriteGate = new PendingGate({
    label: 'hour-ledger',
    limit: LEDGER_GATE_LIMIT,
    onSaturated: (report: PendingGateReport) => {
      this.reportGateSaturated(report)
    },
  })
  private readonly mfraCaptureGate = new PendingGate({
    label: 'mfra-capture',
    limit: MFRA_GATE_LIMIT,
    onSaturated: (report: PendingGateReport) => {
      this.reportGateSaturated(report)
    },
  })
  /** Continuous + events band write-path controller (ffmpeg writers + watchers). */
  private controller: RecordingController | null = null

  /**
   * The controller's config read — this addon's mirror of the rows it owns
   * (`config-mirror.ts`, D466), with the last-known-good fallback.
   *
   * Built ONCE and memoized, because the map lives INSIDE it: rebuilding it per
   * call would throw away both the freshness the trigger path is served from
   * and the last value a failed read falls back to. Lazy rather than a field
   * initializer — a field initializer runs before the constructor assigns
   * `this.ctx`, so `this.ctx.logger` would be `undefined` at that point.
   */
  private mirroredConfigRead: RecordingConfigMirror | null = null

  private get configMirror(): RecordingConfigMirror {
    this.mirroredConfigRead ??= createRecordingConfigMirror({
      load: (deviceId: number) => loadDeviceConfig(this.configStore(), deviceId),
      logger: this.ctx.logger,
    })
    return this.mirroredConfigRead
  }
  /** Unsubscribe handle for the EventCapture motion subscription. */
  private eventUnsub: (() => void) | null = null
  /**
   * Unsubscribe handle for the `PipelineAudioInferenceResult` audio-level
   * subscription — the feed `audioThresholdDbfs` was missing (D62, Track 0
   * of `docs/design/plans/2026-08-26-detection-triggers-and-sensors.md`). Kept
   * separate from `eventUnsub` (a distinct bus category) but guarded and torn
   * down the same way, idempotent re-entry included.
   */
  private audioTriggerUnsub: (() => void) | null = null
  /**
   * Unsubscribe handle for the `PipelineAnalyticsDetectionEvent` subscription —
   * the feed behind `RecordingTriggers.objectClasses` (Track A of the same
   * plan). Same guard/teardown discipline as the two above.
   */
  private detectionTriggerUnsub: (() => void) | null = null
  /**
   * Per-window, per-camera tally behind the detection-trigger subscription. A
   * per-event `debug` line cannot say "NOTHING qualifies any more", which is the
   * regime this feed sat in — 100% rejected at 3.3–3.9/s — from the day it was
   * wired until 2026-08-29. This is what turns that into one `warn` a minute
   * naming the camera and the dominant reason.
   */
  private readonly detectionTriggerHealth = new ObjectTriggerHealth()
  /**
   * Unsubscribe handle for the `DeviceStateChanged` subscription — the feed
   * behind `RecordingTriggers.sensorDeviceIds` (Track B).
   */
  private sensorTriggerUnsub: (() => void) | null = null
  /**
   * Unsubscribe handle for the `DeviceStateChanged` subscription filtered on
   * the camera's own `recording-signal` slice — the feed behind
   * `RecordingTriggers.deviceSignal`. A LEVEL, so it has no edge memory of its
   * own: the controller holds and releases (`onSignalLevel`).
   */
  private signalTriggerUnsub: (() => void) | null = null
  /**
   * Edge memory + reverse index (source device → cameras) for the sensor
   * trigger. Constructed once per addon instance: `startedAtMs` is the floor a
   * first-sighting rise must beat, and a fresh instance per boot is exactly
   * what makes a runner respawn err towards silence rather than record 30 s
   * per camera on every hydrated contact.
   */
  private readonly sensorRouter = new SensorTriggerRouter({
    now: () => Date.now(),
    startedAtMs: Date.now(),
  })
  /** Resolved recordings locations (id + root). Refreshed on boot + rescan.
   *  Already ALIAS-GUARDED: a writable same-type duplicate of another
   *  location's physical root arrives here demoted to read-only. */
  private resolvedLocations: readonly RecordingsLocation[] = []
  /** The `device-removal-hook` provider (D865); its reconcile is armed in `onHubReachable`. */
  private removalHook: IDeviceRemovalHookProvider | null = null
  /** Attach-boundary placement (assignment + mount probe + audit). Null on
   *  non-recording nodes / before `onInitialize`. */
  private placement: PlacementService | null = null
  /** Base URL of the playback HTTP data-plane, null until served in onHubReachable. */
  private playbackBaseUrl: string | null = null
  /** On-demand single-still decode service (export-dialog frame previews). Null
   *  on non-recording nodes / when the data-plane serve fails. */
  /** Render engine for recording exports. Null on non-recording nodes. */
  private exportEngine: ExportEngine | null = null
  /** Periodic export-expiry sweep timer. Cleared on shutdown. */
  private exportSweepTimer: NodeJS.Timeout | null = null
  /** The `recording` cap provider — retained so the periodic retention sweep can
   *  call its `pruneFootage`. Null until built in `onInitialize`. */
  private recordingProvider: IRecordingArchiveProvider | null = null
  /** One writer per staging directory (D667). `null` where the platform has
   *  no process table (Windows) — said once at startup. */
  private stagingGuard: StagingWriterGuard | null = null
  /** Periodic footage-retention sweep (owns its timer + single-flight guard).
   *  Constructed + started in `onHubReachable`, stopped on shutdown. */
  private retentionSweeper: RetentionSweeper | null = null
  /** Periodic duplicate-footage sweep — the ONLY pruner of media a writer
   *  restart re-wrote. Constructed + started in `onHubReachable`. */
  private redundancySweeper: RedundancySweeper | null = null
  /** Daily ghost-location reconcile: durable hour rows stamped with a location
   *  the storage record no longer has. Armed in `onHubReachable`. */
  private ghostLocationPass: PeriodicPassHandle | null = null
  private hourAdoptionPass: PeriodicPassHandle | null = null
  private hourAdoptionResume: ReturnType<typeof setTimeout> | undefined
  /** Reversible migration pause lease; never reflected in RecordingConfig. */
  private storageMigrationLeaseId: string | null = null

  /**
   * Call-site attribution for `recorder:recording-configs` / `-exports` /
   * `-ops-log` row reads (`store/read-census.ts`).
   *
   * Disarmed by default; armed for a bounded window through
   * `debug.storeCensus`. It exists because the live-hub profiler names a
   * TABLE — `get recorder:recording-configs` ran 581-892 calls/min on
   * 2026-08-26, finding a row only ~56% of the time — and cannot say WHICH of
   * `loadDeviceConfig`'s several cap-handler call sites (`getStatus`,
   * `getDeviceConfig`, `rescanStorage`, `pruneFootage`) is issuing them.
   * Picking the reader that LOOKS like a loop has cost this repo half a day
   * twice, wrong both times — this measures instead.
   */
  private readonly readCensus = new StoreReadCensus()
  /** Memoised so every `configStore()` / `exportsStore()` / `opsLogStore()`
   *  call shares ONE census instead of each wrapping the raw client afresh. */

  constructor() {
    super({ ...DEFAULT_CONFIG })
  }

  /**
   * One throttled line per saturated lane per report interval. Lane-level (no
   * deviceId — the lane aggregates every camera); the per-drop debug lines at
   * the call sites carry the tag. WARN because a saturated lane means the
   * store or the disk is stalling under live finalize load — the line that
   * explains the missing ledger hours and mfra misses an operator will see.
   */
  private reportGateSaturated(report: PendingGateReport): void {
    this.ctx.logger.warn('recorder: fire-and-forget lane saturated — dropping over the bound', {
      meta: {
        lane: report.label,
        dropped: report.dropped,
        pending: report.pending,
      },
    })
  }

  protected async onInitialize(): Promise<
    AddonInitResult<RecorderDebugActions & LocationDiscardActions>
  > {
    // This process's `loopMax` rises 0 → 242 → 898 → 2627 ms in lockstep with
    // its own `heapUsed` and plateaus with it, while every periodic pass ran at
    // its final cadence from minute one — so the stall is ALMOST CERTAINLY GC.
    // From outside a process, GC and a synchronous block are indistinguishable,
    // and "almost certainly" is how the last three inferences about this heap
    // went wrong. The monitor says which, and how long, and for which
    // collection.
    //
    // Armed BEFORE the recording-node gate below: an inert recorder that stalls
    // is itself a finding, and the cost is one unref'd 1s timer plus a `gc`
    // PerformanceObserver on a process that is otherwise silent.
    this.stopStallMonitor = startEventLoopStallMonitor(this.ctx.logger)

    // The RAM index is BOUNDED from here on, and says what it drops. Armed
    // before the recording-node gate below for the same reason as the monitor:
    // an index is a field initializer and cannot see `ctx.logger`, and an
    // unarmed index is an index that cannot evict. What the bound is, and the
    // measurement behind it, are in `RecordingIndexBudget`.
    this.index.armResidency({
      logger: this.ctx.logger,
      now: () => Date.now(),
      budget: DEFAULT_RECORDING_INDEX_BUDGET,
    })
    const raw = this.ctx.kernel.localNodeId ?? this.ctx.id
    this.nodeId = raw.includes('/') ? raw.split('/')[0]! : raw

    // ── Cluster recording-node gate ─────────────────────────────────────────
    // A SINGLE designated node (default hub) records; every other node stays
    // fully inert — registers no providers, serves no playback, runs no
    // controller. Mirrors pipeline-analytics' `postProcessingNodeId` gate. The
    // `recording` cap is a singleton, so registering it only on the designated
    // node keeps exactly one provider cluster-wide (on the node that owns the
    // files). Behaviour-preserving at the default (hub records, as today).
    // Both cluster keys are SHARED schema fields hydrated by resolveConfig()
    // before onInitialize runs — no raw store read (P3b settings migration).
    const configuredNode = this.config.recordingNodeId
    const designated = configuredNode.length > 0 ? configuredNode : RECORDING_NODE_DEFAULT
    this.isRecordingNode = this.nodeId === designated
    if (!this.isRecordingNode) {
      this.ctx.logger.info('recorder INERT on this node — recording assigned elsewhere', {
        meta: { ownNodeId: this.nodeId, designatedNode: designated },
      })
      return { providers: [] }
    }

    // Record kinds (D881, phase 2 steps 25–26) — declared FIRST, before any
    // store or controller that depends on them. Hub-only: the recorder defaults
    // to the hub as the recording node (`ctx.records` is undefined on agents).
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error(
        'recorder (recording node) needs ctx.records — recording node must be the hub',
      )
    }
    await records.declare(recorderRecordKinds)

    // The recorder's one remaining flattened RowMapStore map (`recording-configs`)
    // lives in its OWN collection since the 2026-08-19 flatten (D183). It MUST
    // be declared before the first read or write — the SQLite backend answers
    // 412 for an undeclared collection — and a failure here is deliberately NOT
    // swallowed: a recorder that cannot read `recorder:recording-configs` reads
    // every camera as unconfigured and records NOTHING. Crashing loudly is
    // bounded by `CrashSupervisor` (D6); recording nothing in silence is not.
    // (`recorder:exports` and `recorder:ops-log` are now record kinds declared
    // above, not RowMapStore collections.)
    await this.declareRowCollections()

    this.segmentHours = new SegmentHourLedger({
      store: this.ctx.api.settingsStore,
      logger: this.ctx.logger,
      // The ledger accounts for HOW MUCH an hour holds; the directory is the
      // authority for WHICH segments it holds (D523). This is the ledger's only
      // connection to the array, and it is lazy for the same reason
      // `isLocationUsable` is: `resolvedLocations` is populated later in boot.
      listHour: (locationId, deviceId, profile, hourStartMs) =>
        this.listHourDirectory(locationId, deviceId, profile, hourStartMs),
      // Lazy on purpose: `PlacementService` is built later in this boot (it
      // needs the ops-log sink), and the ledger only ever asks at reconcile
      // time. Absent placement ⇒ usable, which is what an un-probed location
      // honestly is.
      isLocationUsable: (locationId) => this.placement?.isLocationUsable(locationId) ?? true,
    })
    try {
      await this.segmentHours.declare()
    } catch (err: unknown) {
      // An undeclared collection 412s later writes; a failed declare here
      // must NOT take recording down. The RAM index + disk walk still work
      // — that is fail-toward-walk.
      this.ctx.logger.warn(
        'recorder: segment-hour ledger declare failed — index stays RAM-only this boot',
        {
          meta: { error: errMsg(err) },
        },
      )
      this.segmentHours = null
    }

    // The cluster's camera-source owner (`pipelineOrchestrator.getIngestOwner`)
    // — every `stream-broker` call the controller makes is pinned to
    // `ingestOwner.ownerNodeId`. Graceful degrade: the cap may not be mounted
    // yet (pre-image-release), in which case we fall back to `'hub'` — the
    // same default the old hardcoded `BROKER_HOST_NODE_ID` used, so an
    // unresolved owner is byte-identical to today's hub-only behaviour.
    const ingestOwner = await this.resolveIngestOwner()

    // Cross-node pull host: the stream-broker only ever runs on the ingest
    // owner and mints `127.0.0.1` restream URLs there. When THIS node is the
    // designated recorder but is NOT the owner (an agent), pull from the
    // owner's LAN-reachable host — `reachableHost` (from `getIngestOwner`)
    // wins; the operator override / `CAMSTACK_HUB_URL`-derived hub host is
    // the fallback. On the owner node itself, `undefined` keeps the correct
    // local default.
    const consumerHostname =
      this.nodeId === ingestOwner.ownerNodeId
        ? undefined
        : (ingestOwner.reachableHost ??
          resolveRecordingHubHostname(
            this.config.recordingHubHostname,
            process.env['CAMSTACK_HUB_URL'],
          ))
    if (this.nodeId !== ingestOwner.ownerNodeId) {
      this.ctx.logger.info(
        'recorder is a REMOTE recording node — pulling broker streams cross-node',
        {
          meta: {
            ownNodeId: this.nodeId,
            brokerHost: ingestOwner.ownerNodeId,
            consumerHostname: consumerHostname ?? '(unresolved)',
          },
        },
      )
      if (consumerHostname === undefined) {
        this.ctx.logger.warn(
          'recorder: could not resolve the ingest owner host for cross-node pull — set the `recordingHubHostname` global setting or CAMSTACK_HUB_URL; recording will not reach this node',
          {
            meta: { ownNodeId: this.nodeId },
          },
        )
      }
    }

    // SegmentStore wires the v2 core to real I/O: `list`/`deletePath` route
    // through the `storage` cap (location-aware, multi-disk); `statBytes`/
    // `moveFile` are node fs operations on the resolved absolute paths.
    const segmentStoreDeps: SegmentStoreDeps = {
      index: this.index,
      list: (input) => this.ctx.api.storage.list.query(input),
      deletePath: (input) => this.ctx.api.storage.delete.mutate(input),
      statBytes: async (absPath) => (await fs.stat(absPath)).size,
      removeStaged: (absPath) => fs.rm(absPath, { force: true }),
      moveFile: async (fromAbs, toAbs) => {
        await fs.mkdir(path.dirname(toAbs), { recursive: true })
        try {
          await fs.rename(fromAbs, toAbs)
        } catch (err: unknown) {
          // DEFENSIVE fallback only. Staging is per-location
          // (`<locationRoot>/.rec-tmp/...`, see RecordingController), so the
          // relocate is a same-fs rename by construction and EXDEV should never
          // fire. Kept for resilience (e.g. a location root that is itself a
          // bind-mount boundary) — a copy+unlink is 2x writes but never data loss.
          if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
          await fs.copyFile(fromAbs, toAbs)
          await fs.unlink(fromAbs)
        }
      },
      // Bucket-granular eviction (R4): one raw recursive rm on a fully-evicted
      // hour-bucket dir instead of a per-file storage.delete loop. Resolved
      // against the location root like moveFile/statBytes; `force` makes an
      // already-gone dir a no-op.
      // Whether that `rm -rf` is allowed is a question about the DIRECTORY —
      // "is every file in here a victim of this round?" — and since D523 it is
      // asked of the directory itself. It used to be asked of the hour ledger's
      // `paths` column; a row short by a torn writer's segments answered EQUAL
      // while the bucket held hundreds of files nobody had named, and the `rm`
      // took them. A listing that fails answers `null`, and the round falls
      // back to per-file deletes, which are slower and always correct.
      hourDirectoryPaths: (deviceId, profile, locationId, hourStartMs) =>
        this.listHourDirectory(locationId, deviceId, profile, hourStartMs),
      removeDir: async (locationId, relDir) => {
        const loc = requireReadableLocation(this.resolvedLocations, locationId, 'recorder')
        await fs.rm(path.join(loc.root, relDir), {
          recursive: true,
          force: true,
        })
      },
      // `rmdir`, never `rm -r`: it THROWS on a non-empty directory, and that
      // throw is the guard. Pruning an ancestor must never be able to take
      // footage with it.
      onEvicted: (deviceId: number, atMs: number) => {
        this.calendar.invalidate(deviceId, atMs)
      },
      onDeindexed: (rows) => {
        void this.segmentHours?.dropSegments(rows)
      },
      // Capture the segment's sync-sample table NOW, while the file is still in
      // page cache — the directory serves it so a playback seek needs no mfra
      // tail fetch. Fire-and-forget, but BOUNDED (item 3): both lanes run
      // through a PendingGate so a disk/store stall throttles this work
      // instead of accumulating unbounded pending promises at finalize rate.
      // A failed/dropped capture only costs that segment's client one extra
      // round trip. The hour ledger is write-behind on the same hook: losing
      // a persist costs one silent re-seed from the walk (D148).
      onIndexed: (row, absPath) => {
        const ledger = this.segmentHours
        if (ledger && !this.ledgerWriteGate.run(() => ledger.recordSegment(row))) {
          // The row is short by this path and only this process knows: the
          // hour must not be SEALED by it, so a reader walks it once (D451).
          ledger.markRefused(row)
          this.ctx.logger.debug(
            'recorder: hour-ledger write dropped — lane saturated; the hour stays unsealed and a reader walks it',
            { tags: { deviceId: row.deviceId }, meta: { path: row.path } },
          )
        }
        // A segment older than the serve window can never be answered from this
        // store, so reading it is pure cost — and a bulk staging recovery
        // finalizes tens of thousands of them at once, each an unawaited
        // `open` + 2 reads on the same 4-thread libuv pool the live writers'
        // finalize I/O uses. Ask the cheap question first (D54).
        if (!isMfraTableServable(row.startMs, Date.now())) return
        const admitted = this.mfraCaptureGate.run(async () => {
          try {
            const table = await readMfraTable(absPath, row.bytes)
            this.mfraTables.record(row.deviceId, row.profile, row.startMs, table)
          } catch (err: unknown) {
            this.ctx.logger.debug('mfra capture failed', {
              tags: { deviceId: row.deviceId },
              meta: { path: row.path, error: errMsg(err) },
            })
          }
        })
        if (!admitted) {
          this.ctx.logger.debug(
            'recorder: mfra capture dropped — lane saturated; first seek pays one tail fetch',
            { tags: { deviceId: row.deviceId }, meta: { path: row.path } },
          )
        }
      },
      removeDirIfEmpty: async (locationId, relDir) => {
        const loc = requireReadableLocation(this.resolvedLocations, locationId, 'recorder')
        await fs.rmdir(path.join(loc.root, relDir))
      },
      // SegmentStore's logger contract is `warn(message, extras?: unknown)` — most
      // call sites still pass a raw caught error. The device-scoped call sites
      // (stat/relocate failures) instead pass a `SegmentStoreLogExtras`-shaped
      // `{ tags, error }` object so the `deviceId` tag survives onto the scoped
      // logger's `LogExtras`; detect that shape and route it, otherwise fall
      // back to wrapping the raw value in `meta` as before.
      logger: {
        warn: (message: string, extras?: unknown) => {
          if (isSegmentStoreLogExtras(extras)) {
            this.ctx.logger.warn(message, {
              tags: extras.tags,
              meta: { error: extras.error },
            })
          } else {
            this.ctx.logger.warn(message, { meta: { extras } })
          }
        },
        info: (message: string, extras: SegmentStoreLogMeta) => {
          this.ctx.logger.info(message, { meta: extras.meta })
        },
        debug: (message: string, extras: SegmentStoreLogMeta & SegmentStoreLogExtras) => {
          this.ctx.logger.debug(message, { tags: extras.tags, meta: extras.meta })
        },
      },
    }
    this.segmentStore = new SegmentStore(segmentStoreDeps)

    // B2 controller: owns ffmpeg writers + watchers + broker leases per
    // (device, profile) and converges them against each device's active
    // continuous band. Broker calls are gated on the `stream-broker` handle's
    // readiness (no bespoke retry); boot restore re-evaluates every persisted
    // device on each broker `ready` transition.
    // Staging: the controller stages each profile's segments UNDER its
    // placement root (`<locationRoot>/.rec-tmp/<dev>/<profile>`), so the
    // rec-tmp→final relocate is always a same-fs rename regardless of where
    // the operator points the recordings locations. The old global
    // `CAMSTACK_MEDIA_ROOT`/dataDir `rec-tmp` staging root is gone — recording
    // never writes to the appData/cache disk and never EXDEV-copies (F1).
    // The stream-broker only ever runs on the ingest owner, so gate on (and
    // pull from) THAT node's broker — not this node's. On the owner node this
    // is identical to the old `brokerScope(this.nodeId)`; on a designated
    // agent it waits for the owner's broker readiness (cluster-aware
    // readiness registry).
    const brokerHandle = this.ctx.useCapability(
      'stream-broker',
      brokerScope(ingestOwner.ownerNodeId),
    )
    const opsLog: RecordingOpsLogSink = createRecordingOpsLogSink({
      state: this.opsLogStore(),
      nodeId: this.nodeId,
      now: () => Date.now(),
      newId: () => randomUUID(),
      logger: this.ctx.logger.child('ops-log'),
    })

    // The one seam that decides (and logs, audits and volume-checks) where a
    // (camera, profile) writes. Built BEFORE the controller so the controller
    // can take `place` as its attach-boundary resolver.
    this.placement = new PlacementService({
      logger: this.ctx.logger.child('placement'),
      locations: () => this.resolvedLocations,
      state: this.placementStore(),
      opsLog,
      alert: (input) => this.emitPlacementAlert(input),
      recovered: (locationId) => this.resolvePlacementAlert(locationId),
      capacityFor: (location) => this.locationCapacity(location.root),
      // One location's total, from the hour ledger's aggregate — the third
      // caller that used to answer it by walking every indexed row.
      usedOnLocation: async (locationId) =>
        (await this.segmentHours?.accountingForLocations(new Set([locationId])))?.bytes ?? 0,
      dailyBytesFor: (deviceId, profile) => this.dailyBytesFor(deviceId, profile),
    })

    // One writer per staging directory (D667). A predecessor runner that died
    // without a shutdown hook leaves its ffmpeg writers running; this is what
    // finds and reaps them before a new writer is spawned into the same
    // directory. No table on this platform = no guard, said once, here.
    const processLister = createProcessLister()
    if (processLister === null) {
      this.ctx.logger.warn(
        'recorder: no process table on this platform — orphaned writers cannot be detected; boot staging mutation is disabled',
        { meta: { platform: process.platform } },
      )
    }
    this.stagingGuard =
      processLister === null
        ? null
        : new StagingWriterReaper({
            lister: processLister,
            signaller: nodeProcessSignaller,
            logger: this.ctx.logger,
            selfPid: process.pid,
            sleep: (ms) => sleep(ms),
            now: () => Date.now(),
          })

    this.controller = new RecordingController({
      resolveFfmpeg: this.pinnedFfmpeg,
      ...(this.stagingGuard !== null ? { stagingGuard: this.stagingGuard } : {}),
      recoverStagingDirectory: (input) => this.recoverReapedDirectory(input),
      heapProbe: this.heapProbe,
      api: this.ctx.api,
      logger: this.ctx.logger,
      nodeId: this.nodeId,
      ownerNodeId: ingestOwner.ownerNodeId,
      segmentStore: this.segmentStore,
      // Built ONCE so the map outlives the calls. All six of the controller's
      // config reads go over the same UDS door to `hub/sqlite-settings`, and
      // three of them run at EVENT-BUS RATE — `get recorder:recording-configs`
      // measured 1 453-1 820 calls/min on the live hub, ~40 % of every settings
      // call the cluster made. This addon owns those rows, so the read is
      // served from its own mirror and an operator edit is written THROUGH it
      // (`onConfigSaved` below). When the door is frozen a failed read used to
      // become the SHIPPED DEFAULT post-buffer written to disk (57 times on
      // 2026-08-25); the last successful read is what a failure serves instead.
      // See `config-mirror.ts` (D466).
      loadConfig: this.configMirror.read,
      enabledDeviceIds: async () => [...(await readDeviceConfigs(this.configStore())).keys()],
      /**
       * The DURABLE half of the trigger path (D8/D11). `pipelineAnalytics` rows
       * are single-timestamp SQLite records — the same upstream motion signal
       * the bus carries, persisted rather than broadcast, so a dropped or
       * badly-delayed event cannot cost the keep gate an episode.
       *
       * `slim` because only `timestamp` is read: the full projection carries a
       * regions array per row and this runs per camera on every reconcile beat.
       */
      loadMotionEvents: async (deviceId, sinceMs, untilMs) => {
        const events = await this.ctx.api.pipelineAnalytics.getMotionEvents.query({
          deviceId,
          since: sinceMs,
          until: untilMs,
          limit: TRIGGER_RECONCILE_ROW_LIMIT,
          projection: 'slim',
        })
        return events.map((event) => event.timestamp)
      },
      /**
       * The DURABLE half of the OBJECT source. Same shape as `loadMotionEvents`
       * — SQLite rows instead of a broadcast, one call per macro class because
       * `TriggerState` keys per class and the store filters server-side.
       *
       * `projection: 'full'` and NOT `'slim'`, deliberately: `SLIM_OBJECT_COLUMNS`
       * (`addon-post-analysis/.../store/event-store.ts`) does not carry `source`,
       * and the filter below reads an absent `source` as `pipeline` — so a slim
       * read would fold ONBOARD rows, re-opening from SQL exactly the windows
       * `qualifyObjectTrigger` refuses on the live path. Two truths about one
       * detection, which is what this whole track exists to avoid. The extra
       * cost is bounded: only bands that actually list `objectClasses` reach
       * here, `classFilter` narrows to one class, and `limit` caps the rows.
       */
      loadObjectEvents: async (deviceId, macroClass, sinceMs, untilMs) => {
        const events = await this.ctx.api.pipelineAnalytics.getObjectEvents.query({
          deviceId,
          since: sinceMs,
          until: untilMs,
          classFilter: macroClass,
          limit: TRIGGER_RECONCILE_ROW_LIMIT,
        })
        return events
          .filter((event) => (event.source ?? 'pipeline') === 'pipeline')
          .map((event) => event.timestamp)
      },
      /**
       * The DURABLE half of the DEVICE-SIGNAL source: the camera's own
       * `recording-signal` slice, read back through the kernel's state door.
       * `null` when the device has never written it; a slice that does not
       * parse is a REJECTION, not a level — the reconcile must not read
       * garbage as "down" and release on it.
       */
      loadDeviceSignal: async (deviceId) => {
        const slice = await this.ctx.api.deviceState.getCapSlice.query({
          deviceId,
          capName: recordingSignalCapability.name,
        })
        if (slice === null) return null
        const parsed = RecordingSignalStatusSchema.safeParse(slice)
        if (!parsed.success) {
          throw new Error(`recording-signal slice for device ${deviceId} does not parse`)
        }
        return { active: parsed.data.active, lastChangedAt: parsed.data.lastChangedAt }
      },
      locations: () => this.resolvedLocations,
      placeProfile: (deviceId, profile) => this.placeProfile(deviceId, profile),
      onPlacementTick: (deviceIds) => this.recomputePlacement(deviceIds),
      // A writer that stopped GRACEFULLY has handed the ledger its last
      // finalize: seal the hour it was on, one write (D451). A writer that
      // died leaves it unsealed, which is the honest answer.
      onWriterClosed: async (deviceId, profile) => {
        await this.segmentHours?.sealWriter(deviceId, profile)
      },
      // The watcher rolled past entries it never handled: those hours are
      // SHORT in the durable row and nothing else will ever notice (D521).
      // A span the watcher could not derive is reported as such — an hour
      // guessed wrong is an hour left sealed, so it is named and not invented.
      onSegmentsMissed: (missed, profile) => {
        const ledger = this.segmentHours
        if (ledger === null) return
        if (missed.fromMs === null || missed.toMs === null) {
          this.ctx.logger.warn(
            'recorder: segments were missed but the playlist named no span — NO hour could be held unsealed for them',
            {
              tags: { deviceId: missed.deviceId },
              meta: { profile, segments: missed.count },
            },
          )
          return
        }
        ledger.markHoursRefused({
          deviceId: missed.deviceId,
          profile,
          fromMs: missed.fromMs,
          toMs: missed.toMs,
          count: missed.count,
        })
      },
      emitRecordingHealth: (category, data) => {
        this.emitExportEvent(category, data)
      },
      spawn: childProcessSpawn,
      costRegistry: this.costRegistry,
      segmentSeconds: this.config.segmentSeconds,
      watchIntervalMs: this.config.watchIntervalMs,
      ...(consumerHostname !== undefined ? { consumerHostname } : {}),
      onBrokerReady: (handler) =>
        this.ctx.onCapabilityStateChange(
          'stream-broker',
          brokerScope(ingestOwner.ownerNodeId),
          (state) => {
            if (state === 'ready') handler()
          },
        ),
      brokerCall: makeBrokerCall(brokerHandle),
      // The registry's own answer, read without blocking: an attach against a
      // cold broker is abandoned before it spends a readiness gate + an RPC
      // bound per profile, and rides the ready transition above instead.
      brokerReady: () => brokerHandle.isReady,
    })

    const relocateEngine = new RelocateEngine({
      index: this.index,
      locations: () => this.resolvedLocations,
      // The DURABLE half of the re-point. Read through a thunk, not captured:
      // the ledger is null until `declare()` succeeds, and a mover that closed
      // over that null would silently stay RAM-only for the life of the runner.
      ledger: () => this.segmentHours,
      logger: this.ctx.logger.child('relocate'),
      now: () => Date.now(),
      newId: () => randomUUID(),
      onFinished: (job) => {
        // Durable audit row per terminal state; hours changed hands, so the
        // calendar caches for the touched device(s) must re-derive.
        void opsLog.append({
          op: 'relocate',
          reason: 'operator',
          deviceId: job.deviceId,
          itemsAffected: job.filesMoved,
          bytesReclaimed: 0,
          detail: `${job.state}: ${job.fromLocationId} → ${job.toLocationId} (${job.bytesMoved} bytes${job.error ? `; ${job.error}` : ''})`,
        })
        this.calendar.invalidateAll()
      },
      onProgress: (job) => {
        this.ctx.logger.info('relocate progress', {
          meta: {
            jobId: job.jobId,
            filesMoved: job.filesMoved,
            filesTotal: job.filesTotal,
            bytesMoved: job.bytesMoved,
          },
        })
      },
    })
    const recordingDeps: RecordingProviderDeps = {
      index: this.index,
      segmentStore: this.segmentStore,
      nodeId: this.nodeId,
      logger: this.ctx.logger,
      configStore: this.configStore(),
      opsLog,
      relocate: relocateEngine,
      // The render scratch rides the exports class root (transient files,
      // self-cleaning) — a null root refuses the render, never lands bytes in
      // the addon data dir (D341).
      gifRender: (input) =>
        renderGif(
          {
            deps: recordingDeps,
            exportsDir: this.exportsDirOrThrow(),
            spawn: childProcessSpawn,
            resolveFfmpeg: this.pinnedFfmpeg,
          },
          input,
        ),
      clipRender: (input) =>
        renderClip(
          {
            deps: recordingDeps,
            exportsDir: this.exportsDirOrThrow(),
            spawn: childProcessSpawn,
            resolveFfmpeg: this.pinnedFfmpeg,
          },
          input,
        ),
      locations: () => this.resolvedLocations,
      refreshLocations: () => this.refreshLocations(),
      capacity: (root) => this.locationCapacity(root),
      archiveAccounting: (locationIds) =>
        this.segmentHours?.accountingForLocations(locationIds) ??
        Promise.resolve(EMPTY_ARCHIVE_ACCOUNTING),
      // The per-CAMERA half of the same question (D418). `null` — no ledger —
      // makes `getStorageUsage` refuse the table rather than answer it from the
      // resident index, which is what made 1.9 TB look like 60.5 GB.
      // …and `null` too while the ledger has not LOADED or no location has
      // resolved: the rows written since boot are not the archive, and the
      // retention floor is read from them (D674).
      archiveDeviceUsage: (locationIds) => archiveDeviceUsageOf(this.segmentHours, locationIds),
      archiveUsageComplete: (locationIds) => archiveUsageComplete(this.segmentHours, locationIds),
      // What EXISTS, as opposed to what `this.index` holds (D295). A thunk, not
      // a captured value: the ledger is null until `declare()` succeeds, and a
      // provider that closed over that null would refuse every retention prune
      // for the life of the runner.
      archive: () => this.segmentHours,
      ledgerWalk: this.ledgerWalkReconciler(),
      hydrateDevice: (deviceId, locations) =>
        hydrateDeviceFromStorage(this.ctx.api, this.index, deviceId, locations, this.ctx.logger),
      reconcileHourLedger: async (deviceId) => {
        await this.segmentHours?.reconcileFromIndex(this.index, [deviceId], Date.now())
      },
      calendar: this.calendar,
      mfraFor: (deviceId, profile, startMs) => this.mfraTables.get(deviceId, profile, startMs),
      hydrateWindow: (deviceId, fromMs, toMs, verifyClosedHours) =>
        hydrateWindowFromStorage(
          this.index,
          deviceId,
          fromMs,
          toMs,
          this.resolvedLocations,
          this.ctx.logger,
          this.segmentHours ?? undefined,
          { verifyClosedHours: verifyClosedHours === true },
        ),
      onConfigSaved: (deviceId, config) => {
        this.configMirror.put(deviceId, config)
      },
      onConfigChanged: async (deviceId) => {
        // The sensor reverse index is a MIRROR refreshed off the trigger path
        // (D49): it is rebuilt here, on an RPC that cannot be dropped, never
        // read fallibly while a `DeviceStateChanged` is being routed. A read
        // that failed on the hot path would answer "nobody listens" and lose
        // the episode, which is the failure D49 is written against.
        await this.refreshSensorTriggerBindings()
        await (this.controller?.onConfigChanged(deviceId) ?? Promise.resolve())
      },
      pauseForStorageMigration: (leaseId) => this.pauseForStorageMigration(leaseId),
      resumeForStorageMigration: (leaseId) => this.resumeForStorageMigration(leaseId),
      refreshStorageLocationsForMigration: (leaseId) =>
        this.refreshStorageLocationsForMigration(leaseId),
      assertStorageMigrationLease: (leaseId) => this.assertStorageMigrationLease(leaseId),
      moverClearance: (locationIds) =>
        this.ctx.api.storageMigration.moverClearance.query({ locationIds }),
      placementSnapshot: () => this.placementSnapshot(),
      placementView: () => {
        const placement = this.placement
        if (!placement) throw new Error('placement is not active on this node')
        return placement.placementView()
      },
      setDevicePlacement: (deviceId, locationId) => {
        const placement = this.placement
        if (!placement) throw new Error('placement is not active on this node')
        return placement.setDevicePin(deviceId, locationId)
      },
      dataDir: this.ctx.dataDir,
      playbackBaseUrl: () => this.playbackBaseUrl,
      // Recording is camera-only — gate the device-settings contribution so the
      // "Recording" card never shows on non-camera devices. Defaults to true on
      // lookup failure so a transient hiccup never hides a real camera's card.
      isCameraDevice: async (deviceId: number): Promise<boolean> => {
        try {
          const dev = await this.ctx.api.deviceManager.getDevice.query({
            deviceId,
          })
          return dev === null ? true : dev.type === DeviceType.Camera
        } catch {
          return true
        }
      },
    }
    const recordingProvider = buildRecordingProvider(recordingDeps)
    // OUR row of the `recording` collection, over the same deps and the same
    // coverage bodies. It is a separate provider object because the two caps
    // are separate registrations, not because they read separate state.
    const recordingSourceProvider = buildRecordingSourceProvider(recordingDeps)
    // Retained for the periodic retention sweep (armed in onHubReachable).
    this.recordingProvider = recordingProvider

    // The v2 StorageEvictableProvider answers the disk-pressure trigger: the
    // core StoragePressureManager asks us to free bytes on a location; we pick
    // the footage of cameras that no longer exist first, then oldest-first, and
    // delete it through the SegmentStore.
    const evictableProvider: IStorageEvictableProvider = new StorageEvictableProvider({
      // The archive, not the index: "how much is on this disk" and "what is the
      // oldest on it" are a SUM and a LIMIT over the hour ledger. Read per call
      // — the ledger is null until its collection declares.
      archive: () => this.segmentHours,
      logger: this.ctx.logger,
      store: this.segmentStore,
      resolveDomain: (locationId) => this.locationDomain(locationId),
      // Eviction policy `never` (D385): `readonly` and `disabled` are frozen;
      // `drain` REMAINS evictable — that is the whole mechanism the ratchet
      // drives.
      isEvictionFrozen: (locationId) => {
        const location = this.resolvedLocations.find((l) => l.id === locationId)
        return location !== undefined && evictionPolicyForMode(location.mode) === 'never'
      },
      // The fallible read behind the dead-device tier. `slim` because the gate
      // reads `id` and nothing else. A throw becomes `unanswered` — never an
      // empty fleet, which is the one mistranslation that would delete a live
      // camera's footage (D49/D72); the lane refuses an empty answer too, but
      // it must never be handed one that a failure produced.
      deviceRegistry: async (): Promise<DeviceRegistryRead> => {
        try {
          const devices = await this.ctx.api.deviceManager.listAll.query({ projection: 'slim' })
          return { status: 'answered', deviceIds: new Set(devices.map((d) => d.id)) }
        } catch (err) {
          return {
            status: 'unanswered',
            detail: err instanceof Error ? err.message : String(err),
          }
        }
      },
      onEvicted: (summaries) => {
        for (const s of summaries) {
          // Durable audit row — the bus event below is droppable telemetry;
          // the operator's "what got evicted, when, why" question is answered
          // by `listOpsLog`, so pressure eviction must land there too. The
          // reason is the WHY: `orphaned-device` when the camera is gone,
          // `quota` when age chose it. One reason for both would make the only
          // question an operator asks after a disk fills unanswerable.
          const opReason: OpsLogReason =
            s.reason === 'orphaned-device' ? 'orphaned-device' : 'quota'
          void opsLog.append({
            op: 'prune',
            reason: opReason,
            deviceId: s.deviceId,
            itemsAffected: s.segments,
            bytesReclaimed: s.bytes,
            detail: `disk-pressure evicted [${new Date(s.fromMs).toISOString()}, ${new Date(
              s.toMs,
            ).toISOString()}) on ${s.locationId} — ${s.reason}`,
          })
          if (s.reason === 'orphaned-device') {
            this.ctx.logger.info(
              'recorder: disk-pressure evicted footage of a camera that no longer exists — chosen ahead of older footage of live cameras',
              {
                tags: { deviceId: s.deviceId },
                meta: {
                  locationId: s.locationId,
                  segments: s.segments,
                  bytes: s.bytes,
                  fromMs: s.fromMs,
                  toMs: s.toMs,
                },
              },
            )
          }
          this.ctx.eventBus.emit({
            id: randomUUID(),
            timestamp: new Date(),
            source: {
              type: 'device',
              id: s.deviceId,
              addonId: this.ctx.id,
              deviceId: s.deviceId,
              nodeId: this.nodeId,
            },
            category: EventCategory.RecordingRetentionCompleted,
            data: {
              deviceId: s.deviceId,
              locationId: s.locationId,
              segments: s.segments,
              bytes: s.bytes,
              fromMs: s.fromMs,
              toMs: s.toMs,
              trigger: 'disk-pressure',
              reason: s.reason,
            },
          })
        }
      },
    })

    // ── Recording export: render engine + provider + download data-plane ────
    // The engine renders a DEDICATED per-export source playlist whose segment
    // URIs are ABSOLUTE on-disk paths. The playback variant playlist cannot be
    // reused: its URIs resolve only through the data-plane's multi-root search
    // (playlists under `<dataDir>/playback`, segments under a location root),
    // and it sits at a shared path rewritten by every playback request. See
    // `export-source-playlist.ts`.
    const exportsState = this.exportsStore()
    // Lazy: the root resolves in `onHubReachable`; until then every call
    // refuses through `exportOutPathFor(null, …)` / `exportsDirOrThrow`.
    const exportOutPath = (rec: ExportRecord): string =>
      exportOutPathFor(this.exportsRoot, rec.deviceId, rec.id)
    const removeExportFile = async (p: string): Promise<void> => {
      // `force` makes an already-gone file a no-op (never throws on ENOENT).
      await fs.rm(p, { force: true })
    }
    this.exportEngine = new ExportEngine({
      spawn: childProcessSpawn,
      resolveFfmpeg: this.pinnedFfmpeg,
      logger: this.ctx.logger.child('export'),
      state: exportsState,
      resolvePlaylist: async (rec) => {
        // ffmpeg does NOT create its output directory — nothing else does either,
        // so `<exports>/<deviceId>` is made here, before the render, whatever the
        // source playlist's own location happens to be.
        await fs.mkdir(path.dirname(exportOutPath(rec)), { recursive: true })
        return writeExportSourcePlaylist({
          deps: recordingDeps,
          exportsDir: this.exportsDirOrThrow(),
          exportId: rec.id,
          deviceId: rec.deviceId,
          profile: rec.profile,
          fromMs: rec.fromMs,
          toMs: rec.toMs,
        })
      },
      // The per-export source playlist is transient — dropped when the render
      // ends, whatever the outcome.
      cleanupPlaylist: removeExportFile,
      writeTextFile: async (p, contents) => {
        await fs.mkdir(path.dirname(p), { recursive: true })
        await fs.writeFile(p, contents, 'utf8')
      },
      outPath: exportOutPath,
      statBytes: async (p) => (await fs.stat(p)).size,
      removeFile: removeExportFile,
      emit: (category, data) => this.emitExportEvent(category, data),
      now: () => Date.now(),
      // The ONE byte seam to the addon that owns the camera. There is no
      // addon→addon transport (`AddonDataPlane` only lets an addon SERVE,
      // behind a per-listener secret only the hub may present), so this cap
      // read is how a clip's bytes reach the recorder — once, by handle,
      // under the bound the caller states (D558 § 3). The wake travels
      // verbatim and is never invented here.
      fetchClipBytes: async (req) =>
        await this.ctx.api.videoclips.readClipBytes.query({
          deviceId: req.deviceId,
          clipId: req.clipId,
          provider: req.provider,
          // The collection pin — see the broker's note. Without it this read
          // lands on whichever videoclips provider the hub lists first.
          addonId: req.provider,
          profile: req.profile,
          maxBytes: req.maxBytes,
          ...(req.wake !== undefined ? { wake: req.wake } : {}),
        }),
      // The PREFERRED byte seam to the addon that owns the camera (D613).
      // `offerClipBytes` answers with a one-shot loopback ticket; `peerBytes`
      // opens it and the body streams straight into the export file, so the
      // payload is never held on either side and the inline 50 MiB bound does
      // not apply. A provider that predates the method answers
      // `NOT_IMPLEMENTED`, which becomes `unsupported` here — the engine then
      // falls back to the inline read and SAYS SO.
      fetchClipToFile: async (req) => {
        const peerBytes = this.ctx.peerBytes
        if (peerBytes === undefined) {
          return {
            kind: 'unsupported',
            detail: 'this recorder has no addon-to-addon byte transport wired',
          }
        }
        let offered: ClipBytesOffer
        try {
          offered = await this.ctx.api.videoclips.offerClipBytes.query({
            deviceId: req.deviceId,
            clipId: req.clipId,
            provider: req.provider,
            // The collection pin — without it this read lands on whichever
            // videoclips provider the hub lists first, which for THIS addon is
            // its own analytics source (D591).
            addonId: req.provider,
            profile: req.profile,
            maxBytes: req.maxBytes,
            ...(req.wake !== undefined ? { wake: req.wake } : {}),
          })
        } catch (err: unknown) {
          const detail = err instanceof Error ? err.message : String(err)
          // A provider that has not been redeployed since D613 has no such
          // method. Everything else is a real refusal and must reach the
          // engine's classifier, not be swallowed as "unsupported".
          if (/NOT_IMPLEMENTED|not implemented|is not a function/i.test(detail)) {
            return {
              kind: 'unsupported',
              detail: `${req.provider} does not serve videoclips.offerClipBytes: ${detail}`,
            }
          }
          throw err
        }
        const opened = await peerBytes.open(offered.ticket)
        if (opened.kind === 'refused') {
          // Every one of these is a statement about the TRANSPORT, not about
          // the clip — `cross-node` most of all, which means the provider runs
          // on an agent and its loopback ticket means nothing here.
          this.ctx.logger.warn('clip export: the byte offer could not be opened', {
            tags: { deviceId: req.deviceId },
            meta: {
              clipId: req.clipId,
              provider: req.provider,
              branch: opened.code,
              detail: opened.detail,
              mintedOn: offered.ticket.hostNodeId,
            },
          })
          throw new Error(clipExportFailure('fetch-failed', `${opened.code}: ${opened.detail}`))
        }
        const written = await opened.body.writeToFile(req.outPath, { maxBytes: req.maxBytes })
        if (written.kind === 'refused') {
          this.ctx.logger.warn('clip export: the byte transfer did not complete', {
            tags: { deviceId: req.deviceId },
            meta: {
              clipId: req.clipId,
              provider: req.provider,
              branch: written.code,
              detail: written.detail,
              bytes: written.bytes,
              maxBytes: req.maxBytes,
            },
          })
          throw new Error(
            clipExportFailure(
              written.code === 'too-large' ? 'too-large-to-transfer' : 'fetch-failed',
              written.detail,
            ),
          )
        }
        this.ctx.logger.info('clip export: bytes streamed by handle', {
          tags: { deviceId: req.deviceId },
          meta: {
            clipId: req.clipId,
            provider: req.provider,
            bytes: written.bytes,
            declaredBytes: offered.ticket.declaredBytes,
            served: offered.served,
          },
        })
        return {
          kind: 'written',
          bytes: written.bytes,
          served: offered.served,
          durationMs: offered.durationMs ?? null,
        }
      },
      writeExportFile: async (p, bytes) => {
        // Nothing else creates `<exports>/<deviceId>` on this path — the
        // render branch makes it inside `resolvePlaylist`, which a clip never
        // reaches.
        await fs.mkdir(path.dirname(p), { recursive: true })
        await fs.writeFile(p, bytes)
      },
    })
    const exportProvider = buildRecordingExportProvider({
      state: exportsState,
      engine: this.exportEngine,
      // Hydrate the window, THEN read — the same order `collectRangeSegments`
      // uses for the render itself, so the fail-fast gate and the renderer
      // cannot disagree. Reading `this.index` bare here refused every export of
      // an hour the archive walk had not reached yet (live: a 21:00→07:00
      // window on a recorder restarted at 11:04).
      index: {
        segmentsInWindow: async (deviceId, profile, fromMs, toMs) => {
          if (this.index.hydrationOf(deviceId, fromMs, toMs) !== 'hydrated') {
            await hydrateWindowFromStorage(
              this.index,
              deviceId,
              fromMs,
              toMs,
              this.resolvedLocations,
              this.ctx.logger,
              this.segmentHours ?? undefined,
            )
          }
          return this.index.segments(deviceId, profile)
        },
      },
      // The clip catalog, asked of the ONE provider the subject names — a
      // clip export's fail-fast gate, in place of the recording index the
      // recorder has no rows in for bytes it never wrote.
      clipCatalog: {
        listClips: async (input) => await this.ctx.api.videoclips.listClips.query(input),
      },
      now: () => Date.now(),
      newId: () => randomUUID(),
      // No per-call caller identity reaches a cap provider (methods receive only
      // `input`), so the audit field records the addon principal.
      createdBy: () => 'operator',
      outPath: exportOutPath,
      removeFile: removeExportFile,
      downloadUrlFor: (id) => `/addon/${RECORDER_ADDON_ID}/${EXPORTS_PREFIX}/${id}.mp4`,
      statBytes: async (p) => (await fs.stat(p)).size,
      readFile: (p) => fs.readFile(p),
      // Overnight timelapses with dense slowdown land at 80–200 MB; the inline
      // ceiling is Telegram's 50 MB (and the base64 envelope). Shrink into a
      // temp under the exports root — the original file stays for clickUrl.
      shrinkToBound: async (inputPath, maxBytes) => {
        const writePath = path.join(
          this.exportsDirOrThrow(),
          '.shrink',
          `${path.basename(inputPath, '.mp4')}-${randomUUID()}`,
        )
        await fs.mkdir(path.dirname(writePath), { recursive: true })
        return shrinkExportToBound(inputPath, maxBytes, {
          resolveFfmpeg: this.pinnedFfmpeg,
          spawn: childProcessSpawn,
          writePath,
          readFile: (p) => fs.readFile(p),
          removeFile: async (p) => {
            await fs.rm(p, { force: true })
          },
          statBytes: async (p) => (await fs.stat(p)).size,
        })
      },
      logger: this.ctx.logger.child('export'),
    })

    // Playback data-plane: serve HERE (onInitialize, before the node-registration
    // handshake) so the hub's data-plane PULL picks it up — serving it later in
    // onHubReachable misses the pull and the `/addon/recorder/playback/*` route
    // never registers. The handler's `getRoots` is lazy (locations resolve at
    // request time, in onHubReachable), so serving early is safe. The hub
    // authenticates (admin) + reverse-proxies to our localhost listener.
    try {
      // The directory answers from memory on the SAME prefix as the segment
      // bytes — one plane, one credential path — and everything else falls
      // through to the file handler untouched.
      const handler = withDirectoryRoute(
        {
          source: this.calendar,
          mfraFor: (deviceId, profile, startMs) => this.mfraTables.get(deviceId, profile, startMs),
          onLog: (msg, meta) => this.ctx.logger.debug(msg, { meta }),
        },
        createFileDataPlaneHandler({ getRoots: () => this.playbackRoots() }),
      )
      // `authenticated`, not `admin`: any logged-in viewer plays recordings (same
      // reach as live), and a `<video src>`/scrub `fetch` can only carry a
      // same-origin cookie (no Bearer header) — the embed sets `camstack_session`
      // from its injected token so these sub-resource requests authenticate.
      const served = await this.ctx.dataPlane?.serve({
        prefix: PLAYBACK_PREFIX,
        access: 'authenticated',
        handler,
      })
      // CLIENT URL = the hub reverse-proxy path `/addon/<addonId>/<prefix>`, NOT
      // `served.baseUrl` (the internal 127.0.0.1 listener, hub-only). Set only on
      // a successful serve so getPlaybackManifest returns "no playback" otherwise.
      // The embed builds directory/segment URLs from the shared constant with
      // no discovery round trip, so the served path must BE that constant.
      const clientPath = `/addon/${RECORDER_ADDON_ID}/${PLAYBACK_PREFIX}`
      if (clientPath !== PLAYBACK_PLANE_PATH) {
        throw new Error(
          `recorder playback path drifted: serving ${clientPath}, clients use ${PLAYBACK_PLANE_PATH}`,
        )
      }
      this.playbackBaseUrl = served ? clientPath : null
      this.ctx.logger.info('recorder playback data-plane served', {
        meta: {
          clientBase: this.playbackBaseUrl ?? '(no dataPlane facility)',
          internal: served?.baseUrl,
        },
      })
    } catch (err: unknown) {
      this.ctx.logger.warn('recorder playback data-plane failed to serve', {
        meta: { error: errMsg(err) },
      })
    }

    // Still data-plane (design 2026-07-24): on-demand single-JPEG decode near a
    // wall-clock instant from the LOW recording — the export dialog's start/end
    // frame previews (replaces the retired sprite-sheet scrub-thumbnail tier for
    // this use). Stateless one-shot ffmpeg per request; roots resolve lazily, so
    // serving early (before the node-registration handshake) is safe and the
    // hub's one-shot endpoint pull picks up `/addon/recorder/still/*`.
    try {
      const stillService = new StillFrameService({
        // `[epochMs, epochMs+1)` is exactly "covers this instant" for a
        // half-open span, so the service sees the same candidate set the
        // whole-archive scan used to hand it — just without the archive.
        lowSegmentsAt: (deviceId, epochMs) =>
          this.index.segmentsOverlapping(deviceId, 'low', epochMs, epochMs + 1),
        resolveAbsPath: (row) => this.resolveSegmentAbsPath(row),
        logger: this.ctx.logger.child('Still'),
        resolveFfmpeg: this.pinnedFfmpeg,
      })
      const served = await this.ctx.dataPlane?.serve({
        prefix: STILL_PREFIX,
        access: 'authenticated',
        handler: (req, res) => this.serveStill(stillService, req, res),
      })
      this.ctx.logger.info('recorder still data-plane served', {
        meta: {
          clientBase: served ? `/addon/${RECORDER_ADDON_ID}/${STILL_PREFIX}` : '(no dataPlane)',
          internal: served?.baseUrl,
        },
      })
    } catch (err: unknown) {
      this.ctx.logger.warn('still data-plane serve failed', {
        meta: { error: errMsg(err) },
      })
    }

    // Export download data-plane: a DEDICATED handler (not the generic file
    // server) so it can observe final-byte delivery and record the download for
    // `deleteAfterDownload` accounting. Served early like playback so the hub's
    // one-shot endpoint pull picks up `/addon/recorder/exports/*`.
    try {
      const served = await this.ctx.dataPlane?.serve({
        prefix: EXPORTS_PREFIX,
        access: 'authenticated',
        handler: (req, res) => this.serveExportDownload(exportsState, exportOutPath, req, res),
      })
      this.ctx.logger.info('recorder exports data-plane served', {
        meta: {
          clientBase: served
            ? `/addon/${RECORDER_ADDON_ID}/${EXPORTS_PREFIX}`
            : '(no dataPlane facility)',
          internal: served?.baseUrl,
        },
      })
    } catch (err: unknown) {
      this.ctx.logger.warn('recorder exports data-plane failed to serve', {
        meta: { error: errMsg(err) },
      })
    }

    this.ctx.logger.info('recorder addon started (continuous write path active)', {
      tags: { nodeId: this.nodeId },
      meta: {
        segmentSeconds: this.config.segmentSeconds,
        watchIntervalMs: this.config.watchIntervalMs,
      },
    })

    // The controller is STARTED in `onHubReachable` (once `ctx.api.*` is safe);
    // here we only construct it.

    // One boot-time shout for any config left band-less by the 2026-07-30
    // legacy-authoring retirement: it claims a mode but records nothing.
    // The D371→D380 migration runs FIRST: a config still carrying the retired
    // `triggers.deviceSignal` would otherwise be counted among the band-less.
    void migrateLegacyDeviceSignalRows(this.configStore(), this.ctx.logger)
      .catch((err: unknown) => {
        this.ctx.logger.warn('recorder: device-signal config migration failed', {
          meta: { error: errMsg(err) },
        })
      })
      .then(() => warnLostBands(this.configStore(), this.ctx.logger))

    const removalHook = createRecorderRemovalHook(recordingDeps)
    this.removalHook = removalHook
    const providers: readonly ProviderRegistration[] = [
      // TWO registrations, one recorder. `recording-archive` is the system
      // SINGLETON — our storage, our intent, our byte plane — and `recording`
      // is the per-device COLLECTION the operator picks a source on (D625).
      // The `videoclips` entry a few lines down is the working template for
      // the second one: a device-scoped collection registered from this addon,
      // `defaultActive`, auto-bound to cameras.
      // Every inbound provider is heap-measured (see `heap-delta.ts`): one line
      // for a call that grew the heap past the bar or ran long, nothing else.
      {
        capability: recordingArchiveCapability,
        provider: this.heapProbe.wrapProvider(recordingArchiveCapability.name, recordingProvider),
      },
      {
        capability: recordingCapability,
        provider: this.heapProbe.wrapProvider(recordingCapability.name, recordingSourceProvider),
      },
      // The CamStack clip source, over THIS addon's archive. A clip is a time
      // window over recorded footage, so the addon that writes the footage is
      // the one that declares the source (D560). The composer is unchanged; it
      // reads its annotations from `pipelineAnalytics` over `ctx.api` and its
      // footage through the `recording` cap — never the local provider, because
      // this addon runs on every recording node and the hub dispatches to one
      // of them.
      {
        capability: videoclipsCapability,
        provider: this.heapProbe.wrapProvider(
          videoclipsCapability.name,
          createRecorderVideoclipsProvider({
            api: this.ctx.api,
            logger: this.ctx.logger,
          }),
        ),
      },
      {
        capability: storageEvictableCapability,
        provider: this.heapProbe.wrapProvider(storageEvictableCapability.name, evictableProvider),
      },
      // The SAME object answers `storage-occupancy` (D388) — a different
      // quantity over the same archive: bytes HELD on this location, including
      // the ones eviction is not allowed to touch.
      {
        capability: storageOccupancyCapability,
        provider: this.heapProbe.wrapProvider(storageOccupancyCapability.name, evictableProvider),
      },
      {
        capability: recordingExportCapability,
        provider: this.heapProbe.wrapProvider(recordingExportCapability.name, exportProvider),
      },
      // This addon's own cost, already attributed. Computed live from
      // `costRegistry` on whatever beat the caller has — no timer, no history,
      // no persistence.
      {
        capability: loadContributionCapability,
        provider: { list: () => this.costRegistry.contributions() },
      },
      // A deleted device's footage and recording config are removed with it
      // (D865) — told by device-manager, and caught up from its tombstones.
      {
        capability: deviceRemovalHookCapability,
        provider: removalHook,
      },
    ]
    this.footageDiscard = createFootageDiscardJob({
      listLocations: async () => this.ctx.api.storage.listLocations.query({}),
      localNodeId: this.nodeId,
      index: this.index,
      ledger:
        this.segmentHours === null
          ? null
          : {
              forgetScope: (scope) => this.segmentHours!.forgetScope(scope),
              snapshot: () => this.segmentHours!.snapshot(),
            },
      now: () => Date.now(),
    })
    return {
      providers,
      customActions: { ...recorderDebugActions, ...locationDiscardActions },
      actionHandlers: {
        'debug.storeCensus': async (input: DebugStoreCensusInput) =>
          handleStoreCensusAction(this.readCensus, this.ctx.logger.child('Census'), input),
        'storage.discardLocation': async (input: DiscardStartInput) =>
          this.footageDiscard?.start(input) ?? {
            started: false,
            alreadyRunning: false,
            jobId: null,
          },
        'storage.discardLocationStatus': async () => this.footageDiscard?.status() ?? IDLE_DISCARD,
        'storage.discardLocationCancel': async () =>
          this.footageDiscard?.cancel() ?? { requested: false },
      },
    }
  }

  protected async onShutdown(): Promise<void> {
    // First: the monitor is armed before the recording-node gate, so it is the
    // one thing running even on an inert node and it must come down there too.
    this.stopStallMonitor?.()
    this.stopStallMonitor = null
    // Drop the motion + audio-level + detection subscriptions first so no
    // trigger races the teardown.
    this.eventUnsub?.()
    this.eventUnsub = null
    this.audioTriggerUnsub?.()
    this.audioTriggerUnsub = null
    this.detectionTriggerUnsub?.()
    this.detectionTriggerUnsub = null
    this.sensorTriggerUnsub?.()
    this.sensorTriggerUnsub = null
    this.signalTriggerUnsub?.()
    this.signalTriggerUnsub = null
    this.locationChangeUnsub?.()
    this.locationChangeUnsub = null
    this.locationRefresher?.dispose()
    this.locationRefresher = null
    // Stop the controller: kill every ffmpeg writer, stop the watchers,
    // unsubscribe the broker-readiness restore, and release the broker
    // pipelineKeys. The index is in-memory and GC'd with the instance.
    await this.controller?.stop()
    // The seals the teardown just fired are write-behind: let them land, or
    // every hour this process was writing comes back unsealed and is walked.
    await this.segmentHours?.flush()
    this.controller = null
    this.segmentStore = null
    if (this.exportSweepTimer !== null) {
      clearInterval(this.exportSweepTimer)
      this.exportSweepTimer = null
    }
    this.retentionSweeper?.stop()
    this.retentionSweeper = null
    this.redundancySweeper?.stop()
    this.redundancySweeper = null
    this.ghostLocationPass?.stop()
    this.ghostLocationPass = null
    this.hourAdoptionPass?.stop()
    this.hourAdoptionPass = null
    this.exportEngine = null
    this.recordingProvider = null
  }

  /**
   * The eviction DOMAIN of `locationId`: every resolved recordings location that
   * shares its physical filesystem root, including itself. Managed locations that
   * alias one disk (today `recordings:default` + `recordingsLow:default` both at
   * `/recordings`) form one oldest-first eviction pool — otherwise disk-pressure
   * relief on one alias deletes the newest footage while the other alias holds the
   * old (the age-partition data-loss bug).
   *
   * Grouping keys by `fs.realpathSync` of the resolved root (see
   * `resolveEvictionDomain`), NOT the resolved string alone: a symlinked or
   * bind-aliased path reaching the same disk collapses to one key, closing the
   * loophole where two aliases with different path strings would re-partition.
   * When realpath throws (root missing at boot) it falls back to the resolved
   * string — distinct roots stay distinct domains (safe: over-partitions at
   * worst, never merges two disks).
   */
  private locationDomain(locationId: string): ReadonlySet<string> {
    return resolveEvictionDomain(this.resolvedLocations, locationId)
  }

  /**
   * The operator's "does my ledger tell the truth?" pass (D319).
   *
   * Built once and handed to the provider, but every dependency it holds is a
   * THUNK: `this.segmentHours` is null until the collection declares, and
   * `this.resolvedLocations` is re-resolved whenever a disk appears. A
   * reconciler that captured either would answer for the boot instant forever.
   *
   * `listHour` is a SHALLOW `readdir` of exactly one hour directory — never
   * `recursive: true`, which is the call that takes minutes over `/recordings`
   * and the reason a shell `find` hung an SSH session. A directory that is not
   * there answers `null`; anything else throws, and a throw decides nothing.
   *
   * `anchorOf` is the placement volume marker, which lives ON the disk: it is
   * the only thing here that can tell a location whose hours were deleted from
   * a mountpoint whose disk went away.
   */
  private ledgerWalkReconciler(): LedgerWalkReconciler {
    return new LedgerWalkReconciler({
      ledger: () => this.segmentHours,
      locations: () => this.resolvedLocations,
      listHour: async (root, relDir) => {
        try {
          return await fs.readdir(path.join(root, relDir))
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw err
        }
      },
      anchorOf: async (root) => (await readLocationMarker(root))?.volumeId ?? null,
      applyToIndex: (deviceId, locationId, hour, paths) =>
        this.index.resetHour(deviceId, locationId, hour, paths),
      logger: this.ctx.logger,
      now: () => Date.now(),
      pace: () => sleep(LEDGER_WALK_PAUSE_MS),
    })
  }

  /**
   * Boot hydrate: once the hub is reachable (`ctx.api.*` safe), resolve the
   * recordings locations and rebuild the in-memory index from `storage.list`
   * for every device that has a persisted config. The list result is the
   * ground truth — segment paths encode start/dur/bytes, so the index can never
   * drift from disk.
   */
  override async onHubReachable(): Promise<void> {
    // Inert on non-designated nodes — no hydrate, no controller, no event
    // subscription (the gate already returned no providers in onInitialize).
    if (!this.isRecordingNode) return
    // Through `refreshLocations` (not the raw resolver) so the same-root alias
    // guard runs at boot too — a mis-aliased pair must never reach placement.
    await this.refreshLocations()
    // Catch up on deletions this node missed while it was down (D865). Driven
    // by device-manager's tombstones only — never by a camera being absent.
    const removalHook = this.removalHook
    if (removalHook !== null) {
      this.ctx.addDisposer(
        armRemovalReconcile({
          api: this.ctx.api,
          logger: this.ctx.logger,
          remove: (input) => removalHook.onDeviceRemoved(input),
        }),
      )
    }
    // The exports class root — resolved HERE (same lifecycle stage as the
    // recordings locations; the storage cap is not reliably reachable in
    // `onInitialize`). Failure leaves `exportsRoot` null and everything that
    // needs it refuses loudly; falling back to the addon data dir is the
    // failure mode D341 exists to end.
    try {
      this.exportsRoot = await this.ctx.api.storage.resolve.query({
        location: ARTIFACTS_MEDIA_LOCATION,
        relativePath: '',
      })
    } catch (err: unknown) {
      this.ctx.logger.error(
        'artifacts storage location is NOT available — exports, GIF and clip renders will REFUSE until it is',
        {
          meta: {
            location: ARTIFACTS_MEDIA_LOCATION,
            error: errMsg(err),
            hint: 'the declaration is seeded when a storage-provider registers; restart this node so the manifest is re-read, or create an artifacts location. Refusing is deliberate — the addon data dir carries no media.',
          },
        },
      )
    }
    if (this.resolvedLocations.length === 0) {
      this.ctx.logger.warn(
        'recorder: no recordings storage locations resolved — index not hydrated',
      )
      return
    }

    // One-time cleanup: the scrub-pack service is DELETED (unreachable from any
    // client since byte-range scrub replaced it). Its caches — the pre-ADR-0027
    // copy in addons-data AND the `.scrub-packs` dirs under each recordings
    // root — are dead disk; remove them best-effort.
    void fs
      .rm(path.join(this.ctx.dataDir, 'scrub-packs'), {
        recursive: true,
        force: true,
      })
      .catch(() => {})
    for (const loc of this.resolvedLocations) {
      void fs
        .rm(path.join(loc.root, '.scrub-packs'), {
          recursive: true,
          force: true,
        })
        .catch(() => {})
    }

    // The staging boot, in the order `staging-boot.ts` explains (D667): reap
    // a previous runner's writers, stamp the cutoff, start the write path,
    // recover what is staged, then sweep unassigned roots — the last two are
    // one unawaited chain.
    //
    // Orphaned `.rec-tmp` staging on roots nothing is assigned to any more is
    // swept AFTER recovery, so the last segments of a writer reaped on a
    // retired root get one chance to land rather than being deleted first.
    // The sweep re-reads placement; a root the controller just assigned is no
    // longer in scope.
    //
    // ── Start the WRITE path FIRST — before the (potentially multi-minute) index
    // hydrate below ──────────────────────────────────────────────────────────
    // The per-device `hydrateDeviceFromStorage` walk is a `fs.readdir(deviceDir,
    // { recursive: true })` over the ENTIRE recordings subtree; its cost scales
    // with total on-disk segment count (Y/M/D/H tree of 10s `.m4s` files ×
    // profiles × locations), which after a few weeks of footage is >1M files and
    // takes minutes — and gets worse under the disk-IO contention of a hot-deploy
    // respawn (the outgoing runner's ffmpeg writers are still tearing down). When
    // the hydrate was sequenced BEFORE `controller.start()`, that slow readdir
    // (or a slow `readDeviceConfigs`) gated ALL recording: the just-respawned
    // recorder logged "continuous write path active" but no SegmentWriter ever
    // attached until the walk finished — ZERO recording for minutes (indefinitely
    // when the walk lost the IO race), and `restartAddon` couldn't recover it
    // because the fresh child hit the same slow walk. Recording does NOT depend on
    // the index (that is the playback/retention/eviction read-model); it needs
    // only `resolvedLocations` (resolved above) + the persisted enabled devices
    // (the controller reads those itself via `enabledDeviceIds()`). So start the
    // controller + motion subscription now; the index hydrate below runs after,
    // and since `onHubReachable` is a floating promise nobody awaits, its long
    // completion no longer blocks the live write path. Both are idempotent on
    // re-entry (controller.start is a no-op once started; the motion subscribe is
    // guarded by the `eventUnsub === null` check).
    //
    // The boot cutoff is stamped BEFORE the writers spawn: it is what makes the
    // staging reconcile safe to run against a live recorder. Every segment a
    // writer started here produces is named after this instant, so the
    // recovery plan cannot select one.
    //
    // The recovery is deliberately AFTER `controller.start()` and NOT awaited:
    // ffmpeg truncates its `-segment_list` on every spawn, so nothing names a
    // previous runner's segments and no watcher will ever finalize them — 179
    // GB had accumulated that way by 2026-08-14 — but recording is the priority
    // and the backlog is thousands of files.
    await runStagingBoot({
      reapPredecessorWriters: () =>
        this.heapProbe.track({ kind: 'boot-phase', name: 'staging-writer-sweep' }, () =>
          this.reapPredecessorWriters(),
        ),
      sweepUnassignedStaging: () =>
        this.heapProbe.track({ kind: 'boot-phase', name: 'staging-unassigned-sweep' }, () =>
          this.sweepUnassignedStaging(),
        ),
      startWritePath: async () => {
        try {
          await this.controller?.start()
        } catch (err: unknown) {
          this.ctx.logger.warn('recorder: controller start failed', {
            meta: { error: errMsg(err) },
          })
        }
      },
      recoverStagedOrphans: (bootMs) =>
        this.heapProbe.track({ kind: 'boot-phase', name: 'staging-recovery' }, () =>
          this.recoverStagedOrphans(bootMs),
        ),
      now: () => Date.now(),
    })
    // The location-change doorbell (D387). An operator who adds a recordings
    // disk in the admin UI used to get NOTHING: the pool the placement pass
    // plans over was whatever boot resolved, so the new disk was not a write
    // target until somebody called `rescanStorage` by hand. The event is
    // telemetry and may be dropped, so `LocationRefresher` also converges on
    // the placement pass's own timer — the doorbell only makes it fast.
    if (this.locationRefresher === null) {
      this.locationRefresher = new LocationRefresher({
        logger: this.ctx.logger,
        refresh: () => this.refreshLocations(),
      })
    }
    if (this.locationChangeUnsub === null) {
      this.locationChangeUnsub = this.ctx.eventBus.subscribe(
        { category: EventCategory.StorageLocationsChanged },
        (event) => {
          this.locationRefresher?.ring(event.data.locationId, event.data.reason)
        },
      )
    }
    if (this.eventUnsub === null) {
      this.eventUnsub = subscribeEventCapture({
        eventBus: this.ctx.eventBus,
        onMotion: (deviceId, atMs) => {
          void this.controller?.onTrigger(deviceId, { kind: 'motion' }, atMs)
        },
      })
    }
    // The audio trigger feed (Track 0, D62): `audioThresholdDbfs` was
    // authorized by the UI, read by every pure function in
    // `band-decision.ts`, and fed by nobody — a band listening ONLY to audio
    // never recorded, silently. `frame.level.dbfs` is the SAME dBFS scale as
    // `audioThresholdDbfs` (`band-decision.ts` — `audioLevelQualifies`), so
    // qualification is a bare comparison; `onAudioLevel` resolves which
    // band's threshold applies (per-band, not per-device) and calls
    // `onTrigger(deviceId, 'audio', atMs)` exactly like `onMotion` does for
    // `'motion'`. A window with no `level` (analyzer step not enabled for
    // this camera) has nothing to compare — skipped, same as motion's own
    // `!detected` no-op, not a drop of qualified work.
    if (this.audioTriggerUnsub === null) {
      this.audioTriggerUnsub = this.ctx.eventBus.subscribe(
        { category: EventCategory.PipelineAudioInferenceResult },
        (event) => {
          const dbfs = event.data.frame.level?.dbfs
          if (dbfs === undefined) return
          void this.controller?.onAudioLevel(event.data.deviceId, dbfs, event.data.frame.timestamp)
        },
      )
    }

    // The object-detection trigger feed (Track A). The ONLY entry point is
    // `PipelineAnalyticsDetectionEvent` with `source: 'pipeline'` — it is by
    // construction downstream of `enabledMacroClasses`, the per-macro
    // confidence floors and the full-frame guard, so the operator's sliders
    // and the recording describe the SAME detection. Reading a raw signal
    // (`DetectionResult`, `DetectionCameraNative`, `PipelineAnalyticsFrameTracked`)
    // would produce two truths about one detection.
    if (this.detectionTriggerUnsub === null) {
      this.detectionTriggerUnsub = this.ctx.eventBus.subscribe(
        { category: EventCategory.PipelineAnalyticsDetectionEvent },
        (event) => {
          const verdict = qualifyObjectTrigger(event.data)
          // Silence reads as "it never happened" — but so does a per-event
          // `debug` line nobody can aggregate. The per-window tally is what
          // states the RATE, and a 100%-rejected window comes out at `warn`.
          for (const report of this.detectionTriggerHealth.record(verdict, Date.now())) {
            this.logDetectionTriggerHealth(report)
          }
          if (!verdict.qualified) {
            // Per-event detail stays at `debug` (this feed runs at bus rate on
            // every camera with the pipeline on) and now names the camera for
            // every reason except `malformed` — the one case, by construction,
            // where there is no numeric deviceId to name.
            this.ctx.logger.debug('recorder: detection event did not qualify as a trigger', {
              ...(verdict.reason === 'malformed' ? {} : { tags: { deviceId: verdict.deviceId } }),
              meta: { reason: verdict.reason },
            })
            return
          }
          void this.controller?.onTrigger(
            verdict.deviceId,
            { kind: 'object', macroClass: verdict.macroClass },
            verdict.atMs,
          )
        },
      )
    }

    // The SENSOR trigger feed (Track B). The operator's words: "è l'edge che
    // deve dare l'input" [it is the edge that must give the input] — only `false → true`, never the level.
    //
    // ## A sensor that goes OFFLINE, stated rather than implied
    //
    // 1. A provider that loses the device does not write the slice at all
    //    (Home Assistant exits earlier on `unavailable`/`unknown`), so there is
    //    no `DeviceStateChanged` to invent an edge from. The recorder
    //    synthesizes NOTHING and holds NO window open: a band listening only to
    //    that sensor simply stops demanding.
    // 2. A sensor that goes offline while HIGH and comes back still high reads
    //    `no-change` — no double recording. Low then high is a real edge.
    // 3. A RUNNER RESPAWN resets `lastValues` and moves `startedAtMs`. The
    //    first already-active slice counts as an edge only if its UPSTREAM
    //    transition is after `startedAtMs` and within 30 s; otherwise it stays
    //    silent and DECLARES it (`baseline-seeded-stale-active`, logged at
    //    `warn` because a real edge may have been eaten).
    //
    // Point (3) is an INHERITED choice, and the opposite of what the recorder
    // prefers elsewhere ("a failed read serves the last good config, because
    // keeping footage is the conservative choice"). It is kept identical to
    // every other `evaluateSensorEdge` consumer because an edge with a timestamp from hours ago is a
    // hydration, and 30 s of useless recording per camera on every respawn
    // across the fleet is a measurable cost. The operator confirmed this
    // polarity on 2026-08-26; if it is ever reversed, it is reversed HERE and
    // in `evaluateSensorEdge`, in one place.
    if (this.sensorTriggerUnsub === null) {
      // Seed the index BEFORE subscribing: between the subscribe and the first
      // refresh every edge would read `not-listened`, which is indistinguishable
      // from "no band asked" and would lose the episode without a line.
      await this.refreshSensorTriggerBindings()
      this.sensorTriggerUnsub = this.ctx.eventBus.subscribe(
        { category: EventCategory.DeviceStateChanged },
        (event) => {
          const parsed = parseSensorStateChanged(event.data)
          if (parsed === null) return
          const atMs = event.timestamp instanceof Date ? event.timestamp.getTime() : Date.now()
          const result = this.sensorRouter.onStateSlice(
            parsed.deviceId,
            parsed.capName,
            parsed.slice,
          )
          for (const cameraId of result.fired) {
            // `deviceId` is the CAMERA and the sensor rides in `meta` — the
            // question always arrives as "why did 102 get this and 101 not".
            this.ctx.logger.info('recorder: sensor rising edge opened a recording window', {
              tags: { deviceId: cameraId },
              meta: { sourceDeviceId: parsed.deviceId, capName: parsed.capName },
            })
            void this.controller?.onTrigger(
              cameraId,
              { kind: 'sensor', sourceDeviceId: parsed.deviceId },
              atMs,
            )
          }
          if (result.skipped === null || result.skipped === 'not-listened') return
          // `not-listened` is the overwhelming majority of this category's
          // traffic and it is NOT a loss: no band asked for that sensor.
          // Everything else IS an edge that did not become a recording, and
          // `baseline-seeded-stale-active` in particular is the case where a
          // real edge MAY have been eaten by a runner respawn.
          const level = result.skipped === 'baseline-seeded-stale-active' ? 'warn' : 'debug'
          this.ctx.logger[level]('recorder: sensor state change opened no window', {
            tags: { deviceId: parsed.deviceId },
            meta: { capName: parsed.capName, reason: result.skipped },
          })
        },
      )
    }

    // The DEVICE-SIGNAL feed: the camera's own `recording-signal` LEVEL
    // (`RecordingTriggers.deviceSignal`). Same bus category as the sensor
    // feed, a different discipline: no edge memory, no reverse index — the
    // event names the camera itself, and the controller holds the source open
    // for as long as the level is up (`onSignalLevel`). The cheap gate runs
    // FIRST: every other cap's churn on this category exits on the name
    // compare before the slice is parsed.
    if (this.signalTriggerUnsub === null) {
      this.signalTriggerUnsub = this.ctx.eventBus.subscribe(
        { category: EventCategory.DeviceStateChanged },
        (event) => {
          const parsed = parseSensorStateChanged(event.data)
          if (parsed === null || parsed.capName !== recordingSignalCapability.name) return
          const level = RecordingSignalStatusSchema.safeParse(parsed.slice)
          if (!level.success) {
            // A slice that does not parse is not a level. Dropping it silently
            // would read as "the signal never moved".
            this.ctx.logger.warn('recorder: device signal slice does not parse — ignored', {
              tags: { deviceId: parsed.deviceId },
              meta: { slice: parsed.slice },
            })
            return
          }
          const atMs = event.timestamp instanceof Date ? event.timestamp.getTime() : Date.now()
          void this.controller?.onSignalLevel(
            parsed.deviceId,
            { kind: 'signal' },
            level.data.active,
            atMs,
          )
        },
      )
    }

    // Load the hour ledger — every row, which since D523 is ten scalars each
    // and so is nothing proportional to the SEGMENT count. Nothing is replayed
    // into the RAM index: a row says how MUCH an hour holds and never which
    // files, so only a directory listing can seed the index, and every read
    // path lists the window it is asked about.
    //
    // What this buys, and why it is on the critical path for the 30 TB array:
    // the boot query used to carry the `paths` column — ~16 MB of JSON today, a
    // projected ~460 MB at 28 TB, parsed on the main thread before the index
    // exists — and the replay after it was a synchronous fold over every hour.
    // An addon deploy restarts this runner, so both were a recurring tax.
    try {
      await this.heapProbe.track({ kind: 'boot-phase', name: 'ledger-load' }, async () => {
        await this.segmentHours?.load()
      })
    } catch (err: unknown) {
      this.ctx.logger.warn(
        'recorder: segment-hour ledger load failed — hours stay unknown until a read walks them',
        {
          meta: { error: errMsg(err) },
        },
      )
    }

    let configs: Map<number, RecordingConfig>
    try {
      configs = await readDeviceConfigs(this.configStore())
    } catch (err: unknown) {
      this.ctx.logger.warn('recorder: reading persisted device configs failed — skipping hydrate', {
        meta: { error: errMsg(err) },
      })
      return
    }
    // Free re-apply from the map we just read: it costs nothing and it is what
    // recovers the index if the seed above hit a transient store failure.
    this.applySensorTriggerBindings(configs)

    // The ONLY thing built up front: today, per camera.
    //
    // There was a 31-day warm here and it was a bet — ~66 back-to-back
    // directory reads that cost 19 s of array time, during which a query took
    // 38 s instead of 0.2 s. Everything else is on demand now, because the
    // cache makes the second ask free and the first can pay for itself.
    //
    // Today survives because it is not a bet: it is the day every session
    // opens, it is 24 reads for one camera, and it runs as background work that
    // yields to anything actually asked for. Both UTC days the operator's local
    // today spans, since a local day is not a UTC one.
    void this.heapProbe.track({ kind: 'boot-phase', name: 'warm-today' }, () =>
      this.warmToday([...configs.keys()]),
    )

    // Do NOT walk the whole archive at boot / after a hot reload.
    // Live 2026-08-22: one camera's recursive readdir was 38–392 s on shfs;
    // overlapping eviction + that walk made every scrub `readBytes` hit
    // `segment read timeout` (8 s). Every read path already hydrates the
    // window it is asked about. Retention/eviction UNDER-report on a partial
    // index (prune less, never more) and re-run on their own cadence.
    this.ctx.logger.info('recorder: full-archive index walk skipped', {
      meta: {
        reason: 'on-demand-windows',
        ledgerHours: this.segmentHours?.snapshot().length ?? 0,
        deviceCount: configs.size,
      },
    })

    // Legacy sprite-sheet scrub-thumbnail cleanup (removed 2026-07-24): must run
    // AFTER `resolvedLocations` is populated above — at addon start it is still
    // empty and the sweep would be a silent no-op. Best-effort, fire-and-forget.
    void this.heapProbe.track({ kind: 'boot-phase', name: 'legacy-thumbs-cleanup' }, () =>
      this.cleanupLegacyThumbsDirs(),
    )

    // Note: the controller + motion subscription are STARTED earlier (right after
    // `resolvedLocations` resolves, BEFORE any index work) so recording is never
    // gated behind footage walks. See the "Start the WRITE path FIRST" block at
    // the top of this method.

    // Export bootstrap: resume renders interrupted by a restart and start the
    // periodic expiry sweep. Done here (locations resolved, `ctx.api.*` safe) so
    // a re-queued render can resolve its playlist — its `segmentsInWindow` gate
    // self-hydrates the render's window on demand, so it does NOT need the
    // deferred full-archive walk. Idempotent on re-entry.
    await this.bootstrapExports()

    // Retention sweep: periodically prune footage past each camera's per-device
    // age/size policy. Constructed + armed here (`ctx.api.*` safe). The first
    // tick sees the ledger-seeded index, not a full FS walk — that direction
    // is safe (victims are selected FROM index rows, so a partial index only
    // prunes less). Idempotent on re-entry.
    const provider = this.recordingProvider
    if (provider && this.retentionSweeper === null) {
      this.retentionSweeper = new RetentionSweeper({
        // `reason` omitted → `pruneFootage` records the op as 'retention'.
        prune: (deviceId) => provider.pruneFootage({ deviceId }),
        readConfigs: () => readDeviceConfigs(this.configStore()),
        logger: this.ctx.logger,
        intervalMs: RETENTION_SWEEP_INTERVAL_MS,
        heapProbe: this.heapProbe,
      })
    }
    this.retentionSweeper?.start()

    // Redundancy sweep: remove the ~10 s of media every SegmentWriter restart
    // re-writes (the broker serves its pre-roll ring to a recording dial). This
    // is the ONLY duplicate pruner in the recorder — the previous one was
    // reachable only from a walk that had no caller and went with it on
    // 2026-08-27. Bounded to a lookback window, never the archive.
    const store = this.segmentStore
    if (store && this.redundancySweeper === null) {
      this.redundancySweeper = new RedundancySweeper({
        deviceIds: async () => [...(await readDeviceConfigs(this.configStore())).keys()],
        // A SLICE of the index's sorted view. `segments(deviceId)` would copy
        // and re-sort the device's whole archive — the cost this sweep exists
        // without.
        segmentsInWindow: (deviceId, profile, fromMs, toMs) =>
          this.index.segmentsStartingIn(deviceId, profile, fromMs, toMs),
        evict: (locationId, rows) => store.evict(locationId, rows),
        logger: this.ctx.logger,
        intervalMs: REDUNDANCY_SWEEP_INTERVAL_MS,
        lookbackMs: REDUNDANCY_SWEEP_LOOKBACK_MS,
        heapProbe: this.heapProbe,
      })
    }
    this.redundancySweeper?.start()

    // Ghost-location reconcile: durable hour rows stamped with a `locationId`
    // `storage.listLocations` no longer knows. Nothing else can reach them —
    // the eviction domain is built from CURRENT ids so they are never victim
    // candidates, and there is no root to walk, which is why D148's
    // walk-or-eviction confirmation cannot reach them either. Daily, bounded,
    // and it starts NOTHING at boot (`startPeriodicPass` fires on the interval
    // only). See `ghost-location-sweep.ts` for why a listing of the hour
    // DIRECTORY at every resolvable root IS the trusted confirmation.
    const ledger = this.segmentHours
    if (ledger && this.ghostLocationPass === null) {
      const sweeper = new GhostLocationSweeper({
        ledger,
        locations: () => this.resolvedLocations,
        listHour: (locationId, deviceId, profile, hourStartMs) =>
          this.listHourDirectory(locationId, deviceId, profile, hourStartMs),
        applyToIndex: (rows, toLocationId) => {
          this.index.removeSegments(rows.map((row) => row.path))
          for (const row of rows) this.index.addSegment({ ...row, locationId: toLocationId })
        },
        forgetInIndex: (deviceId, locationId, hourStartMs) =>
          this.index.resetHour(deviceId, locationId, hourStartMs, []),
        logger: this.ctx.logger,
        now: () => Date.now(),
        pace: () => sleep(GHOST_LOCATION_PROBE_PAUSE_MS),
      })
      this.ghostLocationPass = startPeriodicPass({
        name: 'ghost-location-reconcile',
        intervalMs: GHOST_LOCATION_SWEEP_INTERVAL_MS,
        slowAfterMs: GHOST_LOCATION_SWEEP_SLOW_AFTER_MS,
        heapProbe: this.heapProbe,
        run: async () => {
          await sweeper.sweep()
        },
        logger: this.ctx.logger,
      })
    }

    // Hour adoption (D521): closed hour DIRECTORIES whose durable row is short
    // or missing, unioned back in. ADD-only — its ledger surface is
    // `adoptWalkedHour` and nothing else — so unlike the ledger↔disk walk it
    // needs no `source-writable` refusal and runs on the ACTIVE locations,
    // which is where the damage a torn-down writer leaves actually is.
    if (this.hourAdoptionPass === null) {
      const adopter = new HourAdoptionSweeper({
        ledger: () => this.segmentHours,
        locations: () => this.resolvedLocations,
        listDir: async (absDir) => {
          try {
            return await fs.readdir(absDir)
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
            throw err
          }
        },
        logger: this.ctx.logger,
        now: () => Date.now(),
        pace: () => sleep(LEDGER_WALK_PAUSE_MS),
      })
      this.hourAdoptionPass = startPeriodicPass({
        name: 'hour-adoption',
        intervalMs: HOUR_ADOPTION_INTERVAL_MS,
        // And once shortly after boot, which is what makes a DAILY repair run
        // at all on a hub that restarts more often than daily. Without it the
        // timer was armed and never reached: the 101 hole D521 exists to repair
        // sat on disk through five restarts in one morning (2026-09-18).
        firstRunDelayMs: HOUR_ADOPTION_FIRST_RUN_DELAY_MS,
        slowAfterMs: HOUR_ADOPTION_SLOW_AFTER_MS,
        heapProbe: this.heapProbe,
        run: async () => {
          // Every location this node can READ: an hour is damaged on the disk
          // it was written to, and a drained location holds hours no live
          // writer will ever touch again.
          //
          // And more than ONE pass each while there is work left. A sweep is
          // bounded at 512 listings with a cursor to resume from; calling it
          // once a day turned that bound into a speed limit, and the cursor is
          // in RAM so a restart lost the position. The first real pass here
          // adopted 29 037 segments from one location and still came back
          // bounded (2026-09-18).
          const moreWork = await runAdoptionCatchUp({
            locationIds: this.resolvedLocations.map((location) => location.id),
            sweep: (input) => adopter.sweep(input),
            budgetMs: HOUR_ADOPTION_CATCHUP_BUDGET_MS,
            now: () => Date.now(),
            pace: () => sleep(LEDGER_WALK_PAUSE_MS),
            onError: (locationId, error) => {
              this.ctx.logger.warn('recorder: hour adoption could not sweep a location', {
                meta: { locationId, error: errMsg(error) },
              })
            },
          })
          // A run that KNOWS it is unfinished must not wait for tomorrow. The
          // daily interval is the cadence for a quiet archive; a damaged one
          // gets another run as soon as the array has had a breather.
          if (moreWork) {
            this.ctx.logger.info(
              'recorder: hour adoption stopped on its budget with work left — resuming shortly',
              { meta: { resumeInMs: HOUR_ADOPTION_RESUME_MS } },
            )
            this.hourAdoptionResume?.unref?.()
            clearTimeout(this.hourAdoptionResume)
            this.hourAdoptionResume = setTimeout(() => {
              void this.hourAdoptionPass?.fireNow()
            }, HOUR_ADOPTION_RESUME_MS)
            this.hourAdoptionResume.unref?.()
          }
        },
        logger: this.ctx.logger,
      })
    }
  }

  /**
   * Print one window of detection-trigger health.
   *
   * The level is the whole point: a window in which SOME object detections
   * opened a recording is normal operation and stays at `debug`; a window in
   * which a camera produced object detections and NONE of them opened one is a
   * dead feature, and it goes out at `warn` with the camera and the dominant
   * reason on it. The unbucketable `malformed` envelopes are the only line here
   * without a `deviceId`, because a payload whose envelope did not parse names
   * no camera — and that line is always `warn`, since after 2026-08-29
   * `malformed` can only mean the emitter drifted.
   */
  private logDetectionTriggerHealth(report: ObjectTriggerHealthReport): void {
    const meta = {
      objectEvents: report.objectEvents,
      qualified: report.qualified,
      rejectedPct: report.rejectedPct,
      otherKinds: report.otherKinds,
      topReason: report.topReason,
      byReason: report.byReason,
      windowMs: report.windowMs,
    }
    if (report.deviceId === null) {
      this.ctx.logger.warn(
        'recorder: detection events with an UNREADABLE envelope — the emitter and this consumer disagree',
        { meta },
      )
      return
    }
    if (report.totalRejection) {
      this.ctx.logger.warn(
        'recorder: EVERY object detection was rejected in this window — the object recording trigger is doing nothing for this camera',
        { tags: { deviceId: report.deviceId }, meta },
      )
      return
    }
    this.ctx.logger.debug('recorder: object trigger window', {
      tags: { deviceId: report.deviceId },
      meta,
    })
  }

  /**
   * Rebuild the sensor trigger's reverse index from the persisted configs.
   *
   * D49: this is a MIRROR refreshed off the event path — at boot and on every
   * config write (an RPC that cannot be dropped), never from a fallible read
   * while a `DeviceStateChanged` is being routed.
   *
   * A failed read leaves the PREVIOUS index standing and says so. An index that
   * emptied itself on a transient store failure would answer "nobody listens"
   * to every sensor edge until the next config write — silently, and that is
   * precisely the "a read that fails changes nothing" half of D49.
   */
  private async refreshSensorTriggerBindings(): Promise<void> {
    try {
      this.applySensorTriggerBindings(await readDeviceConfigs(this.configStore()))
    } catch (err: unknown) {
      this.ctx.logger.warn(
        'recorder: sensor trigger index NOT refreshed — config read failed, the previous index stands',
        { meta: { error: errMsg(err) } },
      )
    }
  }

  /** Apply an already-read config map to the sensor index. Logs only when the
   *  set of listened sources CHANGED — a config write that touches something
   *  else must not print a line that reads as a rewiring. */
  private applySensorTriggerBindings(configs: ReadonlyMap<number, RecordingConfig>): void {
    const before = [...this.sensorRouter.listenedSourceIds()].toSorted((a, b) => a - b)
    const bindings = buildSensorTriggerBindings(configs)
    this.sensorRouter.setBindings(bindings)
    const after = [...bindings.keys()].toSorted((a, b) => a - b)
    if (before.length === after.length && before.every((id, i) => id === after[i])) return
    this.ctx.logger.info('recorder: sensor trigger index rebuilt', {
      meta: { sourceDeviceIds: after, cameras: configs.size },
    })
  }

  /**
   * Resume interrupted exports and arm the expiry sweep.
   *
   * The resume itself lives in `export-reconcile.ts` — pure, tested, and loud
   * about every row it moves. It used to be an untested loop inlined here that
   * said nothing at all, so "why is this export still queued an hour later" had
   * no answer in the log, and a row whose life had already run out was
   * re-rendered anyway. Both halves are best-effort: a failure never blocks
   * boot.
   */
  private async bootstrapExports(): Promise<void> {
    const engine = this.exportEngine
    if (!engine) return
    if (this.exportsRoot === null) {
      // Without the root the janitor's `outPath` throws INSIDE its try — rows
      // would flip to `expired` without their file being deleted, leaking the
      // bytes forever. Defer the whole bootstrap; the next boot with a
      // resolvable location runs it.
      this.ctx.logger.warn('recorder: exports bootstrap skipped — artifacts location unresolved')
      return
    }
    try {
      await reconcileInterruptedExports({
        state: this.exportsStore(),
        engine,
        now: () => Date.now(),
        logger: this.ctx.logger.child('export'),
      })
    } catch (err: unknown) {
      this.ctx.logger.warn('recorder: export boot re-queue failed', {
        meta: { error: errMsg(err) },
      })
    }
    if (this.exportSweepTimer === null) {
      const sweep = (): void => {
        this.logIndexCensus()
        void this.heapProbe
          .track({ kind: 'pass', name: 'export-expiry' }, () =>
            sweepExpiredExports(Date.now(), this.exportJanitorDeps()),
          )
          .catch((err: unknown) => {
            this.ctx.logger.warn('recorder: export expiry sweep failed', {
              meta: { error: errMsg(err) },
            })
          })
      }
      sweep()
      this.exportSweepTimer = setInterval(sweep, EXPORT_SWEEP_INTERVAL_MS)
      this.exportSweepTimer.unref?.()
    }
  }

  /**
   * What the RAM index is actually holding, on the 5-minute cadence the
   * `[mem]` heartbeat already samples on.
   *
   * `RecordingIndex` has exposed `sortedViewStats` and `hydrateReuseStats`
   * since the churn work and NOTHING has ever read them — so the two numbers
   * that would have told us where the recorder's heap goes have never appeared
   * in a log line. Production on 2026-08-29 reads ~490 MB in
   * `large_object_space`, stable across four samples five minutes apart
   * (retained, not churn) against 110 MB on hub-main; the sorted views are the
   * shape that lands there, and `rowSlots × 8 B` is the arithmetic that either
   * accounts for it or rules it out.
   *
   * `tags: { deviceId }` names the camera with the LARGEST view, because
   * "which camera" is the only form the follow-up question ever takes. Absent
   * when nothing is materialised — a device id of 0 is not a camera.
   */
  private logIndexCensus(): void {
    const census = this.index.sortedViewCensus()
    const views = this.index.sortedViewStats()
    const reuse = this.index.hydrateReuseStats()
    const residency = this.index.residency()
    this.ctx.logger.info('recorder: index census', {
      ...(census.largestDeviceId > 0 ? { tags: { deviceId: census.largestDeviceId } } : {}),
      meta: {
        // What the index HOLDS against what it is allowed to hold. A null
        // budget means nobody armed it — an index that cannot evict, which is
        // the state this addon must never reach past `onInitialize`.
        residentRows: residency.residentRows,
        residentHours: residency.residentHours,
        rowBudget: residency.budget?.residentRowBudget ?? null,
        evictedRows: residency.evictedRows,
        evictedHours: residency.evictedHours,
        evictionPasses: residency.evictionPasses,
        sortedViews: census.views,
        // × 8 B is the array allocation; the rows themselves are held once in
        // `byDevice` whether a view points at them or not.
        rowSlots: census.rowSlots,
        largestViewRows: census.largestRows,
        fullRebuilds: views.fullRebuilds,
        incrementalInserts: views.incrementalInserts,
        rowsReused: reuse.rowsReused,
        rowsAllocated: reuse.rowsAllocated,
        ledgerHours: this.segmentHours?.snapshot().length ?? 0,
        // Every other long-lived container this runner holds, as entry counts
        // (the mfra figure also as an estimated byte total). The heap builds
        // ~2.3 GB in one phase after boot and the index above is < 1 % of it;
        // if these together are a small fraction too, the retainer is outside
        // the recorder's own fields — which is itself the answer. `null` = the
        // owner does not exist in this runner yet, never an empty container.
        calendar: this.calendarInstance?.memoryCensus() ?? null,
        mfra: this.mfraTables.memoryCensus(),
        ledger: this.segmentHours?.memoryCensus() ?? null,
        placement: this.placement?.memoryCensus() ?? null,
        exports: this.exportEngine?.memoryCensus() ?? null,
        controller: this.controller?.memoryCensus() ?? null,
      },
    })
  }

  /**
   * One-time boot cleanup of the retired sprite-sheet scrub-thumbnail dirs
   * (`<locationRoot>/.thumbs`). Scrub previews now use the WebCodecs keyframe
   * packs + the on-demand still route, so the sheets are dead weight on the
   * recordings share. Best-effort per location — a failed rm just retries next
   * boot; a missing dir is a no-op.
   */
  private async cleanupLegacyThumbsDirs(): Promise<void> {
    const LEGACY_THUMBS_SUBDIR = '.thumbs'
    for (const loc of this.resolvedLocations) {
      const dir = path.join(loc.root, LEGACY_THUMBS_SUBDIR)
      try {
        await fs.rm(dir, { recursive: true, force: true })
        this.ctx.logger.info('recorder: removed legacy scrub-thumbnail dir', {
          meta: { dir },
        })
      } catch (err: unknown) {
        this.ctx.logger.debug('recorder: legacy thumbs cleanup skipped', {
          meta: { dir, error: errMsg(err) },
        })
      }
    }
  }

  /**
   * Still request handler: `GET /<deviceId>/<epochSec>` → `image/jpeg` (the
   * frame nearest the instant in the LOW recording) | 204 (no footage covers
   * the instant / decode produced nothing) | 400 (bad path) | 500. A fully-past
   * segment yields an immutable-cacheable still; the still-open live edge is
   * `no-store`.
   */
  private async serveStill(
    service: StillFrameService,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const m = /^\/(\d+)\/(\d+)$/.exec(req.url?.split('?')[0] ?? '')
    if (!m) {
      res.writeHead(400).end()
      return
    }
    const deviceId = Number(m[1])
    const epochMs = Number(m[2]) * 1000
    try {
      const built = await service.getStill(deviceId, epochMs)
      if (!built) {
        res.writeHead(204).end()
        return
      }
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'content-length': built.jpeg.byteLength,
        'cache-control': built.immutable ? 'private, max-age=31536000, immutable' : 'no-store',
      })
      res.end(built.jpeg)
    } catch (err: unknown) {
      this.ctx.logger.warn('still request failed', {
        tags: { deviceId },
        meta: { epochMs, error: errMsg(err) },
      })
      res.writeHead(500).end()
    }
  }

  /**
   * Re-resolve recordings locations (rescanStorage picks up newly-added disks),
   * apply the same-root alias guard, and forget every cached volume verdict —
   * a remount is exactly the event the mount probe exists to catch, so a stale
   * "verified" must not survive a re-resolve.
   */
  private async refreshLocations(): Promise<readonly RecordingsLocation[]> {
    const resolved = await resolveRecordingsLocations(this.ctx.api, this.ctx.logger)
    const guarded = demoteWritableAliasConflicts(resolved)
    for (const conflict of guarded.conflicts) {
      this.ctx.logger.error(
        'recorder: two WRITABLE recordings locations of the same type share one physical root — ' +
          'hydrate can only attribute segments to the lexicographically-first alias, so the others ' +
          'are DEMOTED to read-only for placement. Point them at distinct disks or delete one.',
        {
          meta: {
            type: conflict.type,
            root: conflict.root,
            keptLocationId: conflict.keptId,
            demotedLocationIds: conflict.demotedIds,
          },
        },
      )
      this.emitPlacementAlert({
        locationId: conflict.keptId,
        reason: 'shared-root',
        detail: `Storage locations ${[conflict.keptId, ...conflict.demotedIds].join(', ')} all resolve to ${conflict.root}. Only ${conflict.keptId} will be written to.`,
      })
    }
    this.resolvedLocations = guarded.locations
    this.placement?.onLocationsChanged()
    return this.resolvedLocations
  }

  /**
   * ONE hour bucket's segment files, location-relative — the recorder's single
   * implementation of {@link HourLister} (D523).
   *
   * The directory is the authority for WHICH segments exist, and the segment
   * NAME carries start, duration and bytes, so this is a complete description
   * of the hour and no file is ever opened.
   *
   * Three answers, and the difference between the last two is the whole point:
   *
   *  - `null` — **undecided.** The location does not resolve, may not be read,
   *    or the read failed for a reason that is not "this directory is not
   *    there". Every caller turns it into "this hour takes no part in this
   *    pass".
   *  - `[]` — **the hour holds nothing**, and the volume confirmed it: an
   *    ENOENT on the hour directory is only reported as empty once the
   *    location's ROOT has answered a read. A root that has gone away answers
   *    ENOENT for every hour on it, and reporting that as "empty" is how a pass
   *    deletes an operator's index of real footage (D148, D393).
   *  - the paths.
   */
  private async listHourDirectory(
    locationId: string,
    deviceId: number,
    profile: string,
    hourStartMs: number,
  ): Promise<readonly string[] | null> {
    const location = this.resolvedLocations.find((l) => l.id === locationId)
    if (location === undefined || !locationMayBeRead(location)) return null
    const rel = hourDirRelPath(deviceId, profile, hourStartMs)
    try {
      const files = await fs.readdir(path.join(location.root, rel))
      return files.filter((f) => f.endsWith('.m4s')).map((f) => `${rel}/${f}`)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.ctx.logger.warn('recorder: hour directory read failed — this hour decides nothing', {
          tags: { deviceId },
          meta: { profile, locationId, hourStartMs, error: errMsg(err) },
        })
        return null
      }
      try {
        await fs.readdir(location.root)
      } catch {
        this.ctx.logger.warn(
          'recorder: hour directory is absent AND its location root cannot be read — this hour decides nothing',
          { tags: { deviceId }, meta: { profile, locationId, root: location.root, hourStartMs } },
        )
        return null
      }
      return []
    }
  }

  /**
   * Attach-boundary placement for one (device, profile). Falls back to the pure
   * resolver when the service is not built (non-recording node / early boot),
   * which is byte-identical to the pre-placement behaviour.
   */
  private placeProfile(deviceId: number, profile: CamProfile): Promise<RecordingsLocation> {
    if (this.placement) return this.placement.place(deviceId, profile)
    return Promise.resolve(resolvePlacement(this.resolvedLocations, profile))
  }

  /**
   * Re-plan placement for the devices the controller tick is converging, over
   * every profile each of them has footage for **in the archive**.
   *
   * The work set comes from the durable hour ledger, never from the RAM index.
   * It used to read `index.accountingByProfile(deviceId).keys()`, and its doc
   * comment claimed "every profile each of them actually has footage for" —
   * true before D287, and a leftover after it: the index now holds the live
   * tail plus whatever a reader hydrated, so a camera nobody has viewed since
   * boot contributes no profiles at all. That camera was then never re-planned
   * — its stored assignment simply stood, which is half of how two of thirteen
   * cameras were left writing to the disk the fleet was migrating off — and,
   * because the pass REPLACED the whole durable record with the plan, its
   * assignment was deleted outright on the next tick that changed anything
   * (D299). The write is a merge now; this is the other half.
   *
   * An empty work set means "the archive knows nothing about these cameras",
   * which is also what a ledger that failed to load says. It plans NOTHING —
   * and says so once per episode rather than once per 30 s tick.
   */
  private async recomputePlacement(deviceIds: readonly number[]): Promise<void> {
    if (!this.placement) return
    // The convergence half of D387, on the pass that already runs on a timer:
    // a dropped `StorageLocationsChanged` costs latency, never blindness.
    // Ahead of the plan, so a location added since the last pass is planned
    // over in THIS one rather than the next.
    await (this.locationRefresher?.convergeIfDue() ?? Promise.resolve())
    const archive = this.segmentHours
    if (!archive) {
      // D295: a missing archive REFUSES; it does not fall back to the index.
      // Planning from residency is how a cold camera silently loses its place.
      this.reportPlacementWorkGap('no segment-hour ledger on this node', deviceIds.length, 0)
      return
    }
    const byDevice = archive.profilesWithFootage(new Set(deviceIds))
    const work: PlacementWorkItem[] = []
    for (const deviceId of deviceIds) {
      for (const profile of byDevice.get(deviceId) ?? []) {
        if (profile === 'high' || profile === 'mid' || profile === 'low') {
          work.push({ deviceId, profile })
        }
      }
    }
    if (work.length === 0) {
      this.reportPlacementWorkGap(
        'the archive knows no hour for any of them',
        deviceIds.length,
        archive.snapshot().length,
      )
      return
    }
    this.placementWorkGap = null
    const plan = await this.placement.recompute(work)
    this.reportPendingWriterMoves(plan.assignments)
  }

  /**
   * Cameras whose plan says one disk and whose live writer says another —
   * REPORTED, per camera, for as long as it stands (D387).
   *
   * Placement applies at attach boundaries only, so a re-planned camera moves
   * when it next attaches. A camera on a schedule attaches again within
   * minutes; a CONTINUOUSLY recording one never does, and its plan can sit
   * unapplied forever. Repointing a live writer is not the fix — the
   * `.rec-tmp` staging dir lives under the chosen root precisely so the
   * finalize relocate is a same-filesystem rename — and detaching the fleet to
   * apply a plan costs a recording gap on every affected camera at once, on
   * the very day the operator added a disk to relieve pressure. So the honest
   * behaviour is to say it, name the cameras, and let the operator decide.
   *
   * Latched on WHAT is pending: a line per 30 s tick would be its own defect.
   */
  private reportPendingWriterMoves(planned: ReadonlyMap<string, string>): void {
    const controller = this.controller
    if (!controller) return
    const moves = pendingWriterMoves(controller.activeWriterDirs(), planned, this.resolvedLocations)
    const signature = pendingMovesSignature(moves)
    if (signature === this.pendingWriterMoves) return
    this.pendingWriterMoves = signature
    this.writerRestartAlerts().update(moves)
    if (moves.length === 0) return
    for (const move of moves) {
      this.ctx.logger.warn(
        'recorder placement: this camera is PLANNED for another location and its writer will not move until it next attaches',
        {
          tags: { deviceId: move.deviceId },
          meta: {
            profile: move.profile,
            writingTo: move.writingTo,
            plannedFor: move.plannedFor,
            hint: 'a continuously-recording camera never re-attaches on its own — toggle its recording switch, or restart the recorder, to apply the plan (each costs one gap on that camera)',
          },
        },
      )
    }
  }

  /**
   * A placement pass that plans NOTHING says so — once per episode.
   *
   * A branch that drops work silently reads as "it never happened", and this
   * one drops the whole pass. A line per 30 s tick would be its own defect on
   * an idle node, so it is latched on the reason: the episode is announced when
   * it starts and again only if the reason changes.
   */
  private reportPlacementWorkGap(reason: string, devices: number, ledgerHours: number): void {
    if (this.placementWorkGap === reason) return
    this.placementWorkGap = reason
    this.ctx.logger.info('recorder: placement pass planned nothing', {
      meta: { reason, devices, ledgerHours },
    })
  }

  /**
   * The plan in force plus each write target's headroom, for the operator-armed
   * rebalance (D116, Phase 2). Both come from the SAME `PlacementService` the
   * 30 s tick plans with: a rebalance computed against a second idea of "what
   * fits" would plan moves the next tick undoes.
   *
   * Throws when placement is not active (a non-recording node, or early boot) —
   * the rebalance is an operator action and a silent empty plan would read as
   * "nothing to do".
   */
  private async placementSnapshot(): Promise<PlacementSnapshot> {
    const placement = this.placement
    if (!placement) throw new Error('placement is not active on this node')
    const [assignments, candidates] = await Promise.all([
      placement.currentAssignments(),
      placement.candidates(),
    ])
    return {
      assignments,
      // A location whose capacity is UNMEASURABLE (`headroomBytes: null`) is
      // omitted, not zeroed: `planRebalance` skips a target with no headroom
      // entry (`target-not-writable`), which is the right answer for a disk
      // nobody could measure — and a zero would have read as "full".
      headroom: candidates.flatMap((candidate) =>
        candidate.headroomBytes === null
          ? []
          : [{ locationId: candidate.locationId, headroomBytes: candidate.headroomBytes }],
      ),
    }
  }

  /**
   * Measured bytes/day for one (camera, profile) — the demand signal the
   * placement planner weights against each location's headroom. Derived from
   * the index's own accounting (segment paths encode bytes + start), so it
   * costs one pass over the device's rows and no disk I/O.
   *
   * The span is floored at an hour: a camera that started recording five
   * minutes ago would otherwise extrapolate to an absurd daily rate and drag
   * the whole plan around. Zero (nothing indexed yet) is a legitimate answer —
   * the planner reads an all-zero demand set as "balance by count".
   */
  private dailyBytesFor(deviceId: number, profile: CamProfile): number {
    const acct = this.index.accountingByProfile(deviceId).get(profile)
    if (!acct || acct.bytes === 0 || acct.oldestMs === null || acct.newestMs === null) return 0
    const spanMs = Math.max(HOUR_MS, acct.newestMs - acct.oldestMs)
    return (acct.bytes / spanMs) * DAY_MS
  }

  /**
   * Forget every stored assignment. Called after a storage MIGRATION, which
   * moves footage between roots and leaves every assignment describing a layout
   * that no longer exists. The next placement pass plans from scratch; until it
   * runs, `place` falls back to the pure resolver, which is exactly what an
   * unassigned camera already does.
   */
  private async resetPlacementPlan(): Promise<void> {
    try {
      const store = this.placementStore()
      // Read the blob so the write preserves the remembered volume ids: a
      // migration invalidates every ASSIGNMENT, not the claim on each volume.
      const blob = await readPlacementState(store)
      // The one caller that legitimately REPLACES the fleet-wide record: it is
      // clearing all of it on purpose, and it names no work set.
      await replaceAssignments(store, blob, new Map())
      this.ctx.logger.info('recorder: placement plan reset after storage migration')
    } catch (err: unknown) {
      this.ctx.logger.warn('recorder: placement plan reset failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * Boot sweep for a previous runner's writers (D667): every foreign ffmpeg
   * writing under any location's `.rec-tmp`, whether or not its camera will be
   * attached again. On re-entry (`onHubReachable` again) the controller's own
   * writers are live and excluded by pid.
   */
  private async reapPredecessorWriters(): Promise<boolean> {
    const guard = this.stagingGuard
    // No table is not proof of a quiet staging tree. Recording remains
    // fail-open on unsupported platforms, but recovery/deletion must not move
    // a file an unseen predecessor may still have open.
    if (guard === null) return false
    const result = await guard.sweep({
      roots: this.resolvedLocations.map((location) => location.root),
      deviceId: null,
      ownPids: this.controller?.ownedWriterPids() ?? new Set<number>(),
    })
    if (result.outcome === 'unverified') {
      this.ctx.logger.warn(
        'recorder: staging mutation skipped at boot — the predecessor-writer sweep was unverified',
        {
          meta: { roots: this.resolvedLocations.map((location) => location.root) },
        },
      )
      return false
    }
    if (result.refused.length === 0) return true
    this.ctx.logger.warn(
      'recorder: staging mutation skipped at boot — a known predecessor writer remains',
      {
        meta: {
          refused: result.refused.length,
          roots: this.resolvedLocations.map((location) => location.root),
        },
      },
    )
    return false
  }

  /**
   * Collect what a reaped writer left in one staging directory, before the
   * controller spawns a new writer there (D667). The reaped writer's playlist
   * is NOT consulted: it names that writer's last entries, and nobody is left
   * to finalize them.
   */
  private async recoverReapedDirectory(
    input: ReapedDirectoryRecovery,
  ): Promise<ReapedDirectoryReport> {
    const report = await recoverStagingOrphans(
      input.dir,
      {
        writerStartedMs: input.cutoffMs + REAPED_RECOVERY_SKEW_MS,
        segmentSeconds: input.segmentSeconds,
      },
      {
        listDir: nodeStagingIo.listDir,
        readPlaylist: async () => null,
        finalize: async (orphan, absPath) => {
          const store = this.segmentStore
          if (store === null) throw new Error('recorder is shutting down')
          await store.onFinalized({
            deviceId: input.deviceId,
            profile: input.profile,
            locationId: input.locationId,
            locationRoot: input.locationRoot,
            flatAbsPath: absPath,
            startMs: orphan.startMs,
            durMs: orphan.durMs,
          })
        },
        logger: this.ctx.logger.withTags({ deviceId: input.deviceId }),
        shouldStop: () => this.segmentStore === null,
      },
    )
    return { found: report.found, recovered: report.recovered, failed: report.failed }
  }

  /**
   * Boot sweep: remove the `.rec-tmp` staging tree from every recordings root
   * NOTHING is assigned to any more. Staging lives under the placement root, so
   * a root that has just been drained, opted out or deleted from the plan keeps
   * a tree of orphaned partial segments that no watcher will ever finalize and
   * no retention pass will ever see (`.rec-tmp` is invisible to the hydrate
   * walk by design). Same shape as the `.scrub-packs` sweep above.
   *
   * Only roots with ZERO assignments are touched, and only on the boot chain,
   * after orphan recovery. The placement read happens here, after the
   * controller has attached, so any root a new writer uses is named by an
   * assignment and cannot be swept.
   */
  private async sweepUnassignedStaging(): Promise<void> {
    let assigned: ReadonlySet<string>
    try {
      const blob = await this.placementStore().get()
      assigned = new Set(Object.values(blob.assignments))
    } catch (err: unknown) {
      // A fallible read never destroys work (D49): sweeping on a failed read
      // would delete staging for every root, including the live one.
      this.ctx.logger.warn('recorder: staging sweep skipped — placement read failed', {
        meta: { error: errMsg(err) },
      })
      return
    }
    if (assigned.size === 0) return
    for (const location of this.resolvedLocations) {
      if (assigned.has(location.id)) continue
      const staging = path.join(location.root, STAGING_DIR_NAME)
      try {
        await fs.rm(staging, { recursive: true, force: true })
      } catch (err: unknown) {
        this.ctx.logger.warn('recorder: staging sweep failed for unassigned location', {
          meta: {
            locationId: location.id,
            root: location.root,
            error: errMsg(err),
          },
        })
        continue
      }
      this.ctx.logger.info('recorder: swept orphaned staging on an unassigned location', {
        meta: { locationId: location.id, staging },
      })
    }
  }

  /**
   * Boot reconcile for `.rec-tmp`: relocate every segment a previous runner's
   * writers left stranded, on every location, for every camera.
   *
   * The counterpart to {@link sweepUnassignedStaging} above, which only ever
   * looks at locations nothing is assigned to — so the LIVE root, the one that
   * actually accumulates, had no pass at all (D148). Nothing here deletes: each
   * orphan goes through the same `SegmentStore.onFinalized` a live segment
   * does, and one it cannot place is left on disk for the next boot.
   */
  private async recoverStagedOrphans(bootMs: number): Promise<void> {
    try {
      await recoverAllStagedOrphans({
        locations: () => this.resolvedLocations.map((l) => ({ id: l.id, root: l.root })),
        listDir: nodeStagingIo.listDir,
        readPlaylist: nodeStagingIo.readPlaylist,
        finalize: async (input) => {
          // Re-read every time: `onStop` nulls the store, and that is also the
          // shutdown signal below. Never cache it across the pass.
          const store = this.segmentStore
          if (store === null) throw new Error('recorder is shutting down')
          await store.onFinalized(input)
        },
        logger: this.ctx.logger,
        bootMs,
        // The same rule the controller applies when it spawns a writer
        // (`config.segmentSeconds ?? deps.segmentSeconds`), so a recovered
        // segment's fallback duration matches what actually wrote it. ONE
        // read of the config map for the whole pass — a failed read falls
        // back to the addon default for every device, exactly what the old
        // per-device catch did.
        segmentSecondsByDevice: async () => {
          const out = new Map<number, number>()
          try {
            for (const [id, config] of await readDeviceConfigs(this.configStore())) {
              if (config.segmentSeconds !== undefined) out.set(id, config.segmentSeconds)
            }
          } catch {
            /* fall through to defaults */
          }
          return out
        },
        defaultSegmentSeconds: this.config.segmentSeconds,
        // Shutdown nulls `segmentStore`; the pass re-reads this before every
        // segment and abandons the rest (which stay on disk for the next boot).
        shouldStop: () => this.segmentStore === null,
      })
      const stubs = this.segmentStore?.takeStubReport()
      if (stubs !== undefined && stubs.count > 0) {
        this.ctx.logger.info('recorder: staging recovery cleared stub segments', {
          meta: { count: stubs.count, bytes: stubs.bytes },
        })
      }
    } catch (err: unknown) {
      this.ctx.logger.warn('recorder: staging boot reconcile failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * Surface a storage-placement fault on the liveness/alert surface. STRICTLY
   * best-effort: the alerts cap is a nice-to-have and an unmounted disk must
   * still be shouted about in the log even when it is unreachable. One row per
   * (location, reason) episode - see `placement-alerts.ts`.
   */
  private emitPlacementAlert(input: PlacementAlert): void {
    this.placementAlerts().raise(input)
  }

  /** The faulted location passed its volume probe again: close its alert. */
  private resolvePlacementAlert(locationId: string): void {
    this.placementAlerts().resolve(locationId, 'unusable')
  }

  private placementAlertPublisher: PlacementAlertPublisher | null = null
  private writerRestartAlertSync: WriterRestartAlerts | null = null

  private writerRestartAlerts(): WriterRestartAlerts {
    this.writerRestartAlertSync ??= new WriterRestartAlerts(this.placementAlerts(), this.ctx.logger)
    return this.writerRestartAlertSync
  }

  private placementAlerts(): PlacementAlertPublisher {
    this.placementAlertPublisher ??= new PlacementAlertPublisher({
      port: {
        emit: (alert) => this.ctx.api.alerts.emit.mutate(alert),
        update: (input) => this.ctx.api.alerts.update.mutate(input),
      },
      logger: this.ctx.logger,
      sourceId: this.ctx.id,
      nodeId: this.nodeId,
      now: () => Date.now(),
    })
    return this.placementAlertPublisher
  }

  private async pauseForStorageMigration(leaseId: string): Promise<void> {
    if (this.storageMigrationLeaseId !== null && this.storageMigrationLeaseId !== leaseId) {
      throw new Error('recorder is already paused by another storage migration')
    }
    if (!this.controller)
      throw new Error('recorder controller is unavailable for storage migration')
    this.storageMigrationLeaseId = leaseId
    try {
      await this.controller.pause()
    } catch (err) {
      this.storageMigrationLeaseId = null
      throw err
    }
  }

  private async resumeForStorageMigration(leaseId: string): Promise<void> {
    if (this.storageMigrationLeaseId === null) return
    if (this.storageMigrationLeaseId !== leaseId) {
      throw new Error('recorder storage migration lease does not match')
    }
    try {
      await this.controller?.resume()
    } finally {
      this.storageMigrationLeaseId = null
    }
  }

  private async refreshStorageLocationsForMigration(leaseId: string): Promise<void> {
    if (this.storageMigrationLeaseId !== leaseId) {
      throw new Error('recorder storage migration lease does not match')
    }

    await this.refreshLocations()
    this.calendar.invalidateAll()
    // A migration moved footage between roots: every stored assignment now
    // describes a layout that no longer exists. Drop the plan so the next tick
    // re-derives it from scratch — restoring a cached plan here would re-point
    // writers at the location the operator just migrated AWAY from.
    await this.resetPlacementPlan()
  }

  private assertStorageMigrationLease(leaseId: string): void {
    if (this.storageMigrationLeaseId !== leaseId) {
      throw new Error('recorder storage migration lease does not match')
    }
  }

  /**
   * Resolve the cluster's camera-source owner. Graceful degrade: the
   * `pipeline-orchestrator` cap may not be mounted yet (pre-image-release),
   * in which case we fall back to `{ ownerNodeId: 'hub' }` — the same default
   * `getIngestOwner` itself returns absent an explicit `clusterRoles.ingestNode`,
   * so an unresolved owner is byte-identical to today's hub-only behaviour.
   */
  private async resolveIngestOwner(): Promise<IngestOwner> {
    try {
      return await this.ctx.api.pipelineOrchestrator.getIngestOwner.query()
    } catch (err: unknown) {
      this.ctx.logger.warn(
        'recorder: getIngestOwner unavailable — defaulting to hub (cap not mounted yet?)',
        { meta: { error: errMsg(err) } },
      )
      return { ownerNodeId: 'hub' }
    }
  }

  /**
   * Roots the playback data-plane handler searches, IN ORDER: `<dataDir>/playback`
   * FIRST (the freshly-written master/variant `.m3u8` playlists), then every
   * recordings location root (the segment `.m4s` files at
   * `<root>/<deviceId>/<profile>/Y/M/D/H/<file>`). Playlists-first matters: the
   * OLD recorder left stale `<recordingsRoot>/<deviceId>/master.m3u8` playlists
   * that would otherwise shadow ours; segments never collide (only `.m4s` live in
   * the location roots, only `.m3u8` in the playback dir), so the two form one
   * served tree with our playlists authoritative.
   */
  private playbackRoots(): readonly string[] {
    return [path.join(this.ctx.dataDir, 'playback'), ...this.resolvedLocations.map((l) => l.root)]
  }

  /**
   * Free + total bytes on a location's volume (`statfs`); null plus a reason
   * when the volume will not answer. The reason is NOT logged here — the caller
   * (`getStorageUsage`) knows which location the root belongs to and logs it
   * against that location.
   */
  private async locationCapacity(root: string): Promise<LocationCapacity> {
    return readLocationCapacity(root, (target) => fs.statfs(target))
  }

  /**
   * Global settings surfaced in the admin UI (and persisted to the addon
   * store). The cluster Recording tab drives `recordingNodeId` via a node
   * picker; `recordingHubHostname` is an advanced override for cross-node
   * pulls. Both are SHARED cluster keys (not perNode) hydrated into
   * `this.config` by `resolveConfig()` and take effect on addon restart
   * (read once in `onInitialize`).
   */
  protected override globalSettingsSchema(): ConfigUISchema | null {
    return this.schema({
      sections: [
        {
          id: 'cluster-recording',
          title: 'Cluster recording',
          titleKey: 'pipeline:globalSettings.s_cluster-recording.title',
          description:
            'Which node runs recording (continuous + events write path). A SINGLE node — no multi-node balancing; every other node stays fully inert. Default: hub.',
          descriptionKey: 'pipeline:globalSettings.s_cluster-recording.description',
          columns: 1,
          fields: [
            {
              type: 'text',
              key: 'recordingNodeId',
              label: 'Recording node',
              labelKey: 'pipeline:globalSettings.s_cluster-recording.recordingNodeId.label',
              description:
                'Node id that records + serves playback (e.g. "hub"). Leave "hub" unless you intentionally move recording to an agent. Takes effect on addon restart.',
              descriptionKey:
                'pipeline:globalSettings.s_cluster-recording.recordingNodeId.description',
              default: RECORDING_NODE_DEFAULT,
            },
            {
              type: 'text',
              key: 'recordingHubHostname',
              label: 'Hub host (cross-node)',
              labelKey: 'pipeline:globalSettings.s_cluster-recording.recordingHubHostname.label',
              description:
                "Advanced: only used when the recording node is an AGENT. The hub's host the agent dials to pull broker streams (the RTSP restream port must be reachable there). Leave empty to auto-derive from the agent's hub connection.",
              descriptionKey:
                'pipeline:globalSettings.s_cluster-recording.recordingHubHostname.description',
              default: '',
            },
          ],
        },
      ],
    })
  }

  /** Durable handle config-store reads/writes the deviceId→config blob on —
   *  the sanctioned `BaseAddon.state()` wrapper (same key, same blob shape;
   *  adds the read-retry budget + parse-warning logging over the raw slice). */
  /**
   * Fill TODAY's exact ranges, per camera, as background work.
   *
   * Deliberately the smallest useful prediction: the day the operator opens.
   * Anything wider was a bet that cost more than it bought.
   */
  private async warmToday(deviceIds: readonly number[]): Promise<void> {
    const now = Date.now()
    const started = now
    const liveHour = Math.floor(now / HOUR_MS) * HOUR_MS
    // The LIVE hour only. `warmDayRanges` of today+yesterday was 17 cameras ×
    // 48 hour-directory reads — 158 s on 2026-08-22 after the 1.2.109 deploy —
    // and it ran on the same FUSE share the scrub feeder was reading. The
    // operator's retry landed in that window: locate 3 ms, `segment read
    // timeout` on the .m4s. Hours the theater actually asks for are scanned
    // on demand via `rangesIn` (the overlapping hours, not a whole UTC day).
    for (const deviceId of deviceIds) {
      try {
        await hydrateWindowFromStorage(
          this.index,
          deviceId,
          liveHour,
          liveHour + HOUR_MS,
          this.resolvedLocations,
          this.ctx.logger,
          this.segmentHours ?? undefined,
        )
      } catch {
        // Best-effort: the first timeline poll still falls through to disk.
      }
    }
    this.ctx.logger.info('recorder: today warmed', {
      meta: { devices: deviceIds.length, ms: Date.now() - started, scope: 'live-hour' },
    })
  }

  /*
   * ## The deferred full-archive walk is GONE (2026-08-27)
   *
   * `scheduleDeferredFullWalk` had no caller — the operator path its own
   * comment promised was never built — so `runFullArchiveWalk`, the fleet
   * `hydrateDevicesFromStorage` and the post-walk redundancy janitor were all
   * unreachable with it. What it left behind was worse than nothing: a
   * 100-line block that DESCRIBED the right design, so a reader (and one
   * comment in `process-service.ts`) took it for something that runs, and the
   * 2 GB the recorder actually holds got attributed to code that never
   * executed.
   *
   * The window it was meant to fill is filled by other things: every read
   * self-hydrates the window it asks about (`hydrateWindowFromStorage`), the
   * per-device walk still exists (`hydrateDeviceFromStorage`, wired to
   * `rescanStorage`), and the hour ledger reseeds RAM at boot. Recover the
   * walk from git history if an operator-armed full reconcile is ever built —
   * and wire it in the same commit.
   */

  /**
   * Declare the remaining RowMapStore collection that replaced the
   * `recordingConfigs` blob key. Idempotent — a re-declaration of the same
   * shape is a no-op in the engine.
   *
   * `recorder:exports` and `recorder:ops-log` are now record kinds declared
   * via `ctx.records.declare(recorderRecordKinds)` at the top of
   * `onInitialize`.
   */
  private async declareRowCollections(): Promise<void> {
    await this.configStore().declare()
  }

  private configsState: RecordingConfigsState | null = null

  /** A camera's recording config — its per-device settings (D865), migrated on read. */
  private configStore(): RecordingConfigsState {
    const settings = this.ctx.settings
    if (settings === undefined) throw new Error('recorder: device settings are not available')
    this.configsState ??= recordingConfigsState({
      settings,
      logger: this.ctx.logger,
    })
    return this.configsState
  }

  /** Record kind handle over the `recorder` / `exports` kind (hub recording node only). */
  private exportsStore(): RecordingExportsState {
    return recordingExportsState(this.requireRecords())
  }

  /** Record kind handle over the `recorder` / `ops-log` kind (hub recording node only). */
  private opsLogStore(): RecordingOpsLogState {
    return recordingOpsLogState(this.requireRecords())
  }

  /**
   * Returns `ctx.records`, throwing clearly when it is absent.
   * Only called on the designated recording node (hub by default); an agent
   * exits before `onInitialize` reaches any store call.
   */
  private requireRecords() {
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error(
        'recorder (recording node) needs ctx.records — recording node must be the hub',
      )
    }
    return records
  }

  /** Durable handle over the recorder-owned placement blob (assignments + volume ids). */
  private placementStore(): RecordingPlacementState {
    return this.state(RECORDING_PLACEMENT_KEY, RecordingPlacementBlobSchema, EMPTY_PLACEMENT)
  }

  /** The artifacts class ROOT, or a NAMED refusal — never an invented path.
   *  Every export-side path (MP4s, playlists, render scratch) derives from it
   *  through `exportTenantDirFor` → `<root>/<deviceId>/exports/…`, beside
   *  (never inside) the notification shelf's `<root>/<deviceId>/nc-artifacts/…`
   *  sibling (D341). No consumer joins the path a second way. */
  private exportsDirOrThrow(): string {
    const root = this.exportsRoot
    if (root === null) {
      throw new Error(
        'artifacts storage location is not resolved — exports and footage renders refuse rather than fall back to the addon data dir',
      )
    }
    return root
  }

  /** Retention deps shared by the sweep and the download-complete hook. */
  private exportJanitorDeps(): ExportJanitorDeps {
    return {
      state: this.exportsStore(),
      outPath: (rec) => exportOutPathFor(this.exportsRoot, rec.deviceId, rec.id),
      removeFile: async (p) => {
        await fs.rm(p, { force: true })
      },
    }
  }

  /** Emit an export telemetry event through the addon event bus (untyped
   *  category — the export categories are telemetry, not in the typed catalog). */
  private emitExportEvent(category: EventCategory, data: Record<string, unknown>): void {
    const source: EventSource = {
      type: 'addon',
      id: RECORDER_ADDON_ID,
      nodeId: this.nodeId,
    }
    this.ctx.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source,
      category,
      data,
    })
  }

  /**
   * Absolute on-disk path for a scrub segment row. Mirrors the playback path
   * resolution exactly: the file playback serves for `row.path` lives at
   * `<root for row.locationId>/<row.path>` (same `rootById` lookup the playback
   * manifest uses). The scrub packs read the SAME source segments as playback.
   */
  private resolveSegmentAbsPath(row: LowSegmentRow): string {
    const loc = requireReadableLocation(this.resolvedLocations, row.locationId, 'recorder scrub')
    return path.join(loc.root, row.path)
  }

  /**
   * Dedicated export MP4 download handler. Resolves `<exportId>.mp4` to a `ready`
   * row's file (traversal-guarded by the id regex + the exact stored path),
   * streams it with HTTP `Range`, and — when the FINAL byte of a full-file GET is
   * flushed — records the download so `deleteAfterDownload` can reclaim the file.
   */
  private async serveExportDownload(
    state: RecordingExportsState,
    outPath: (rec: ExportRecord) => string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/'
    const match = EXPORT_FILENAME_RE.exec(urlPath.replace(/^\/+/, ''))
    if (!match) {
      res.writeHead(404).end()
      return
    }
    const exportId = match[1]!
    const rec = await getExportRecord(state, exportId)
    if (!rec || rec.state !== 'ready') {
      res.writeHead(404).end()
      return
    }
    let absPath: string
    try {
      absPath = outPath(rec)
    } catch {
      // The exports location is not resolved — refusal, not absence (D341).
      res.writeHead(503).end()
      return
    }
    let size: number
    try {
      const st = await fs.stat(absPath)
      if (!st.isFile()) {
        res.writeHead(404).end()
        return
      }
      size = st.size
    } catch {
      res.writeHead(404).end()
      return
    }

    const baseHeaders: Record<string, string> = {
      'content-type': contentTypeFor(absPath),
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
    }
    const range = parseRangeHeader(req.headers.range, size)
    // The download counts as complete once the final byte is delivered: a full
    // GET, or a range whose end reaches the last byte.
    const servesFinalByte = range ? range.end === size - 1 : true
    const recordDownloadOnFinish = (): void => {
      if (req.method !== 'GET' || !servesFinalByte) return
      res.once('finish', () => {
        void markDownloaded(
          exportId,
          Date.now(),
          this.exportJanitorDeps(),
          (fn, ms) => {
            const t = setTimeout(fn, ms)
            t.unref?.()
          },
          EXPORT_DELETE_GRACE_MS,
        ).catch((err: unknown) => {
          this.ctx.logger.warn('recorder: markDownloaded failed', {
            meta: { exportId, error: errMsg(err) },
          })
        })
      })
    }

    if (range) {
      res.writeHead(206, {
        ...baseHeaders,
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
        'content-length': String(range.end - range.start + 1),
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      recordDownloadOnFinish()
      createReadStream(absPath, { start: range.start, end: range.end }).pipe(res)
      return
    }
    res.writeHead(200, { ...baseHeaders, 'content-length': String(size) })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    recordDownloadOnFinish()
    createReadStream(absPath).pipe(res)
  }
}
