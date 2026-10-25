/**
 * recorder recording controller — the B2 continuous-band write path.
 *
 * Owns, per (deviceId, profile), the lifecycle of:
 *   - a broker stream lease (`getStreamWithCodec`, released on detach),
 *   - an ffmpeg `SegmentWriter` (passthrough segmenter into a temp outDir),
 *   - a `live.m3u8` `SegmentWatcher` that hands each finalized flat segment to
 *     the v2 `SegmentStore.onFinalized` (stat + relocate + index).
 *
 * Per device it decides whether the active band demands recording right now
 * (`shouldRecordAt`) and ensures the writer set is running iff so. Convergence
 * is EVENT-DRIVEN; the periodic pass is a backstop, not the mechanism:
 *   1. `setDeviceConfig` (operator changed the bands / enable) — an RPC,
 *   2. a qualifying motion/audio trigger (`onTrigger`) — opens a window,
 *   3. a per-device WAKE-UP armed for the exact instant the decision could
 *      change on its own (`decision-schedule.ts` + `device-wakeups.ts`): an
 *      `events` window closing at `lastTrigger + postBufferSec`, or a band edge,
 *   4. a `stream-broker` ready transition (boot restore — via `ReadinessRestore`),
 *   5. the periodic RECONCILE (below), for everything the four above can lose.
 *
 * (3) is why a detach is now punctual. A trigger only ever OPENED a window — the
 * demand test is a sliding `atMs - lastMotionMs <= postMs` anchored on the LAST
 * trigger, so nothing called `evaluateDevice` at the moment it closed and the
 * detach waited for the next pass. A 4K camera stayed dialled, decoded and
 * written for up to a whole tick past the operator's `postBufferSec`.
 *
 * There are THREE periodic passes, each on its own timer and each non-overlapping
 * (`periodic-pass.ts`):
 *   - LIVENESS ({@link LIVENESS_TICK_MS}) — cheap, in-memory: is a pinned writer
 *     producing nothing?
 *   - PLACEMENT ({@link PLACEMENT_TICK_MS}) — cheap (a statfs per location), and
 *     deliberately NOT on the attach beat, so a cold broker cannot delay it.
 *   - RECONCILE ({@link RECONCILE_TICK_MS}) — the only one that can touch the
 *     broker, and the only backstop for a lost wake-up or a failed attach.
 *
 * They were ONE pass until 2026-08-13, when a convergence sweep wedged on
 * unbounded broker RPCs and took the liveness watchdog down with it for 9-27
 * minutes at a time; placement was split out of the second on 2026-08-18, after
 * a converge pass blocked for 60 001 ms (3 x {@link ATTACH_RPC_TIMEOUT_MS})
 * cold-dialling ~40 RTSP sources.
 *
 * EVENTS bands are treated as "not recording continuously" in B2 — B3 adds
 * trigger-gating. The enable intent is persisted in durable-state by the
 * config-store, so `restoreEnabledDevices` on boot re-attaches every device
 * whose persisted config records continuously now.
 *
 * Source acquisition rides the broker's single source dial: the controller
 * gates each broker call on the broker's readiness via the cached capability
 * handle (`useCapability(...).call(fn)`) — no bespoke retry/backoff, the
 * `ReadinessRegistry` is the single source of truth.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  type AddonApi,
  BatteryStatusSchema,
  batteryCapability,
  type CamProfile,
  DEFAULT_EVENTS_BAND_BUFFER_SEC,
  DeviceFeature,
  errMsg,
  EventCategory,
  type FirstLevelMacroClass,
  type ICapabilityHandle,
  type IScopedLogger,
  nodePin,
  type PinnedFfmpegResolver,
  type ReadinessScope,
  type RecordingBand,
  type RecordingBandAudio,
  type RecordingConfig,
  resolveRecordingProfiles,
  selectAssignedProfileSlots,
} from '@camstack/types'
import { NO_COST_CLAIM, type ChildCostRegistry } from '@camstack/types/node'
import {
  RECORDING_PRE_ROLL_REQUEST_MS,
  withRecordingIntent,
} from '../../stream-broker/rtsp/restream-intent.js'
import { activeBandAt } from '../band-engine.js'
import type { SegmentStore } from '../segment-store.js'
import {
  type AttachWindow,
  audioLevelQualifies,
  bandTriggerSources,
  effectiveBands,
  EMPTY_TRIGGER_STATE,
  eventsBandCanEverDemand,
  FIRST_SEGMENT_GRACE_MS,
  foldDurableTriggers,
  heldSinceMs,
  holdTrigger,
  MAX_TRIGGER_WINDOWS,
  pruneTriggerHistory,
  recordTrigger,
  releaseTrigger,
  resolveBandBufferMs,
  segmentMissedByMs,
  segmentRetainedForEvents,
  shouldRecordAt,
  TRIGGER_HISTORY_MARGIN_MS,
  triggerKey,
  triggerWindowsFor,
  type TriggerSource,
  type TriggerState,
  bandAudioAt,
} from './band-decision.js'
import { wakeForRecording, wakeOutcomeLosesFootage } from './battery-wake.js'

export type { TriggerSource } from './band-decision.js'

import { nextDecisionChangeAt } from './decision-schedule.js'
import { DeviceWakeups } from './device-wakeups.js'
import { type PeriodicPassHandle, startPeriodicPass } from './periodic-pass.js'
import { RESTORE_DRAIN_CONCURRENCY, ReadinessRestore, runBounded } from './readiness-restore.js'
import { type RecordingsLocation, resolvePlacement } from './roots.js'
import {
  type DrainedPlaylist,
  type MissedSegments,
  PREVIOUS_RUN_SKEW_MS,
  type SegmentWatcherHandle,
  startSegmentWatcher,
} from './segment-watcher.js'
import { SegmentWriter, type SegmentWriterDeps } from './segment-writer.js'
import { SpawnPressureGovernor } from './spawn-pressure.js'
import type { ReapedWriter, StagingWriterGuard } from './staging-writer-guard.js'
import type { HeapDeltaTracker } from './heap-delta.js'
import { withDeadline } from './with-deadline.js'
import { RecordingStallMonitor } from './recording-stall-monitor.js'

/** Spawn surface the SegmentWriter needs — injected so tests stay process-free. */
export type SpawnFn = SegmentWriterDeps['spawn']

/** Dependencies the controller composes (all injected; nothing global). */
export interface RecordingControllerDeps {
  readonly api: AddonApi
  readonly logger: IScopedLogger
  readonly nodeId: string
  /** The cluster's camera-source owner node (`pipelineOrchestrator.getIngestOwner`).
   *  Every `stream-broker` call the controller makes is pinned to this node —
   *  the broker only ever runs there. Defaults to `'hub'` at the call site
   *  (see `recorder/addon/index.ts`), so an unresolved owner is byte-identical
   *  to today's hub-only behaviour. */
  readonly ownerNodeId: string
  readonly segmentStore: SegmentStore
  /** Load the persisted config for one device (bands materialized). */
  readonly loadConfig: (deviceId: number) => Promise<RecordingConfig>
  /** Enumerate every device id that has a persisted config (boot restore seed). */
  readonly enabledDeviceIds: () => Promise<readonly number[]>
  /**
   * DURABLE motion timestamps for one device in `[sinceMs, untilMs]` — the RPC
   * half of D8/D11's "an event plus an RPC reconcile".
   *
   * `onTrigger` is fed by the event bus, which is telemetry and may be dropped.
   * What it feeds is not: a trigger window the keep gate never learned about
   * means every segment of that episode is unlinked, and footage deleted is
   * gone. So the windows are rebuilt on the reconcile beat from the analytics
   * store's persisted motion rows, which the bus cannot lose.
   *
   * Absent → no reconcile, byte-identical to the pre-2026-08-20 behaviour (and
   * the shape every controller test that does not care uses). A failure inside
   * it is absorbed: the fast path is unaffected and the next beat retries.
   */
  readonly loadMotionEvents?: (
    deviceId: number,
    sinceMs: number,
    untilMs: number,
  ) => Promise<readonly number[]>
  /**
   * DURABLE object-detection timestamps for one device and ONE macro class in
   * `[sinceMs, untilMs]` — the same D8/D11 half as {@link loadMotionEvents},
   * for `RecordingTriggers.objectClasses`.
   *
   * One class per call because `TriggerState` keys per class: a band listening
   * for `person` must not have its windows widened by a vehicle, and the store
   * already filters server-side (`getObjectEvents.classFilter`).
   *
   * The implementation MUST return only `source: 'pipeline'` rows — the live
   * path refuses `onboard` (see `recorder/object-trigger.ts`), and a reconcile
   * that folded them would re-open, from SQL, precisely the windows the live
   * gate declined.
   *
   * Absent → no object reconcile, byte-identical to the event-only path.
   */
  readonly loadObjectEvents?: (
    deviceId: number,
    macroClass: FirstLevelMacroClass,
    sinceMs: number,
    untilMs: number,
  ) => Promise<readonly number[]>
  /**
   * The camera's own `recording-signal` LEVEL, read back through RPC
   * (`deviceState.getCapSlice`) — the reconcile half of D8/D11 for
   * `RecordingTriggers.deviceSignal`.
   *
   * `null` = the device publishes no such slice (the cap is not on it, or the
   * runner that owns it has not seeded it yet); a REJECTION = the read failed.
   * The two are not the same to the reconcile: an absent slice contradicts a
   * hold (a camera without the cap cannot be held), a failed read changes
   * nothing (D49). Absent → no signal reconcile: the event path alone, bounded
   * by nothing — the shape every controller test that does not care uses.
   */
  readonly loadDeviceSignal?: (deviceId: number) => Promise<DeviceSignalLevel | null>
  /** Snapshot of resolved recordings locations (id + absolute root). */
  readonly locations: () => readonly RecordingsLocation[]
  /**
   * Resolve the storage location for one (device, profile) at an ATTACH
   * BOUNDARY. Injected by the addon as `PlacementService.place`, which adds the
   * per-camera assignment, the mount probe and the audit row on top of the pure
   * `resolvePlacement`. Absent → the pure resolver, which is byte-identical to
   * the pre-placement behaviour (and the shape every controller test uses).
   *
   * It is called ONLY here, at attach: `.rec-tmp` staging lives under the
   * chosen root so the finalize relocate is a same-filesystem rename, and
   * re-deciding mid-run would turn every segment into the EXDEV copy+unlink
   * fallback (2× disk writes — the F1 regression).
   */
  readonly placeProfile?: (
    deviceId: number,
    profile: CamProfile,
  ) => Promise<RecordingsLocation> | RecordingsLocation
  /**
   * Re-plan placement over every tracked device. Called on its OWN pass
   * ({@link PLACEMENT_TICK_MS}) — never the liveness one, and no longer the
   * reconcile one.
   *
   * It is cheap (a `statfs` per location, no readdir) but it used to ride the
   * pass that also re-attached every device, and `startPeriodicPass` SKIPS a fire
   * while the previous run is still going: one reconcile wedged on a 20 s broker
   * RPC did not merely delay the next placement, it cancelled every one of them
   * for as long as the broker stayed cold. It changes the plan only; the plan
   * reaches a camera at its next attach.
   */
  readonly onPlacementTick?: (deviceIds: readonly number[]) => Promise<void>
  /**
   * One profile writer stopped GRACEFULLY and its watcher has flushed: every
   * segment it produced has been handed to the finalize path. The hour ledger
   * seals the hour it was on (D451). Best-effort — a seal that fails costs one
   * directory read on the next reader, never the teardown.
   */
  readonly onWriterClosed?: (deviceId: number, profile: CamProfile) => Promise<void>
  /**
   * A writer's playlist rolled past entries its watcher never handled — the one
   * moment the recorder KNOWS finalizes were missed (D521).
   *
   * The addon hands this to the hour ledger, which must not then seal those
   * hours as complete. Absent → the loss is logged and nothing else, which is
   * the pre-D521 behaviour and the shape every controller test uses.
   */
  readonly onSegmentsMissed?: (missed: MissedSegments, profile: CamProfile) => void
  /**
   * Emit a recording-health bus event for Notification Center. Absent → the
   * stall / degraded monitors still run in memory (tests), nothing is published.
   */
  readonly emitRecordingHealth?: (
    category:
      | EventCategory.RecordingHealthStalled
      | EventCategory.RecordingHealthOk
      | EventCategory.RecordingHealthDegraded,
    data: Record<string, unknown>,
  ) => void
  /** Spawn an ffmpeg child (default `child_process.spawn`). */
  readonly spawn: SpawnFn
  /**
   * The node's PINNED ffmpeg (D540), asked before every writer spawn. A
   * rejection fails the profile attach — logged per camera, retried by the next
   * reconcile — and never falls back to a PATH `ffmpeg`.
   */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  /**
   * One writer per staging directory (D667): asked before every writer spawn
   * whether another process is already writing that directory, and given the
   * chance to reap it. A `refused` answer means NO spawn — the attach fails,
   * is logged, and the next reconcile retries.
   *
   * Optional only so a controller spec that does not care about the process
   * table keeps its shape. The addon always wires the real one; without it a
   * predecessor's orphaned ffmpeg and this runner's new one co-write.
   */
  readonly stagingGuard?: StagingWriterGuard
  /**
   * Relocate the segments a REAPED foreign writer left in `dir` (D667), before
   * a new writer is spawned there. Without it they are stranded: named after
   * the boot recovery's cutoff, so it skips them, and before the new writer's
   * start, so its watcher skips them too — until the next runner boot.
   * Absent → they are left, and the controller says so.
   */
  readonly recoverStagingDirectory?: (
    input: ReapedDirectoryRecovery,
  ) => Promise<ReapedDirectoryReport>
  /** Names a liveness/placement/reconcile pass that grew the heap (instrumentation only). */
  readonly heapProbe?: HeapDeltaTracker
  /**
   * Where this addon records the children it starts, so it can report its own
   * cost per camera through `load-contribution` instead of leaving an observer
   * to join a pid against a device.
   *
   * Optional: a controller built without one still records, and its ffmpegs
   * appear in the node's process snapshot as UNCLAIMED — which is the true
   * statement, not a zero.
   */
  readonly costRegistry?: ChildCostRegistry
  /** Default segment length (seconds) when the device config omits it. */
  readonly segmentSeconds: number
  /** Watcher poll interval (ms). */
  readonly watchIntervalMs: number
  /** Subscribe to `stream-broker` ready transitions for this node. */
  readonly onBrokerReady: (handler: () => void) => () => void
  /** Run a `stream-broker` call gated on the broker handle's readiness. */
  readonly brokerCall: <R>(fn: () => Promise<R>) => Promise<R>
  /**
   * NON-BLOCKING readiness probe for `stream-broker` on the owner node
   * (`ICapabilityHandle.isReady`). Read BEFORE the attach chain so a reconcile
   * over a cold broker costs nothing.
   *
   * {@link brokerCall} gates on readiness by WAITING (10 s), and each RPC behind
   * it is bounded at {@link ATTACH_RPC_TIMEOUT_MS} (20 s). Attaching one device
   * therefore costs `listAllProfileSlots` plus one `getStreamWithCodec` per
   * profile before anything can fail, and a fleet-wide pass against a broker
   * that is simply DOWN burned all of it to learn a fact the registry already
   * knew. There is nothing to gain by dialling: the device is queued on
   * `ReadinessRestore` and re-attempted the instant the broker reports ready.
   *
   * Absent → assume ready, which is byte-identical to the pre-2026-08-18
   * behaviour (and the shape every controller test that does not care uses).
   */
  readonly brokerReady?: () => boolean
  /**
   * Host to embed in the broker restream URL the writer pulls from. The
   * stream-broker is hub-only and mints `127.0.0.1` URLs (dialable only from
   * the hub). When this recorder runs on the broker host itself this is
   * `undefined` (the hub-local default is correct); when it runs on a REMOTE
   * node designated as the recording node it is the hub's cluster-resolvable
   * host so the pulled `rtsp://<host>:<port>/<token>` is reachable. Forwarded
   * verbatim as `getStreamWithCodec({ hostname })`.
   */
  readonly consumerHostname?: string
  /** Injectable clock (ms) — defaults to `Date.now`. */
  readonly now?: () => number
  /** Segment-watcher factory — defaults to the real `startSegmentWatcher`
   *  (filesystem polling). A spec injects one whose `flush()` does no I/O so a
   *  teardown under fake timers does not depend on host load. */
  readonly startWatcher?: typeof startSegmentWatcher
}

/** What {@link RecordingController.memoryCensus} reports — entry counts, never bytes. */
export interface RecordingControllerCensus {
  readonly activeDevices: number
  readonly writers: number
  readonly attaching: number
  readonly attachingTasks: number
  readonly drainedPlaylists: number
  readonly batteryWakes: number
  readonly triggers: number
  readonly signalConfirmedAt: number
  readonly signalContradictions: number
  readonly lastSegmentAt: number
  readonly attachRetained: number
  readonly unrecordableReported: number
  readonly skippedProfileDevices: number
  readonly skippedProfiles: number
}

/** One reaped writer's directory, to be recovered before a new writer spawns. */
export interface ReapedDirectoryRecovery {
  readonly deviceId: number
  readonly profile: string
  readonly locationId: string
  readonly locationRoot: string
  readonly dir: string
  /** Everything named before this instant belongs to the reaped writer. */
  readonly cutoffMs: number
  readonly segmentSeconds: number
}

/** What a reaped directory's recovery found and moved. */
export interface ReapedDirectoryReport {
  readonly found: number
  readonly recovered: number
  readonly failed: number
}

/** Live per-(device,profile) recording resources. */
interface ProfileRecording {
  readonly profile: CamProfile
  readonly writer: SegmentWriter
  readonly watcher: SegmentWatcherHandle
  readonly pipelineKey: string
  readonly outDir: string
  /** Segment length this writer was spawned with — sizes the idle bound below. */
  readonly segmentSeconds: number
  /**
   * Sound or silence, as the band in force asked for it when this writer was
   * spawned. Carried so a band boundary that changes ONLY the audio answer is
   * noticed: the attach is long-lived and the question is not.
   */
  readonly audio: RecordingBandAudio
}

/** One live writer's directory — what {@link RecordingController.activeWriterDirs} reports. */
export interface ActiveWriterDir {
  readonly deviceId: number
  readonly profile: CamProfile
  /** Absolute directory this writer was spawned against, under its location root. */
  readonly outDir: string
}

const DEFAULT_WATCH_INTERVAL_MS = 2_000

/**
 * Liveness cadence — "is a pinned writer producing nothing?". Unchanged: the
 * question is an in-memory scan over `active`, it costs nothing, and its bound
 * (`writerIdleBoundMs`, floor 90 s) is sized against this beat.
 */
const LIVENESS_TICK_MS = 30_000

/**
 * Placement cadence — unchanged from the beat it used to share with
 * convergence, because nothing about placement wanted to be rarer. What changed
 * is that it no longer rides a pass that can block on broker RPCs: it is one
 * `statfs` per location and it re-plans only, so a plan reaches a camera at its
 * NEXT attach.
 */
export const PLACEMENT_TICK_MS = 30_000

/**
 * Reconcile cadence — the SAFETY NET, not the mechanism.
 *
 * It was 30 s because it WAS the mechanism: nothing else ever closed an `events`
 * window or crossed a band edge, so the loop had to keep asking. Both are now
 * armed for their exact instant (`decision-schedule.ts`), a config change is an
 * RPC, and a broker recovery is a readiness transition — so this pass exists
 * only for what those cannot cover: a wake-up lost because the event path threw
 * before it could arm one, an attach that failed with no later ready transition
 * to ride, a timer lost to a runner respawn, and clock drift.
 *
 * 2 minutes, and the number is chosen against a bound this recorder already
 * accepts. The liveness watchdog tolerates a pinned-but-silent writer for
 * `WRITER_IDLE_MIN_MS` (90 s) before it recovers it; a device that WANTS
 * recording but is detached is the same class of fault — footage is not being
 * written and only a periodic check will notice — so its recovery is put on the
 * same order rather than an order slower. Four times rarer than the beat that
 * blocked for 60 001 ms on 2026-08-18, while still bounding the worst case at
 * ~2 minutes of footage for a camera whose event path failed entirely.
 *
 * Going rarer than this trades real footage for CPU that the pass no longer
 * spends anyway: with the broker-readiness pre-check below, a reconcile over a
 * healthy fleet is N config reads and no RPC at all.
 */
export const RECONCILE_TICK_MS = 120_000

/**
 * How long a `recording-signal` hold may stand WITHOUT a read confirming it
 * before the reconcile releases it anyway.
 *
 * The hold is opened by an event (D8: telemetry, may be dropped) and closed by
 * an event; the reconcile beat re-reads the level through RPC every
 * {@link RECONCILE_TICK_MS} and that read is what normally keeps or ends it. This
 * bound is for the case where the READ itself keeps failing — the device-state
 * door unreachable for hours — so that one lost falling edge can never pin a
 * camera for ever (D11). It counts from the last confirmation (the rise event,
 * or the last read that said `active`), never from the rise alone: a job that
 * genuinely lasts longer than this, with the level re-read every two minutes,
 * is never cut.
 *
 * Four hours: the longest whole-house clean-and-mop observed is under three,
 * and a device-state door down for four hours is an outage that has already
 * cost more than one recording.
 */
export const SIGNAL_HOLD_MAX_MS = 4 * 3_600_000

/**
 * How many consecutive reconcile reads must say `active: false` before a hold
 * the bus never released is released by the reconcile. Two, per D49: a read
 * that contradicts the mirror in the direction that ENDS work needs a second
 * read to agree. The event path is unaffected — a delivered fall releases at
 * once; this is only the backstop for a fall the bus lost.
 */
export const SIGNAL_RELEASE_READS = 2

/** The level as the reconcile reads it back from the device's slice. */
export interface DeviceSignalLevel {
  readonly active: boolean
  /** Ms epoch of the last transition, 0 when the provider never observed one. */
  readonly lastChangedAt: number
}

/**
 * Bound on the ONE store read at the head of every placement and reconcile pass
 * (`enabledDeviceIds` → `readDeviceConfigs`).
 *
 * It is a cross-process read of `hub/sqlite-settings` and it was unbounded, so
 * it fell through to the 60 s UDS default. Sixty seconds is TWICE the placement
 * pass's whole budget spent before the pass has looked at a single location, and
 * it is a third of the reconcile budget spent before a single camera is
 * evaluated. Measured on the live hub on 2026-08-25: the pass that logged
 * `durationMs: 181056` spent its first 59 952 ms here and then logged
 * `could not enumerate persisted devices`.
 *
 * Failing this read is already a handled, LOGGED degradation — the pass covers
 * the active devices only — so a bound costs one pass a narrower scope and buys
 * back 55 s. Five seconds is three orders of magnitude above the healthy read.
 */
const TRACKED_DEVICES_READ_TIMEOUT_MS = 5_000

/**
 * A placement pass slower than this is reported WITH ITS PHASES, long before it
 * reaches the 30 s budget that only says "it was slow".
 *
 * The budget line is a tombstone: by the time a pass trips it, it has already
 * skipped the ticks behind it, and it names no phase — every 240 s pass in this
 * repo's history had to be attributed by hand-correlating adjacent lines. This
 * says which half was slow, so a store that is degrading is visible while it is
 * still only degrading.
 *
 * Deliberately BELOW every bound the pass applies (5 s), so a pass that trips
 * one of them always reports its phases — a threshold equal to the bound misses
 * the trip by a rounding error. A healthy pass is single-digit milliseconds
 * (`placementMs` 3–18 ms on the live hub), so 2 s is still two orders of
 * magnitude of headroom.
 */
const PLACEMENT_PHASE_WARN_MS = 2_000

/**
 * Bound on the broker lease-release RPC (`releaseStreamWithCodec`) during
 * teardown. The UDS request default is 60s, but the runner supervisor's
 * SIGTERM→SIGKILL grace (`$process.stop`/`restart` in the kernel
 * process-service) is 5s: one release hanging on a restarting broker — the
 * normal state during a redeploy — blew the grace and the supervisor
 * SIGKILLed the recorder mid-shutdown (observed 2026-08-01 04:08–04:24,
 * `signal=SIGKILL state=stopped` × 4). The SIGKILL orphans the ffmpeg
 * writers (they keep double-writing `.rec-tmp` against the respawned
 * runner's fresh writers) and releases NO lease at all — strictly worse
 * than dropping this one RPC. A timed-out release is safe to abandon:
 * killing the writer drops the source's only RTSP consumer, so the broker
 * idles the source out on its own.
 */
const RELEASE_RPC_TIMEOUT_MS = 2_000

/**
 * Bound on each broker RPC in the ATTACH chain (`listAllProfileSlots`,
 * `getStreamWithCodec`).
 *
 * These were the only unbounded calls left in the controller.
 * `CapabilityHandle.call` gates READINESS (10 s) and then returns `fn()`
 * untouched, so an accepted-but-unanswered request fell through to the 60 s UDS
 * default in `kernel/transport/socket-channel.ts`. On 2026-08-13 the broker was
 * degraded (516 UDS timeouts that day) and the arithmetic did the damage: one
 * device costs `listAllProfileSlots` + one `getStreamWithCodec` per profile, so
 * a 4-camera fleet on 3 profiles reached ~16 minutes inside a single recovery
 * pass — during which every device sits DETACHED (recording stopped) and in
 * `attaching` (so `evaluateDevice` returns early and the liveness watchdog,
 * which reads `active`, has nothing to report). That is the shape of the 9-27
 * minute silences and the real recording gaps behind the 80% timelapse
 * coverage.
 *
 * 20 s is generous for a real RTSP dial and far below the UDS default, so a
 * hung broker now fails the attach fast. Nothing is lost by giving up: the
 * device stays on the readiness-restore queue and the next pass retries it.
 */
const ATTACH_RPC_TIMEOUT_MS = 20_000

/**
 * A pass longer than this is reported with its duration. Each pass uses its OWN
 * cadence as the budget: a pass that cannot finish inside its own interval is
 * the condition that used to go unlogged for half an hour. Keeping it per-pass
 * matters now that the three cadences differ — a 40 s reconcile is healthy
 * against a 120 s beat and was a red flag against a 30 s one.
 */
function passSlowAfterMs(intervalMs: number): number {
  return intervalMs
}

/**
 * Bound on the two registry reads the battery-wake policy makes. They run
 * before any broker call on every attach, battery camera or not, so they are
 * the cheapest place for an unresponsive durable store to cost a recording.
 * Short on purpose: the answer is a cached registry field, not a camera.
 */
const BATTERY_READ_TIMEOUT_MS = 3_000

/**
 * How stale a trigger may be on arrival before it is worth a warn. A recording
 * window is opened from `now`, but its POST-buffer is measured from the trigger
 * instant, so every millisecond of lag is a millisecond of the operator's
 * window already gone. 2 s is well clear of normal bus jitter and well under
 * the shipped 30 s post-buffer.
 */
const TRIGGER_LAG_WARN_MS = 2_000

/**
 * Floor for "this writer is pinned but producing nothing".
 *
 * The give-up path only fires when ffmpeg EXITS. On 2026-07-29 the opposite
 * happened on 104 + 102: after a deploy the writers pinned the broker and hung
 * — process alive, no exit, no error, no retry — and ~68 minutes of recording
 * were lost while `evaluateDevice` kept short-circuiting at "already recording
 * — converged". A supervisor that only watches for termination cannot see
 * silence.
 */
const WRITER_IDLE_MIN_MS = 90_000

/**
 * The bound also scales with segment length, so a camera on long segments is
 * not declared dead while its FIRST segment is still legitimately being
 * written. Three segments' worth is comfortably past any single hiccup.
 */
const WRITER_IDLE_SEGMENT_MULTIPLIER = 3

/** How long a writer may go without finalizing a segment before it is recovered. */
function writerIdleBoundMs(segmentSeconds: number): number {
  return Math.max(WRITER_IDLE_MIN_MS, segmentSeconds * 1000 * WRITER_IDLE_SEGMENT_MULTIPLIER)
}

/** Key for the per-(device, profile) liveness stamp. */
function idleKey(deviceId: number, profile: CamProfile): string {
  return `${deviceId}:${profile}`
}

/**
 * Staging dir name, created UNDER each recordings location root
 * (`<locationRoot>/.rec-tmp/<deviceId>/<profile>`). Per-location staging means
 * the rec-tmp→final relocate is ALWAYS a same-filesystem rename — never the
 * EXDEV copy+unlink fallback that rewrites every segment (2x disk writes, F1).
 * The leading dot keeps it out of the recorder's own hydrate walk (which only
 * descends `<root>/<deviceId>/`) and `parseSegmentPath` (digits-first layout).
 */
export const STAGING_DIR_NAME = '.rec-tmp'

export class RecordingController {
  private readonly active = new Map<number, ProfileRecording[]>()
  /**
   * Devices whose attach is IN FLIGHT. `evaluateDevice` only `active.set`s after
   * a chain of awaits (loadConfig → resolveProfiles → getStreamWithCodec → mkdir
   * → spawn); without this guard two evaluate passes racing in the same tick
   * (rapid motion triggers, or a tick concurrent with give-up recovery) both pass
   * the `active.has` check and each spawn a DUPLICATE writer set that double-writes
   * the same rec-tmp dir → colliding/28-byte segments + relocate ENOENT. Set
   * synchronously right after the `active.has` check (no await between), cleared in
   * a `finally`. Mirrors the decoder-ffmpeg session-creation coalescing guard.
   */
  private readonly attaching = new Set<number>()
  /** Every attach admitted before a maintenance pause. The pause waits these
   * promises before it snapshots/drains active writers. */
  private readonly attachingTasks = new Map<number, Promise<void>>()
  /**
   * The drain ledger: per staging directory (resolved `outDir`), what the last
   * watcher of THIS process drained there (`segment-watcher.ts`
   * `DrainedPlaylist`). Consumed by the next watcher on that directory, so a
   * fresh watcher reading its predecessor's playlist does not report a roll-off
   * that predecessor already handled or reported. Per process by design: after
   * a runner respawn it is empty and the roll-off IS reported (D521). At most
   * one entry per location × device × profile directory.
   */
  private readonly drainedPlaylists = new Map<string, DrainedPlaylist>()
  /**
   * Monotonic attach counter, the last component of the CONSUMER TAG this
   * recorder puts on its RTSP dial (`recorder/<deviceId>/<profile>/<n>`).
   *
   * The tag is the join key between the broker's pre-roll accounting and the
   * files on disk. `deviceId/profile` alone is not enough: a device that
   * re-attaches names the same pair again, and two attaches minutes apart both
   * matching a broker line is exactly the ambiguity that made the 2026-08-20
   * measurements unreconcilable. A wall-clock stamp would collide under a fake
   * clock (and this controller's clock is injected); a counter cannot.
   */
  private attachSeq = 0
  /** In-flight battery wake per device — concurrent attaches join it rather
   *  than issuing a second wake at the same radio. */
  private readonly batteryWakes = new Map<number, Promise<void>>()
  /** Qualifying trigger HISTORY per device — drives `events`-band gating. A
   *  bounded list of merged windows, NOT the last timestamp: see
   *  {@link TriggerState}. */
  private readonly triggers = new Map<number, TriggerState>()
  /**
   * Per device, when the `recording-signal` hold was last CONFIRMED — by the
   * rise event or by a reconcile read that said `active`. The clock
   * {@link SIGNAL_HOLD_MAX_MS} counts from. Deleted with the hold.
   */
  private readonly signalConfirmedAt = new Map<number, number>()
  /**
   * Per device, how many CONSECUTIVE reconcile reads have said `active: false`
   * while a hold stood. Reset by any read that says `active` and by the rise
   * event. Reaches {@link SIGNAL_RELEASE_READS} → the reconcile releases.
   */
  private readonly signalContradictions = new Map<number, number>()
  /**
   * Last sign of life per `deviceId:profile` — seeded at attach (so the grace
   * window starts at the pin, not at the first segment) and stamped on every
   * finalize. Read by {@link checkIdleWriters}. Stamped BEFORE the keep/discard
   * policy runs: a discarded `events`-band segment still proves the writer is
   * alive, which is the only question here.
   */
  private readonly lastSegmentAt = new Map<string, number>()
  /**
   * Per `deviceId:profile`, when a segment was last FINALIZED — never seeded at
   * the pin. {@link lastSegmentAt} answers "is this writer still in its grace
   * window"; this answers "has it actually produced anything recently", which is
   * what a give-up may claim about the siblings it keeps (2026-10-22, camera
   * 618: both writers dead, each give-up said the other "keeps recording").
   * Cleared with {@link lastSegmentAt}.
   */
  private readonly lastProducedAt = new Map<string, number>()
  /**
   * Per `deviceId:profile`, the `attachedAtMs` of the attach that has retained
   * at least one `events` segment. Read only to LEVEL the discard log: an
   * attach that kept nothing is a wasted pull (warn), a later discard from one
   * that kept something is the tail of the window (info). Bounded by
   * device×profile like {@link lastSegmentAt}, and cleared with it on detach.
   */
  private readonly attachRetained = new Map<string, number>()
  /**
   * Devices already named by {@link reportUnrecordable} — one warn per device
   * per "enabled but can never record" episode, re-armed as soon as the device
   * records again.
   */
  private readonly unrecordableReported = new Set<number>()
  /**
   * Profiles the last attach skipped (stream not published / getStream threw).
   * `evaluateDevice` retries only these on the converge tick so a dead `low`
   * cannot keep `high` dark, without a `listAllProfileSlots` RPC on every
   * healthy device every 30s.
   */
  private readonly skippedProfiles = new Map<number, Set<CamProfile>>()
  /**
   * Writers being torn down whose ffmpeg may not have exited yet. They left
   * {@link active} when the teardown began, but their pid is still ours until
   * the child's `exit` fires — without this set the staging guard (D667) would
   * reap this runner's own exiting writer and log it as a predecessor's.
   */
  private readonly retiring = new Set<SegmentWriter>()
  private restore: ReadinessRestore<number, true> | null = null
  /**
   * One pending wake-up per device, armed for the exact instant its recording
   * decision could change on its own — an `events` window closing or a band
   * edge. THE reason a detach is punctual instead of up to a pass late.
   */
  private readonly wakeups: DeviceWakeups
  /** Cheap, never-delayed: is any pinned writer producing nothing? */
  private livenessPass: PeriodicPassHandle | null = null
  /** Cheap, and off the attach beat: re-plan where each (device, profile) writes. */
  private placementPass: PeriodicPassHandle | null = null
  /** The backstop: re-evaluate every tracked-or-configured device. */
  private reconcilePass: PeriodicPassHandle | null = null
  private stopped = false
  /** A reversible maintenance lease. Unlike `stopped`, it never changes
   * persisted recording intent and `resume()` restarts normal convergence. */
  private paused = false

  /**
   * The ADAPTIVE attach bound. A transient `spawn ffmpeg` failure (EAGAIN) is
   * the host saying it cannot fork right now, and the answer is to attach
   * FEWER cameras at once — not to serialise them, which removed
   * for good reason. Every bounded-parallel attach in this file reads it.
   */
  private readonly spawnPressure: SpawnPressureGovernor
  private readonly stallMonitor = new RecordingStallMonitor()

  constructor(private readonly deps: RecordingControllerDeps) {
    this.spawnPressure = new SpawnPressureGovernor({
      maxConcurrency: RESTORE_DRAIN_CONCURRENCY,
      now: () => this.now(),
      logger: deps.logger,
    })
    this.wakeups = new DeviceWakeups({
      logger: deps.logger,
      now: () => this.now(),
      fire: (deviceId) => this.onWakeup(deviceId),
    })
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * A per-device wake-up came due: re-decide. `evaluateDevice` re-arms (or
   * cancels) the next one as part of deciding, so the chain is self-sustaining.
   *
   * A throw here breaks that chain — the device keeps whatever state it had and
   * has no timer behind it — so it is NAMED, and the reconcile is what picks it
   * up. Silence would read as "the window never closed".
   */
  private onWakeup(deviceId: number): void {
    void this.evaluateDevice(deviceId).catch((err: unknown) => {
      this.deps.logger.warn(
        'recorder: scheduled re-evaluation failed — no wake-up re-armed (the reconcile is the backstop)',
        { tags: { deviceId }, meta: { error: errMsg(err) } },
      )
    })
  }

  /**
   * Arm (or cancel) this device's next wake-up from the config it was just
   * evaluated against.
   *
   * Called from `evaluateDevice` BEFORE the attach/detach work, not after: the
   * attach chain can throw (broker not ready, stream unpublished) and the
   * schedule does not depend on whether it succeeded. Arming first means a
   * failed attach still gets its band edge, and only a failure to READ the
   * config can lose a wake-up.
   */
  private scheduleNextDecision(deviceId: number, config: RecordingConfig): void {
    if (this.stopped || this.paused) {
      this.wakeups.cancel(deviceId)
      return
    }
    const next = nextDecisionChangeAt({
      config,
      triggers: this.triggersFor(deviceId),
      nowMs: this.now(),
    })
    if (next === null) {
      // Nothing can change without an event this controller already receives: a
      // trigger, or a config RPC. Includes a disabled device and the always-on
      // band that has no edge at all.
      this.wakeups.cancel(deviceId)
      return
    }
    this.wakeups.arm(deviceId, next.atMs, next.reason)
  }

  /**
   * Where every LIVE writer is writing right now — the directory ffmpeg was
   * spawned against, per (device, profile).
   *
   * The plan and the disk disagree for as long as a writer outlives the tick
   * that re-planned it: placement applies at ATTACH BOUNDARIES only (the
   * `.rec-tmp` staging dir lives under the chosen root so the finalize
   * relocate is a same-filesystem rename), so a continuously-recording camera
   * keeps its root until something detaches it. That is a legitimate state and
   * a silent one, which is why it is READABLE from here (D387).
   */
  activeWriterDirs(): readonly ActiveWriterDir[] {
    const out: ActiveWriterDir[] = []
    for (const [deviceId, recordings] of this.active) {
      for (const r of recordings) out.push({ deviceId, profile: r.profile, outDir: r.outDir })
    }
    return out
  }

  /** Entries in the drain ledger — for the memory census. */
  get drainedLedgerSize(): number {
    return this.drainedPlaylists.size
  }

  /**
   * Boot restore: seed the readiness-gated queue with every persisted device and
   * (re)evaluate each on every `stream-broker` ready transition. Also arms the
   * periodic passes. Idempotent — safe to call once after the index is hydrated.
   */
  async start(): Promise<void> {
    if (this.stopped) return
    let ids: readonly number[]
    try {
      ids = await this.deps.enabledDeviceIds()
    } catch (err: unknown) {
      this.deps.logger.warn('recorder controller: reading persisted devices failed', {
        meta: { error: errMsg(err) },
      })
      ids = []
    }

    this.restore = new ReadinessRestore<number, true>({
      subscribeReady: (handler) => this.deps.onBrokerReady(handler),
      // Read per drain: a boot that hits fork pressure narrows the NEXT wave
      // instead of re-attempting the same too-large batch.
      concurrency: () => this.spawnPressure.concurrency,
      attempt: async (deviceId) => {
        await this.evaluateDevice(deviceId)
      },
      onDefer: (deviceId, _v, err) =>
        this.deps.logger.warn(
          'recorder controller: device evaluate deferred (retries on next broker ready)',
          {
            tags: { deviceId },
            meta: { error: errMsg(err) },
          },
        ),
    })

    if (this.reconcilePass === null) {
      // THREE passes, each on its own timer and each non-overlapping.
      //
      // Liveness and convergence used to be one: `tick()` ran
      // `checkIdleWriters()` and then the convergence sweep, so anything slow in
      // convergence delayed the liveness check by exactly as much. That is why
      // the 2026-08-13 watchdog first reported `idleMs=546335` against a 90 s
      // bound — it had not been ALLOWED to look for 9 minutes.
      //
      // Placement was split off on 2026-08-18 for the same reason one level
      // down: it is a `statfs` per location and it rode the pass that blocked
      // for 60 001 ms cold-dialling RTSP. `startPeriodicPass` SKIPS a fire while
      // the previous run is in flight, so a wedged reconcile did not merely
      // delay the next placement — it cancelled every one of them.
      //
      // What is left on the reconcile beat is the only work that can touch the
      // broker, and it is now the only pass whose cadence is a policy choice
      // rather than a cost (see RECONCILE_TICK_MS).
      this.livenessPass = startPeriodicPass({
        name: 'liveness',
        intervalMs: LIVENESS_TICK_MS,
        slowAfterMs: passSlowAfterMs(LIVENESS_TICK_MS),
        logger: this.deps.logger,
        now: () => this.now(),
        run: () => this.checkIdleWriters(),
        ...(this.deps.heapProbe !== undefined ? { heapProbe: this.deps.heapProbe } : {}),
      })
      this.placementPass = startPeriodicPass({
        name: 'placement',
        intervalMs: PLACEMENT_TICK_MS,
        slowAfterMs: passSlowAfterMs(PLACEMENT_TICK_MS),
        logger: this.deps.logger,
        now: () => this.now(),
        run: () => this.replanPlacement(),
        ...(this.deps.heapProbe !== undefined ? { heapProbe: this.deps.heapProbe } : {}),
      })
      this.reconcilePass = startPeriodicPass({
        name: 'reconcile',
        intervalMs: RECONCILE_TICK_MS,
        slowAfterMs: passSlowAfterMs(RECONCILE_TICK_MS),
        logger: this.deps.logger,
        now: () => this.now(),
        run: () => this.reconcile(),
        ...(this.deps.heapProbe !== undefined ? { heapProbe: this.deps.heapProbe } : {}),
      })
    }

    await this.restore.start(ids.map((id) => [id, true] as const))
  }

  /**
   * Every device the recorder is responsible for right now: those with writers
   * attached, plus every one with a persisted config. A failure to enumerate the
   * persisted set degrades to "the active ones" rather than aborting the pass.
   */
  private async trackedDeviceIds(): Promise<readonly number[]> {
    const ids = new Set<number>(this.active.keys())
    try {
      // BOUNDED: this is a cross-process settings read, and an unbounded one
      // spends 60 s of a 30 s pass before the pass starts. See
      // TRACKED_DEVICES_READ_TIMEOUT_MS.
      const enabled = await withDeadline(
        this.deps.enabledDeviceIds(),
        TRACKED_DEVICES_READ_TIMEOUT_MS,
        'recorder: enabledDeviceIds',
      )
      for (const id of enabled) ids.add(id)
    } catch (err: unknown) {
      // Named: a pass that silently narrows its scope looks identical to one
      // with nothing to do.
      this.deps.logger.warn(
        'recorder controller: could not enumerate persisted devices — this pass covers the active ones only',
        { meta: { error: errMsg(err), activeDevices: this.active.size } },
      )
    }
    return [...ids]
  }

  /**
   * Re-plan where each (device, profile) writes. Its OWN pass: cheap (no I/O
   * beyond a statfs per location), and it must not be starved by an attach that
   * is waiting on a 20 s broker timeout. It changes the PLAN only — a running
   * writer keeps its root until it next attaches, which is the boundary rule.
   */
  private async replanPlacement(): Promise<void> {
    if (this.stopped || this.paused) return
    if (this.deps.onPlacementTick === undefined) return
    const startedAt = this.now()
    const ids = await this.trackedDeviceIds()
    const enumeratedAt = this.now()
    try {
      await this.deps.onPlacementTick(ids)
    } catch (err: unknown) {
      this.deps.logger.warn('recorder controller: placement recompute failed', {
        meta: { error: errMsg(err) },
      })
    }
    const finishedAt = this.now()
    if (finishedAt - startedAt > PLACEMENT_PHASE_WARN_MS) {
      // Attributable without correlating timestamps by hand: which half was
      // slow, over how many cameras. See PLACEMENT_PHASE_WARN_MS.
      this.deps.logger.warn('recorder: placement pass ran long — phase breakdown', {
        meta: {
          totalMs: finishedAt - startedAt,
          enumerateMs: enumeratedAt - startedAt,
          recomputeMs: finishedAt - enumeratedAt,
          devices: ids.length,
          budgetMs: PLACEMENT_TICK_MS,
        },
      })
    }
  }

  /**
   * The backstop pass: re-evaluate every tracked-or-configured device.
   *
   * Nothing here is the normal path any more — a window close, a band edge, a
   * config change and a broker recovery all reach `evaluateDevice` on their own.
   * This exists for the four things that cannot: a wake-up the event path threw
   * before arming, an attach that failed with no later readiness transition to
   * ride, a timer lost to a runner respawn, and clock drift.
   */
  private async reconcile(): Promise<void> {
    if (this.stopped) return
    const ids = await this.trackedDeviceIds()
    await runBounded(ids, this.spawnPressure.concurrency, async (id) => {
      // BEFORE the evaluate, always: a window recovered here is what makes the
      // evaluate that follows it decide to record at all.
      await this.reconcileTriggerHistory(id)
      try {
        await this.evaluateDevice(id)
      } catch (err: unknown) {
        this.deps.logger.warn('recorder controller: reconcile evaluate failed', {
          tags: { deviceId: id },
          meta: { error: errMsg(err) },
        })
      }
    })
  }

  /**
   * Rebuild this device's motion trigger windows from the DURABLE rows.
   *
   * The trigger event is the fast path and stays so — this never opens a
   * recording any sooner. What it covers is the case the event path cannot: a
   * trigger the bus dropped, or one that arrived after its own window had
   * closed (a `busLagMs` of 142 173 has been measured on this cluster). In both
   * the keep gate has NO window for an episode that happened, so every segment
   * of it is discarded and the footage is gone for ever — durable state resting
   * on telemetry, which D8/D11 forbid.
   *
   * ## Which sources it covers, and which it does NOT
   *
   * MOTION and OBJECT-DETECTION. Both have a durable counterpart at the same
   * granularity the bus carries — `pipelineAnalytics.getMotionEvents` and
   * `getObjectEvents` — so a dropped event is recoverable from rows.
   *
   * AUDIO and SENSOR are NOT covered, and that is a stated gap, not an
   * oversight:
   *  - audio has no per-window durable row the recorder can ask for;
   *  - `SensorEvent` rows exist but are LEVEL, not EDGE (a contact closing
   *    writes a row exactly like one opening), and they carry the taxonomy
   *    `kind`, not the `capName` that `SOURCE_CAP_ACTIVE_FIELD` is indexed by.
   *    The inversion was MEASURED on 2026-08-27 rather than eyeballed:
   *    `CAP_TO_KIND` (`types/capabilities/sensor-event-kinds.ts`) has no two
   *    caps sharing a kind, so `kind → capName` is invertible — but `binary`,
   *    a source cap, has NO entry in it at all, so a `binary` sensor's edges
   *    never reach the `SensorEvent` table and could never be recovered. A
   *    reconcile covering nine source caps out of ten reads as covering all
   *    ten, which is the failure this whole comment exists to avoid.
   *
   * A reconcile that silently covered some sources and not others would read as
   * covering all of them, so it is named here and the un-covered sources are
   * simply skipped — never faked.
   *
   * Never throws: this runs at the head of the reconcile beat and an escape
   * here would cancel the evaluate for the whole device.
   */
  private async reconcileTriggerHistory(deviceId: number): Promise<void> {
    const loadMotion = this.deps.loadMotionEvents
    const loadObject = this.deps.loadObjectEvents
    const loadSignal = this.deps.loadDeviceSignal
    if (
      (loadMotion === undefined && loadObject === undefined && loadSignal === undefined) ||
      this.stopped
    ) {
      return
    }
    try {
      // The cheap question first: a device with no reconcilable events band has
      // nothing to reconcile, and asking the store would be one RPC per
      // continuous camera per beat for an answer nobody reads.
      const config = await this.deps.loadConfig(deviceId)
      if (config.enabled !== true) return
      const nowMs = this.now()
      const band = activeBandAt({ bands: effectiveBands(config) }, new Date(nowMs))
      if (!band || band.mode !== 'events') return
      const { postMs } = resolveBandBufferMs(band)
      // Exactly the horizon `pruneTriggerHistory` keeps: past it, a recovered
      // window could not retain anything anyway, so fetching it is pure cost.
      const sinceMs = nowMs - postMs - TRIGGER_HISTORY_MARGIN_MS
      /** Durable rows for one source, or null when that source has no durable
       *  half (audio, sensor) or its loader was not injected. */
      const durableRowsFor = async (source: TriggerSource): Promise<readonly number[] | null> => {
        if (source.kind === 'motion') {
          return loadMotion === undefined ? null : await loadMotion(deviceId, sinceMs, nowMs)
        }
        if (source.kind === 'object') {
          return loadObject === undefined
            ? null
            : await loadObject(deviceId, source.macroClass, sinceMs, nowMs)
        }
        return null
      }
      for (const source of bandTriggerSources(band)) {
        if (this.stopped) return
        if (source.kind === 'signal') {
          // A LEVEL has no rows to fold: its durable half is the slice itself,
          // read back and compared with the hold. Its own method, because the
          // rules (two reads to release, a bound on an unconfirmed hold) are
          // not the row merge.
          if (loadSignal !== undefined) await this.reconcileSignalLevel(deviceId, source, postMs)
          continue
        }
        const rows = await durableRowsFor(source)
        if (rows === null || rows.length === 0) continue
        if (this.stopped) return
        const pruned = pruneTriggerHistory(this.triggersFor(deviceId), postMs, this.now())
        const folded = foldDurableTriggers(pruned, source, rows, postMs)
        this.triggers.set(deviceId, folded.state)
        if (folded.recovered > 0) {
          // The bus lost or delayed something and the durable rows carried it.
          // Nonzero here on a healthy cluster means the event path is degrading,
          // and that is a fact worth having BEFORE it costs an episode.
          this.deps.logger.info(
            'recorder: trigger windows recovered from the durable rows — the bus had not delivered them',
            {
              tags: { deviceId },
              meta: {
                source: triggerKey(source),
                rows: rows.length,
                recovered: folded.recovered,
                sinceMs,
                postMs,
              },
            },
          )
        }
        if (folded.evicted > 0) {
          this.deps.logger.warn(
            'recorder: trigger history full during reconcile — oldest window(s) evicted',
            {
              tags: { deviceId },
              meta: {
                source: triggerKey(source),
                evicted: folded.evicted,
                maxWindows: MAX_TRIGGER_WINDOWS,
              },
            },
          )
        }
      }
    } catch (err: unknown) {
      this.deps.logger.warn('recorder: trigger reconcile failed — retries on the next beat', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * Compare the `recording-signal` HOLD with the slice the device publishes
   * now, and correct the hold the way D49 allows: a read that raises the level
   * is applied at once (footage is what is at stake); a read that lowers it is
   * applied only when {@link SIGNAL_RELEASE_READS} consecutive reads agree; a
   * read that fails changes nothing — except that a hold nobody has confirmed
   * for {@link SIGNAL_HOLD_MAX_MS} is released anyway, and says so.
   *
   * Never throws: called from the head of the reconcile beat.
   */
  private async reconcileSignalLevel(
    deviceId: number,
    source: TriggerSource,
    postMs: number,
  ): Promise<void> {
    const load = this.deps.loadDeviceSignal
    if (load === undefined) return
    const nowMs = this.now()
    const since = heldSinceMs(this.triggersFor(deviceId), source)
    let level: DeviceSignalLevel | null
    try {
      level = await load(deviceId)
    } catch (err: unknown) {
      this.deps.logger.warn('recorder: device signal read failed — the hold stands', {
        tags: { deviceId },
        meta: { held: since !== null, error: errMsg(err) },
      })
      this.releaseIfHeldPastBound(deviceId, source, since, postMs, nowMs)
      return
    }
    if (this.stopped) return
    if (level?.active === true) {
      this.signalConfirmedAt.set(deviceId, nowMs)
      this.signalContradictions.delete(deviceId)
      if (since !== null) return
      // The bus never delivered the rise (or delivered it before this runner
      // was born). The hold opens at the transition the provider recorded, so
      // the keep gate's pre-buffer is anchored to the real rise.
      const rise = level.lastChangedAt > 0 ? Math.min(level.lastChangedAt, nowMs) : nowMs
      this.triggers.set(deviceId, holdTrigger(this.triggersFor(deviceId), source, rise))
      this.deps.logger.info(
        'recorder: device signal recovered from the slice — the bus had not delivered the rise',
        { tags: { deviceId }, meta: { since: rise, lastChangedAt: level.lastChangedAt } },
      )
      return
    }
    if (since === null) return
    const contradictions = (this.signalContradictions.get(deviceId) ?? 0) + 1
    if (contradictions < SIGNAL_RELEASE_READS) {
      this.signalContradictions.set(deviceId, contradictions)
      this.deps.logger.debug(
        'recorder: device signal read contradicts the hold — waiting for a second read to agree',
        { tags: { deviceId }, meta: { since, reads: contradictions, absent: level === null } },
      )
      return
    }
    this.applySignalRelease(deviceId, source, nowMs, postMs)
    this.deps.logger.info(
      'recorder: device signal released by reconcile — two reads agreed the level is down',
      { tags: { deviceId }, meta: { since, heldMs: nowMs - since, absent: level === null } },
    )
  }

  /** The bound on a hold the reads could not confirm. Warns, because it DROPS
   *  the rest of an episode the operator may still want. */
  private releaseIfHeldPastBound(
    deviceId: number,
    source: TriggerSource,
    since: number | null,
    postMs: number,
    nowMs: number,
  ): void {
    if (since === null) return
    const confirmedAt = this.signalConfirmedAt.get(deviceId) ?? since
    if (nowMs - confirmedAt <= SIGNAL_HOLD_MAX_MS) return
    this.applySignalRelease(deviceId, source, nowMs, postMs)
    this.deps.logger.warn(
      'recorder: device signal held past its bound with no read confirming it — released, the episode may be cut',
      {
        tags: { deviceId },
        meta: { since, confirmedAt, heldMs: nowMs - since, boundMs: SIGNAL_HOLD_MAX_MS },
      },
    )
  }

  /** Lower the hold into a window and forget the per-device signal clocks. */
  private applySignalRelease(
    deviceId: number,
    source: TriggerSource,
    atMs: number,
    postMs: number,
  ): void {
    const pruned = pruneTriggerHistory(this.triggersFor(deviceId), postMs, atMs)
    this.triggers.set(deviceId, releaseTrigger(pruned, source, atMs, postMs))
    this.signalConfirmedAt.delete(deviceId)
    this.signalContradictions.delete(deviceId)
  }

  /**
   * Feed the camera's own `recording-signal` LEVEL — the counterpart of
   * `onTrigger` for `RecordingTriggers.deviceSignal`, fed from the
   * `DeviceStateChanged` subscription in `recorder/addon/index.ts`.
   *
   * `active: true` HOLDS the source open (idempotent: a re-emitted slice never
   * moves the rise); `active: false` releases it into a window ending at `atMs`,
   * after which the band's `postBufferSec` runs and `evaluateDevice` arms the
   * close exactly as it does for a motion episode. Both converge at once: the
   * rise is what wakes a battery camera and pins its source (the robot's
   * monitor opens through `battery.wakeForStream` on the attach), the fall is
   * what lets the source be released and the monitor close.
   *
   * No config read on this path (D49): the hold is recorded unconditionally —
   * it costs one map entry — and `evaluateDevice`, which reads the last-known
   * config, decides whether any band listens. A camera whose bands do not name
   * the signal simply never demands.
   */
  async onSignalLevel(
    deviceId: number,
    source: TriggerSource,
    active: boolean,
    atMs: number,
  ): Promise<void> {
    if (this.stopped) return
    const before = this.triggersFor(deviceId)
    if (active) {
      const held = holdTrigger(before, source, atMs)
      this.signalConfirmedAt.set(deviceId, this.now())
      this.signalContradictions.delete(deviceId)
      if (held !== before) {
        this.triggers.set(deviceId, held)
        this.deps.logger.info('recorder: device signal raised — recording window held open', {
          tags: { deviceId },
          meta: { source: triggerKey(source), atMs },
        })
      }
    } else {
      const postMs = await this.postBufferMsFor(deviceId, atMs)
      if (this.stopped) return
      const since = heldSinceMs(this.triggersFor(deviceId), source)
      if (since === null) return
      this.applySignalRelease(deviceId, source, atMs, postMs)
      this.deps.logger.info(
        'recorder: device signal fell — post-buffer running, then the window closes',
        {
          tags: { deviceId },
          meta: { source: triggerKey(source), since, atMs, heldMs: atMs - since, postMs },
        },
      )
    }
    try {
      await this.evaluateDevice(deviceId)
    } catch (err: unknown) {
      // Same deferral as `onTrigger`: the attach is re-queued on the readiness
      // restore queue and retried on the next broker-ready transition, with the
      // reconcile as backstop. Named, never silent.
      this.deps.logger.warn(
        'recorder: device signal attach deferred — stream not available yet (retries on next broker ready/reconcile)',
        { tags: { deviceId }, meta: { source: triggerKey(source), active, error: errMsg(err) } },
      )
    }
  }

  /**
   * Re-evaluate one device after a config change (called from `setDeviceConfig`).
   * Failures propagate so the caller can surface them, but the persisted config
   * has already been written by the time this runs.
   */
  async onConfigChanged(deviceId: number): Promise<void> {
    if (this.stopped || this.paused) return
    await this.evaluateDevice(deviceId)
  }

  /**
   * One profile's ffmpeg writer exhausted its bounded inner restarts and gave
   * up, or the idle watchdog found it silent.
   *
   * Recover THAT profile only when siblings are still producing. Whole-device
   * detach was the 2026-08-22 gap: high stalled 139 s on 101/104/102/586 and
   * recovery unpinned low too — the profile the timeline and scrub actually
   * read — punching 38–172 s holes in continuous cameras. The broker re-dial
   * argument still holds when NOTHING on the device is healthy; then we detach
   * the whole set so the next evaluate starts clean.
   *
   * Bounded OUTER retry (RECONCILE_TICK_MS / fillMissingProfiles cadence),
   * never a tight loop.
   */
  private async recoverWriterGaveUp(deviceId: number, profile?: CamProfile): Promise<void> {
    if (this.stopped) return
    const current = this.active.get(deviceId)
    if (!current || current.length === 0) return

    const stalled = profile === undefined ? current : current.filter((r) => r.profile === profile)
    if (stalled.length === 0) return
    const keep = profile === undefined ? [] : current.filter((r) => r.profile !== profile)
    // Only a sibling that FINALIZED a segment within its idle bound is "healthy".
    // When none did, every profile is stalled (a camera without power): the
    // whole-device recovery runs and the log says so — never "keeps recording".
    const now = this.now()
    const producing = keep.filter((r) => this.producedRecently(deviceId, r, now))
    const silentSiblings = keep.filter((r) => !producing.includes(r)).map((r) => r.profile)

    if (keep.length > 0 && producing.length === 0) {
      this.deps.logger.warn(
        'recorder: writer gave up — no profile produced a segment recently (all stalled) — detaching + re-evaluating device',
        { tags: { deviceId }, meta: { profile, stalledSiblings: silentSiblings } },
      )
    } else if (keep.length === 0) {
      this.deps.logger.warn('recorder: writer gave up — detaching + re-evaluating device', {
        tags: { deviceId },
        ...(profile !== undefined ? { meta: { profile } } : {}),
      })
    }
    if (producing.length === 0) {
      try {
        await this.detachDevice(deviceId)
        await this.evaluateDevice(deviceId)
      } catch (err: unknown) {
        this.restore?.add(deviceId, true)
        this.deps.logger.warn(
          'recorder: writer give-up recovery deferred (retries on next broker ready/reconcile)',
          {
            tags: { deviceId },
            meta: { error: errMsg(err) },
          },
        )
      }
      return
    }

    this.deps.logger.warn(
      'recorder: writer gave up — recovering stalled profile, healthy profiles keep recording',
      {
        tags: { deviceId },
        meta: {
          profile: stalled.map((r) => r.profile),
          keeping: producing.map((r) => r.profile),
          // Pinned but no segment yet (inside their grace window): kept pinned,
          // and NOT claimed as recording.
          ...(silentSiblings.length > 0 ? { pinnedWithoutSegment: silentSiblings } : {}),
        },
      },
    )
    try {
      await this.recoverStalledProfiles(deviceId, stalled, keep)
    } catch (err: unknown) {
      this.restore?.add(deviceId, true)
      this.deps.logger.warn(
        'recorder: stalled-profile recovery deferred (retries on next broker ready/reconcile)',
        {
          tags: { deviceId },
          meta: { error: errMsg(err), profile: stalled.map((r) => r.profile) },
        },
      )
    }
  }

  /** Did this writer finalize a segment within its idle bound? Seeding at the pin does not count. */
  private producedRecently(deviceId: number, r: ProfileRecording, now: number): boolean {
    const at = this.lastProducedAt.get(idleKey(deviceId, r.profile))
    return at !== undefined && now - at <= writerIdleBoundMs(r.segmentSeconds)
  }

  /**
   * Tear down only the stalled writers, keep the rest pinned, and retry the
   * missing profiles through {@link fillMissingProfiles}.
   */
  private async recoverStalledProfiles(
    deviceId: number,
    stalled: readonly ProfileRecording[],
    keep: readonly ProfileRecording[],
  ): Promise<void> {
    for (const r of stalled) {
      this.lastSegmentAt.delete(idleKey(deviceId, r.profile))
      this.lastProducedAt.delete(idleKey(deviceId, r.profile))
      this.attachRetained.delete(idleKey(deviceId, r.profile))
    }
    // Drop stalled from `active` BEFORE any await, same invariant as
    // `detachDevice`: a concurrent recover/evaluate must not read the dying
    // writers and compute a stale `keep` that writes them back.
    this.active.set(deviceId, [...keep])
    const skipped = this.skippedProfiles.get(deviceId) ?? new Set<CamProfile>()
    for (const r of stalled) skipped.add(r.profile)
    this.skippedProfiles.set(deviceId, skipped)
    await Promise.all(stalled.map((r) => this.teardownProfile(deviceId, r)))
    const config = await this.deps.loadConfig(deviceId)
    if (this.stopped || this.paused) return
    await this.fillMissingProfiles(deviceId, config)
  }

  /**
   * Find writers that hold a broker pin but have finalized nothing for longer
   * than their idle bound, and recover them through the same path a give-up
   * takes. Per-profile when siblings are still producing (high stall must not
   * unpin the low timeline/scrub writer); whole-device only when every active
   * profile on that camera is silent.
   *
   * The counterpart to `onGaveUp`: that one fires when ffmpeg EXITS, this one
   * when it does not exit and does not work. Both must exist — a branch that
   * drops work has to say so, and the 2026-07-29 loss said nothing at all.
   */
  private async checkIdleWriters(): Promise<void> {
    const now = this.now()
    const stalled: {
      deviceId: number
      profile: CamProfile
      idleMs: number
      boundMs: number
    }[] = []

    for (const [deviceId, recordings] of this.active) {
      for (const r of recordings) {
        const since = this.lastSegmentAt.get(idleKey(deviceId, r.profile))
        if (since === undefined) continue
        const idleMs = now - since
        const boundMs = writerIdleBoundMs(r.segmentSeconds)
        if (idleMs > boundMs) stalled.push({ deviceId, profile: r.profile, idleMs, boundMs })
      }
    }

    for (const s of stalled) {
      this.deps.logger.warn('recorder: writer pinned but no segment finalized — re-pinning', {
        tags: { deviceId: s.deviceId },
        meta: {
          profile: s.profile,
          idleMs: s.idleMs,
          boundMs: s.boundMs,
          segmentSeconds: this.active.get(s.deviceId)?.find((r) => r.profile === s.profile)
            ?.segmentSeconds,
        },
      })
    }

    // Operator-facing stall (NC): longer window than the re-pin bound, one
    // edge per episode. Runs even when every writer was just recovered — the
    // monitor keys on setExpected + last segment, not on this pass's list.
    for (const edge of this.stallMonitor.sweep(now)) {
      this.deps.logger.warn('recorder: recording stalled for Notification Center', {
        tags: { deviceId: edge.deviceId },
        meta: { idleMs: edge.idleMs, thresholdMs: edge.thresholdMs },
      })
      this.deps.emitRecordingHealth?.(EventCategory.RecordingHealthStalled, {
        deviceId: edge.deviceId,
        idleMs: edge.idleMs,
        thresholdMs: edge.thresholdMs,
      })
    }
    // PARALLEL across devices: recovery of device 99 must not wait on device
    // 100's broker RPC. Per device, recover stalled profiles together so two
    // idle writers on the same camera cannot race `active`. Whole-device only
    // when nothing healthy remains. `recoverWriterGaveUp` absorbs its own
    // failures, so no rejection escapes.
    const byDevice = new Map<number, CamProfile[]>()
    for (const s of stalled) {
      const list = byDevice.get(s.deviceId)
      if (list) list.push(s.profile)
      else byDevice.set(s.deviceId, [s.profile])
    }
    await Promise.all(
      [...byDevice.entries()].map(async ([deviceId, profiles]) => {
        const activeCount = this.active.get(deviceId)?.length ?? 0
        if (profiles.length >= activeCount) {
          await this.recoverWriterGaveUp(deviceId)
          return
        }
        for (const profile of profiles) {
          await this.recoverWriterGaveUp(deviceId, profile)
        }
      }),
    )
  }

  /** Current trigger state for a device (cold default = no triggers seen). */
  private triggersFor(deviceId: number): TriggerState {
    return this.triggers.get(deviceId) ?? EMPTY_TRIGGER_STATE
  }

  /**
   * Record a qualifying trigger (motion/audio) for a device and converge: an
   * `events` band whose window this opens attaches now, and the same
   * `evaluateDevice` arms the wake-up that will CLOSE it at
   * `atMs + postBufferSec`. Called from the addon's EventCapture subscription.
   * The qualification test (motion detected / audio over threshold) is done
   * upstream — by the time we're here, it qualified.
   *
   * A fresher trigger re-arms the wake-up later, which is exactly how the
   * sliding window already behaved: continuous motion stays ONE recording,
   * because `evaluateDevice` short-circuits at "already recording — converged"
   * and only the timer moves.
   */
  async onTrigger(deviceId: number, source: TriggerSource, atMs: number): Promise<void> {
    if (this.stopped) return
    // How stale the trigger already is when it reaches us. `atMs` is the
    // DETECTOR's timestamp, so this is bus lag plus the detector's own delay —
    // and it is spent out of the post-buffer before the recorder does anything.
    // A `busLagMs` of 142 173 has been observed on this cluster; at that point
    // the window is closed before the attach and the episode records nothing,
    // silently. Never measured until 2026-08-20.
    const receivedLagMs = this.now() - atMs
    if (receivedLagMs > TRIGGER_LAG_WARN_MS) {
      this.deps.logger.warn(
        'recorder: trigger arrived late — part of its window is already spent',
        { tags: { deviceId }, meta: { source: triggerKey(source), atMs, receivedLagMs } },
      )
    }
    this.recordTriggerWindow(deviceId, source, atMs, await this.postBufferMsFor(deviceId, atMs))
    if (this.stopped) return
    try {
      await this.evaluateDevice(deviceId)
    } catch (err: unknown) {
      // A trigger during the boot window races stream publication: the broker
      // cap is `ready` but the requested profile is not published yet, so the
      // attach throws (`getStreamWithCodec: … not published`). The subscription
      // call site is fire-and-forget (`void onTrigger(...)`), so before this
      // catch the rejection escaped to the process and printed a
      // `[addon-runner CRASH] unhandledRejection` marker once per motion tick
      // (observed 2026-08-01 06:59:30–06:59:53, devices 101/102). The attach is
      // NOT lost: `performAttach` queues the device on the readiness-restore
      // queue before attempting, so it re-attaches on the next broker-ready
      // transition, with the periodic reconcile as backstop. Log the deferral —
      // silence would read as "never happened".
      this.deps.logger.warn(
        'recorder: trigger attach deferred — stream not available yet (retries on next broker ready/reconcile)',
        { tags: { deviceId }, meta: { source: triggerKey(source), atMs, error: errMsg(err) } },
      )
    }
  }

  /**
   * Feed one audio window's LEVEL into the trigger pipeline — the counterpart
   * of `onTrigger('motion', …)` for the `audioThresholdDbfs` source, and the
   * feed that source was missing until 2026-08-26 (D62: authorized by the UI,
   * read by every pure function in `band-decision.ts`, alimented by nobody).
   *
   * Qualification happens HERE, not upstream like motion's `data.detected`,
   * because it depends on a PER-BAND threshold: `audioThresholdDbfs` is
   * authored per band, not once per device, so it needs the same config read
   * {@link postBufferMsFor} already does to resolve which band is active at
   * `atMs` before it can know which threshold applies.
   *
   * Fed from the event bus (telemetry, may be dropped — D8/D11), so a
   * config-read failure here drops only THIS window's qualification test
   * rather than guessing a threshold — logged, never silent, and never fatal:
   * the device's recordability does not depend on any single audio sample,
   * the next window (or motion) can still open the band.
   */
  async onAudioLevel(deviceId: number, dbfs: number, atMs: number): Promise<void> {
    if (this.stopped) return
    let band: RecordingBand | null
    try {
      const config = await this.deps.loadConfig(deviceId)
      band = activeBandAt({ bands: effectiveBands(config) }, new Date(atMs))
    } catch (err: unknown) {
      this.deps.logger.warn('recorder: audio trigger qualification skipped — config read failed', {
        tags: { deviceId },
        meta: { atMs, dbfs, error: errMsg(err) },
      })
      return
    }
    if (!audioLevelQualifies(band, dbfs)) return
    await this.onTrigger(deviceId, { kind: 'audio' }, atMs)
  }

  /**
   * The post-buffer that governs this device's trigger history right now: it is
   * both the MERGE GAP (a trigger landing inside the open live window belongs to
   * the running episode) and the retention horizon. Falls back to the shipped
   * default when the config cannot be read — a trigger must never be lost to a
   * failed config read, and a default window is the conservative choice: it
   * keeps footage rather than dropping it.
   */
  private async postBufferMsFor(deviceId: number, atMs: number): Promise<number> {
    try {
      const config = await this.deps.loadConfig(deviceId)
      const band = activeBandAt({ bands: effectiveBands(config) }, new Date(atMs))
      if (band) return resolveBandBufferMs(band).postMs
    } catch (err: unknown) {
      this.deps.logger.warn(
        'recorder: trigger history using the DEFAULT post-buffer — config read failed',
        { tags: { deviceId }, meta: { atMs, error: errMsg(err) } },
      )
    }
    return DEFAULT_EVENTS_BAND_BUFFER_SEC.postBufferSec * 1000
  }

  /**
   * Fold a qualifying trigger into this device's history and prune what can no
   * longer keep anything. Synchronous and self-contained so the write cannot
   * interleave with an await.
   */
  private recordTriggerWindow(
    deviceId: number,
    source: TriggerSource,
    atMs: number,
    postMs: number,
  ): void {
    const pruned = pruneTriggerHistory(this.triggersFor(deviceId), postMs, this.now())
    const { state, evicted } = recordTrigger(pruned, source, atMs, postMs)
    this.triggers.set(deviceId, state)
    if (evicted > 0) {
      // Evicting a window can only DROP footage that was asked for — the keep
      // gate stops recognising the episode it described. Never silent.
      this.deps.logger.warn(
        'recorder: trigger history full — oldest window(s) evicted, their footage may be discarded',
        {
          tags: { deviceId },
          meta: {
            source: triggerKey(source),
            atMs,
            postMs,
            evicted,
            maxWindows: MAX_TRIGGER_WINDOWS,
          },
        },
      )
    }
  }

  /**
   * Decide-and-converge for one device: if its active band demands recording now
   * (continuous always; events within `postBufferSec` of a trigger) and the
   * device is enabled, ensure its writer set is running; otherwise stop it.
   * Re-attaches via the readiness queue if the broker is not ready (the broker
   * call throws → `ReadinessRestore.attempt` defers → retried on next ready).
   */
  private async evaluateDevice(deviceId: number): Promise<void> {
    if (this.stopped || this.paused) return
    const config = await this.deps.loadConfig(deviceId)
    if (this.stopped || this.paused) return
    const wantRecording = shouldRecordAt(config, this.triggersFor(deviceId), new Date(this.now()))
    // NC stall monitor: expected iff the band decision says we should write.
    // Switched-off / disabled / out-of-window clears the episode without a
    // "healthy" recovery (that would look like a fault that cured itself).
    this.stallMonitor.setExpected(deviceId, wantRecording, this.now())

    // Arm the next wake-up from the SAME config and trigger state the decision
    // was just made against, and BEFORE the attach/detach work: the schedule
    // does not depend on whether the attach succeeds, and a device whose attach
    // throws must still get its band edge.
    this.scheduleNextDecision(deviceId, config)

    if (!wantRecording) {
      this.reportUnrecordable(deviceId, config)
      await this.detachDevice(deviceId)
      // Drop it from the restore queue: a disabled device must not be retried on
      // the next broker ready. It re-enters via `onConfigChanged` when re-enabled.
      this.restore?.remove(deviceId)
      return
    }

    this.unrecordableReported.delete(deviceId)
    if (this.active.has(deviceId)) {
      // Already pinned — do not re-run a full attach (that would duplicate
      // writers). Retry only profiles the last pass skipped.
      if (this.skippedProfiles.has(deviceId)) {
        await this.fillMissingProfiles(deviceId, config)
      }
      return
    }
    // Coalesce concurrent attaches: set synchronously (no await before this) so a
    // second evaluate pass in the same tick sees the in-flight attach and returns
    // instead of spawning a DUPLICATE writer set.
    if (this.attaching.has(deviceId)) {
      // A trigger arriving while an attach is already in flight is DROPPED, not
      // queued: it returns here and never re-evaluates. That is usually right
      // (the in-flight attach is about to pin the same device) but it is not
      // free — if that attach then fails, this trigger's window is served only
      // by the reconcile beat, up to RECONCILE_TICK_MS later. It used to be
      // completely silent, so a zero-footage episode caused this way was
      // indistinguishable from one that never triggered.
      this.deps.logger.debug('recorder: evaluate coalesced into an in-flight attach', {
        tags: { deviceId },
        meta: { reconcileTickMs: RECONCILE_TICK_MS },
      })
      return
    }
    this.attaching.add(deviceId)
    const attaching = this.performAttach(deviceId, config)
    this.attachingTasks.set(deviceId, attaching)
    try {
      await attaching
    } finally {
      this.attachingTasks.delete(deviceId)
      this.attaching.delete(deviceId)
    }
  }

  /**
   * Name the `!wantRecording` drop when the device is ENABLED but its config can
   * never produce footage — the branch that hid this bug. Two shapes qualify,
   * and both mean "the operator asked for recording and will get none, forever":
   * an enabled config with no bands at all, and an `events` band that cannot
   * open a live window (no trigger listed, or an explicit `postBufferSec: 0`).
   *
   * NOT reported: a band that simply does not cover `now` (a night-only band at
   * noon), or an events band waiting for its next trigger. Those are the
   * feature working.
   *
   * One line per device until it records again ({@link unrecordableReported} is
   * cleared the moment `wantRecording` turns true), so the 30 s tick cannot turn
   * this into a log flood.
   */
  private reportUnrecordable(deviceId: number, config: RecordingConfig): void {
    if (!config.enabled) return
    if (this.unrecordableReported.has(deviceId)) return
    const bands = effectiveBands(config)
    if (bands.length === 0) {
      this.unrecordableReported.add(deviceId)
      this.deps.logger.warn(
        'recorder: device is enabled but has no recording bands — nothing will ever be recorded',
        { tags: { deviceId } },
      )
      return
    }
    const band = activeBandAt({ bands }, new Date(this.now()))
    if (band === null || eventsBandCanEverDemand(band)) return
    this.unrecordableReported.add(deviceId)
    this.deps.logger.warn(
      'recorder: events band can never open a recording window — nothing will ever be recorded',
      {
        tags: { deviceId },
        meta: {
          postBufferSec: band.postBufferSec,
          triggers: band.triggers,
          reason:
            bandTriggerSources(band).length > 0 ? 'postBufferSec is 0' : 'no trigger configured',
        },
      },
    )
  }

  /**
   * Throw before spending a single broker RPC when the registry already says the
   * `stream-broker` on the owner node is not ready. See
   * {@link RecordingControllerDeps.brokerReady}; absent → assume ready.
   */
  private failFastIfBrokerCold(deviceId: number): void {
    if (this.deps.brokerReady?.() !== false) return
    throw new Error(
      `recorder controller: stream-broker not ready on ${this.deps.ownerNodeId} — attach for device ${deviceId} deferred to the next ready transition`,
    )
  }

  /**
   * The attach body — extracted so the {@link attaching} in-flight guard in
   * `evaluateDevice` wraps it cleanly. Resolves the profiles, spawns a
   * SegmentWriter + watcher per profile, and records the set in `active`.
   *
   * Per-profile: a throw from one slot is logged and skipped. Rolling back the
   * whole device when a single stream was dead (108 `derived` on `low`) left
   * ZERO footage for hours. If every profile fails, throw so the restore queue
   * retries the device.
   */
  /**
   * Wake `deviceId` if it is a sleeping battery camera, once per device at a
   * time. Concurrent attaches (two profiles, a trigger racing the reconcile)
   * join the in-flight wake instead of issuing a second one at the radio.
   */
  private async wakeBatteryDevice(deviceId: number): Promise<void> {
    const inFlight = this.batteryWakes.get(deviceId)
    if (inFlight) {
      await inFlight
      return
    }
    const wake = this.runBatteryWake(deviceId)
    this.batteryWakes.set(deviceId, wake)
    try {
      await wake
    } finally {
      this.batteryWakes.delete(deviceId)
    }
  }

  /** One wake attempt, fully reported. Absorbs its own failures. */
  private async runBatteryWake(deviceId: number): Promise<void> {
    const api = this.deps.api
    const result = await wakeForRecording(deviceId, {
      // The DEVICE registry, never the published cam-streams: there are none —
      // that is precisely why we are here.
      // BOUNDED. These two reads sit on the attach critical path, ahead of
      // every broker call, and an unbounded UDS round-trip here delays the
      // writer spawn for a camera that is not even battery-powered. A read that
      // times out yields `null` -> UNKNOWN -> no wake, which is the same safe
      // outcome as a read that failed (D49).
      isBatteryDevice: async (id) => {
        const dev = await withDeadline(
          api.deviceManager.getDevice.query({ deviceId: id }),
          BATTERY_READ_TIMEOUT_MS,
          'getDevice',
        ).catch(() => null)
        if (!dev) return null
        return dev.features.includes(DeviceFeature.BatteryOperated)
      },
      readBatteryFacts: async (id) => {
        const slice = await withDeadline(
          api.deviceState.getCapSlice.query({
            deviceId: id,
            capName: batteryCapability.name,
          }),
          BATTERY_READ_TIMEOUT_MS,
          'getCapSlice',
        ).catch(() => null)
        const parsed = BatteryStatusSchema.safeParse(slice)
        if (!parsed.success) return null
        return {
          sleeping: parsed.data.sleeping,
          lastContactAt: parsed.data.lastContactAt,
        }
      },
      wakeForStream: async (id, timeoutMs) =>
        api.battery.wakeForStream.mutate({ deviceId: id, timeoutMs }),
      nowMs: () => this.now(),
    })

    if (result.outcome === 'not-battery' || result.outcome === 'unknown') return

    const meta = {
      outcome: result.outcome,
      ...(result.durationMs !== undefined ? { wakeMs: result.durationMs } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    }
    if (wakeOutcomeLosesFootage(result.outcome)) {
      // This episode is about to record nothing, and until 2026-08-20 that
      // outcome produced not one line: camera 3629 lost 48.9 % of its episodes
      // silently. A branch that drops footage names itself.
      this.deps.logger.warn(
        'recorder: battery camera not woken for this trigger — the episode may record NOTHING',
        { tags: { deviceId }, meta },
      )
      return
    }
    this.deps.logger.info('recorder: battery camera ready for recording', {
      tags: { deviceId },
      meta,
    })
  }

  private async performAttach(deviceId: number, config: RecordingConfig): Promise<void> {
    // Keep the device in the restore queue while it wants recording: if the
    // attach below throws (broker not ready), it is retried on the next
    // `stream-broker` ready transition (and the periodic reconcile). Re-adding is
    // idempotent and removed on success by the queue.
    this.restore?.add(deviceId, true)

    // Cheapest question first. A cold broker cannot serve this attach, and
    // finding that out by DIALLING costs a 10 s readiness gate plus up to a 20 s
    // RPC bound per profile — per device, on a pass that runs over the whole
    // fleet. The throw is the same signal a failed dial would have produced, so
    // the device stays pending on the readiness queue and is re-attempted the
    // instant the broker reports ready. Not logged here on purpose: every caller
    // already names the deferral per-device with this message attached, and a
    // fleet-wide pass against a down broker would otherwise emit it twice.
    this.failFastIfBrokerCold(deviceId)

    // A battery camera is ASLEEP between events, so the source the profile
    // resolution below is about to ask for does not exist yet. Wake it first —
    // a recording trigger is demand in exactly the sense D173 defines. Bounded,
    // single-flighted per device, and never fatal: a wake that fails still
    // falls through to the attach, whose failure re-queues the device on the
    // readiness queue as it always did.
    await this.wakeBatteryDevice(deviceId)

    // Resolve which profiles to record (broker-assigned slots, deduped by source,
    // intersected with the operator's profile selection). Gated on broker ready.
    const profiles = await this.resolveProfiles(deviceId, config.profiles)
    if (profiles.length === 0) {
      throw new Error(`recorder controller: no assigned broker sources for device ${deviceId}`)
    }
    const segmentSeconds = config.segmentSeconds ?? this.deps.segmentSeconds
    const bandAudio = bandAudioAt(config, new Date(this.now()))
    await this.sweepDeviceStaging(deviceId, segmentSeconds)

    const recordings: ProfileRecording[] = []
    const failed: CamProfile[] = []
    for (const profile of profiles) {
      try {
        recordings.push(await this.attachProfile(deviceId, profile, segmentSeconds, bandAudio))
      } catch (err: unknown) {
        failed.push(profile)
        this.deps.logger.warn(
          'recorder: profile attach failed — recording the remaining profiles',
          { tags: { deviceId }, meta: { profile, error: errMsg(err) } },
        )
      }
    }
    if (recordings.length === 0) {
      throw new Error(
        `recorder controller: no profile attached for device ${deviceId}` +
          (failed.length > 0 ? ` (failed: ${failed.join(',')})` : ''),
      )
    }
    // A storage-migration pause can arrive while the broker/profile awaits
    // above are in flight. Do not publish a fresh writer after that lease has
    // been acquired; drain the partial attach instead.
    if (this.paused) {
      await Promise.all(recordings.map((recording) => this.teardownProfile(deviceId, recording)))
      return
    }
    this.active.set(deviceId, recordings)
    if (failed.length > 0) this.skippedProfiles.set(deviceId, new Set(failed))
    else this.skippedProfiles.delete(deviceId)
    // The writers' RTSP reads are now persistent consumers on the broker
    // source(s) — they keep the source materialized 24/7 (independent of any
    // live viewer) for as long as the band demands recording. Logged as a pin so
    // the next recording gap is diagnosable from the recorder scope alone.
    this.deps.logger.info('recorder pinned broker source(s) for recording', {
      tags: { deviceId },
      meta: {
        profiles: recordings.map((r) => r.profile),
        failedProfiles: failed,
        segmentSeconds,
        pipelineKeys: recordings.map((r) => r.pipelineKey),
      },
    })
  }

  /**
   * Retry profiles the last attach skipped, without tearing down writers that
   * are already producing. Called from `evaluateDevice` when the device is
   * already in `active` and {@link skippedProfiles} is non-empty. Failures stay
   * logged; the next converge tick retries.
   */
  private async fillMissingProfiles(deviceId: number, config: RecordingConfig): Promise<void> {
    if (this.attaching.has(deviceId)) return
    const current = this.active.get(deviceId)
    const skipped = this.skippedProfiles.get(deviceId)
    if (!current || !skipped || skipped.size === 0) return
    this.attaching.add(deviceId)
    const filling = this.runFillMissingProfiles(deviceId, config, current, skipped)
    this.attachingTasks.set(deviceId, filling)
    try {
      await filling
    } finally {
      this.attachingTasks.delete(deviceId)
      this.attaching.delete(deviceId)
    }
  }

  private async runFillMissingProfiles(
    deviceId: number,
    config: RecordingConfig,
    current: ProfileRecording[],
    skipped: Set<CamProfile>,
  ): Promise<void> {
    // Same cheap question as `performAttach`: this is a RETRY of profiles that
    // already failed once, so spending a readiness gate plus a 20 s RPC bound per
    // skipped profile against a broker the registry calls cold buys nothing. The
    // healthy profiles keep recording; the next reconcile retries.
    if (this.deps.brokerReady?.() === false) {
      this.deps.logger.info(
        'recorder: skipped-profile retry deferred — stream-broker not ready (healthy profiles keep recording)',
        {
          tags: { deviceId },
          meta: { profiles: [...skipped], ownerNodeId: this.deps.ownerNodeId },
        },
      )
      return
    }
    const have = new Set(current.map((r) => r.profile))
    const segmentSeconds = config.segmentSeconds ?? this.deps.segmentSeconds
    const bandAudio = bandAudioAt(config, new Date(this.now()))
    await this.sweepDeviceStaging(deviceId, segmentSeconds)
    const added: ProfileRecording[] = []
    for (const profile of [...skipped]) {
      if (have.has(profile)) {
        skipped.delete(profile)
        continue
      }
      try {
        added.push(await this.attachProfile(deviceId, profile, segmentSeconds, bandAudio))
        skipped.delete(profile)
      } catch (err: unknown) {
        this.deps.logger.warn(
          'recorder: profile attach retry failed — keeping the healthy profiles',
          { tags: { deviceId }, meta: { profile, error: errMsg(err) } },
        )
      }
    }
    if (skipped.size === 0) this.skippedProfiles.delete(deviceId)
    if (added.length === 0) return
    const existing = this.active.get(deviceId)
    if (!existing || this.paused || this.stopped) {
      await Promise.all(added.map((recording) => this.teardownProfile(deviceId, recording)))
      return
    }
    this.active.set(deviceId, [...existing, ...added])
    this.deps.logger.info('recorder pinned additional broker source(s) for recording', {
      tags: { deviceId },
      meta: {
        profiles: added.map((r) => r.profile),
        pipelineKeys: added.map((r) => r.pipelineKey),
      },
    })
  }

  /**
   * Pick which profiles to record. The broker enumerates assigned profile slots,
   * deduped by physical source (`selectAssignedProfileSlots`) so the same camera
   * encoder is never recorded twice. Default is high+low among those slots
   * (`resolveRecordingProfiles`); an operator `override` DISABLES the
   * unselected profiles. A selection matching none of the assigned sources
   * falls back to the default/assigned set (minimum of 1 when anything is assigned).
   */
  private async resolveProfiles(
    deviceId: number,
    override: readonly CamProfile[] | undefined,
  ): Promise<readonly CamProfile[]> {
    const slots = await this.deps.brokerCall(() =>
      withDeadline(
        this.deps.api.streamBroker.listAllProfileSlots.query(
          undefined,
          nodePin(this.deps.ownerNodeId),
        ),
        ATTACH_RPC_TIMEOUT_MS,
        'listAllProfileSlots',
      ),
    )
    const assigned = selectAssignedProfileSlots(slots, deviceId).map((slot) => slot.profile)
    return resolveRecordingProfiles(assigned, override)
  }

  /**
   * Entry counts of every long-lived container this controller holds, for the
   * recorder's 5-minute census line. Sizes only — no walk of anything that
   * grows with the archive.
   */
  memoryCensus(): RecordingControllerCensus {
    let writers = 0
    for (const recordings of this.active.values()) writers += recordings.length
    let skippedProfiles = 0
    for (const skipped of this.skippedProfiles.values()) skippedProfiles += skipped.size
    return {
      activeDevices: this.active.size,
      // One watcher per writer: they are created and stopped together.
      writers,
      attaching: this.attaching.size,
      attachingTasks: this.attachingTasks.size,
      drainedPlaylists: this.drainedPlaylists.size,
      batteryWakes: this.batteryWakes.size,
      triggers: this.triggers.size,
      signalConfirmedAt: this.signalConfirmedAt.size,
      signalContradictions: this.signalContradictions.size,
      lastSegmentAt: this.lastSegmentAt.size,
      attachRetained: this.attachRetained.size,
      unrecordableReported: this.unrecordableReported.size,
      skippedProfileDevices: this.skippedProfiles.size,
      skippedProfiles,
    }
  }

  /**
   * Pids of every ffmpeg this controller started and has not seen exit —
   * the live writers and the ones still being torn down. Never reaped by the
   * staging guard (D667).
   */
  ownedWriterPids(): ReadonlySet<number> {
    const pids = new Set<number>()
    const add = (writer: SegmentWriter): void => {
      const pid = writer.pid
      if (pid !== undefined) pids.add(pid)
    }
    for (const recordings of this.active.values()) {
      for (const recording of recordings) add(recording.writer)
    }
    for (const writer of this.retiring) add(writer)
    return pids
  }

  /**
   * Every staging directory of this camera, on every location, in ONE table
   * read and one SIGTERM → SIGKILL window (D667) — so an attach of three
   * profiles does not pay three reaps in series. The per-spawn claim below
   * still runs; after this it is one cached read.
   */
  private async sweepDeviceStaging(deviceId: number, segmentSeconds: number): Promise<void> {
    const guard = this.deps.stagingGuard
    if (guard === undefined) return
    const result = await guard.sweep({
      roots: this.deps.locations().map((location) => location.root),
      deviceId,
      ownPids: this.ownedWriterPids(),
    })
    if (result.outcome !== 'swept' || result.reaped.length === 0) return
    // A directory an own writer is live on is not recovered here: its watcher
    // owns the recent names, and a relocate would race it. The boot recovery
    // reaches what is left.
    const liveDirs = new Set((this.active.get(deviceId) ?? []).map((r) => r.outDir))
    await this.recoverReaped(
      result.reaped.filter((writer) => !liveDirs.has(writer.target.outDir)),
      segmentSeconds,
    )
  }

  /**
   * Collect what each reaped writer left in its directory before a new writer
   * is spawned into it (D667). Logged per directory with the counts, and a
   * directory that could not be recovered says so — its segments stay staged
   * for the next boot.
   */
  private async recoverReaped(
    reaped: readonly ReapedWriter[],
    segmentSeconds: number,
  ): Promise<void> {
    const cutoffMs = this.now()
    const dirs = new Map<string, ReapedWriter>()
    for (const writer of reaped) dirs.set(writer.target.outDir, writer)
    for (const writer of dirs.values()) {
      const { target } = writer
      const location = this.deps.locations().find((l) => l.root === target.root)
      const recover = this.deps.recoverStagingDirectory
      if (location === undefined || recover === undefined) {
        this.deps.logger.warn(
          'recorder: a reaped writer’s segments were left in staging — recovered at the next boot',
          {
            tags: { deviceId: target.deviceId },
            meta: {
              profile: target.profile,
              dir: target.outDir,
              reason: location === undefined ? 'location-unknown' : 'no-recovery-wired',
            },
          },
        )
        continue
      }
      try {
        const report = await recover({
          deviceId: target.deviceId,
          profile: target.profile,
          locationId: location.id,
          locationRoot: location.root,
          dir: target.outDir,
          cutoffMs,
          segmentSeconds,
        })
        this.deps.logger.info(
          'recorder: recovered a reaped writer’s segments before re-attaching',
          {
            tags: { deviceId: target.deviceId },
            meta: { profile: target.profile, dir: target.outDir, pid: writer.pid, ...report },
          },
        )
      } catch (err: unknown) {
        this.deps.logger.warn(
          'recorder: recovering a reaped writer’s segments failed — left in staging for the next boot',
          {
            tags: { deviceId: target.deviceId },
            meta: { profile: target.profile, dir: target.outDir, error: errMsg(err) },
          },
        )
      }
    }
  }

  /**
   * Make sure nobody else is writing `outDir` before a writer is spawned into
   * it (D667). A predecessor runner that died without a shutdown (V8 OOM,
   * SIGKILL) leaves its ffmpeg writers running, and a second writer in the
   * same directory rewrites the first one's playlist — 13 minutes and 169
   * writer churns on 2026-09-28. The guard reaps such a writer; one it cannot
   * remove is a refusal, and a refusal throws so no writer is spawned.
   */
  private async claimStagingDirectory(
    deviceId: number,
    profile: CamProfile,
    root: string,
    outDir: string,
    segmentSeconds: number,
  ): Promise<void> {
    const guard = this.deps.stagingGuard
    if (guard === undefined) return
    const result = await guard.claim({
      deviceId,
      profile,
      root,
      outDir,
      ownPids: this.ownedWriterPids(),
    })
    if (result.outcome === 'clear' && result.reaped.length > 0) {
      await this.recoverReaped(result.reaped, segmentSeconds)
    }
    if (result.outcome === 'refused') {
      throw new Error(
        `staging directory ${outDir} still has ${result.survivors.length} foreign writer(s) ` +
          `(pids ${result.survivors.map((proc) => proc.pid).join(',')}) — refusing to co-write`,
      )
    }
  }

  /**
   * Attach one (device, profile): acquire the broker source, mkdir the staging
   * outDir UNDER the profile's placement root (same-fs relocate — see
   * {@link STAGING_DIR_NAME}), spawn the SegmentWriter, and start the watcher
   * that feeds finalized flat segments into `SegmentStore.onFinalized`.
   */
  private async attachProfile(
    deviceId: number,
    profile: CamProfile,
    segmentSeconds: number,
    audio: RecordingBandAudio,
  ): Promise<ProfileRecording> {
    const attachProfileStartMs = this.now()
    // The cheap question first: no pinned binary, no writer — so nothing is
    // placed, claimed or dialled for it.
    let ffmpegPath: string
    try {
      ffmpegPath = await this.deps.resolveFfmpeg()
    } catch (err: unknown) {
      this.deps.logger.error('recorder: writer refused — no pinned ffmpeg on this node (D540)', {
        tags: { deviceId },
        meta: { profile, error: errMsg(err) },
      })
      throw new Error(`recorder: no pinned ffmpeg for device ${deviceId}/${profile}`)
    }
    // Per-profile location: `low` → recordingsLow root, others → recordings
    // root. Resolved BEFORE the ffmpeg outDir so staging shares the final
    // volume (throws when no location is resolved — attach retried later).
    const placement = await this.resolvePlacement(deviceId, profile)
    const placementDoneMs = this.now()
    const outDir = path.join(placement.root, STAGING_DIR_NAME, String(deviceId), profile)

    // One writer per staging directory (D667) — asked BEFORE the broker dial,
    // so a refusal costs no stream session. Throws on a refusal; the caller
    // logs it as a failed profile attach and the next reconcile retries.
    await this.claimStagingDirectory(deviceId, profile, placement.root, outDir, segmentSeconds)
    const claimDoneMs = this.now()

    const source = await this.deps.brokerCall(() =>
      withDeadline(
        this.deps.api.streamBroker.getStreamWithCodec.mutate(
          {
            deviceId,
            video: 'copy',
            // A band that asked for silence takes the VIDEO-ONLY `/muted`
            // restream, which is what `audio: 'none'` selects. Absent on the
            // band means `on`, so every camera nobody configured keeps
            // recording sound exactly as it did.
            audio: audio === 'muted' ? 'none' : 'aac',
            profile,
            // Hub-local when undefined; the hub's cluster-resolvable host when this
            // recorder runs on a remote designated recording node (cross-node pull).
            ...(this.deps.consumerHostname !== undefined
              ? { hostname: this.deps.consumerHostname }
              : {}),
            tag: `recorder:${deviceId}/${profile}`,
          },
          nodePin(this.deps.ownerNodeId),
        ),
        ATTACH_RPC_TIMEOUT_MS,
        'getStreamWithCodec',
      ),
    )

    const streamAcquiredMs = this.now()

    // Declare the RECORDING intent on the dial. The broker serves a dial that
    // declared it the PRE-ROLL window its ring already retains instead of the
    // current GOP, so the first segment this writer produces begins BEFORE the
    // trigger that spawned it. Without it a recorder's footage starts at the
    // live edge by construction — measured on 1438, after the motion in 60 % of
    // episodes.
    //
    // The pre-roll's DURATION is still the broker's: the recorder asks for
    // `RECORDING_PRE_ROLL_REQUEST_MS` — "as much as you kept" — and is answered
    // with the smaller of that and what the ring actually held
    // (`getRtpPreRollBuffer` degrades to the current GOP when the source had
    // not been warm long enough). The ASK is stated rather than omitted (D382):
    // an omitted ask used to mean the whole window, so a consumer could be
    // served history it had never decided it wanted, and no line said which of
    // the two had happened.
    //
    // A no-op on a muted url (a device recorded without audio): that session is
    // already the detection population's shape and the suffix would only break
    // the token lookup.
    const rtspUrl = withRecordingIntent(source.url, RECORDING_PRE_ROLL_REQUEST_MS)
    // The one identity that reaches the broker. See {@link attachSeq}.
    this.attachSeq++
    const consumerTag = `recorder/${deviceId}/${profile}/${this.attachSeq}`
    if (rtspUrl === source.url) {
      // Not an error — but it means this writer gets NO pre-roll, and a first
      // segment that starts at the trigger. Silence would make that
      // indistinguishable from a configured pre-roll the ring could not fill.
      this.deps.logger.info('recorder: dial carries no recording intent — no pre-roll', {
        tags: { deviceId },
        meta: { profile, url: source.url },
      })
    }

    await fs.mkdir(outDir, { recursive: true })
    const mkdirDoneMs = this.now()

    // Device-scoped child logger: the writer + watcher emit per-camera lines
    // (segment finalize/restart/give-up) but see only a string `outDir`, not a
    // numeric deviceId — bind it here so those lines carry the deviceId tag the
    // per-device log viewer filters on.
    const deviceLog = this.deps.logger.withTags({ deviceId })

    const writer = new SegmentWriter(
      // Pass the source video codec through so the passthrough muxer writes the
      // Apple-correct `hvc1` sample entry for HEVC (`-tag:v hvc1`, still copy).
      { rtspUrl, outDir, segmentSeconds, videoCodec: source.videoCodec, consumerTag },
      {
        spawn: this.deps.spawn,
        ffmpegPath,
        logger: deviceLog,
        // The writer tags its own lines with this. `deviceLog` already binds
        // the same value, but a convention the caller can forget is not a
        // guarantee — and every restart line is read per camera.
        deviceId,
        // The recorder knows it is starting an ffmpeg for THIS camera on THIS
        // profile. Nothing has to deduce it: the claim is taken here, at the
        // spawn, and released by the writer the moment that generation ends.
        claimCost: (pid) =>
          this.deps.costRegistry?.claim({
            role: 'recording',
            deviceId,
            unit: `${deviceId}/${profile}`,
            pid,
          }) ?? NO_COST_CLAIM,
        // The writer exhausted its bounded inner restarts and stopped. Recover
        // THIS profile; siblings that are still producing stay pinned (high
        // stall must not unpin the low timeline/scrub writer). Whole-device
        // detach only when nothing healthy remains, so the next evaluate can
        // re-dial a clean set. OUTER bounded retry — slow (RECONCILE_TICK_MS /
        // fillMissingProfiles cadence), never a tight respawn loop.
        onGaveUp: () => {
          const degraded = this.stallMonitor.noteDegraded(
            deviceId,
            `writer gave up on profile ${profile}`,
            this.now(),
          )
          if (degraded !== null) {
            this.deps.logger.warn('recorder: recording degraded (restart budget exhausted)', {
              tags: { deviceId },
              meta: { profile, message: degraded.message },
            })
            this.deps.emitRecordingHealth?.(EventCategory.RecordingHealthDegraded, {
              deviceId,
              message: degraded.message,
            })
          }
          void this.recoverWriterGaveUp(deviceId, profile)
        },
        // The host could not fork. This is a property of the NODE, not of this
        // camera — every other writer dialling in this wave is about to hit
        // it too — so it narrows the fleet-wide attach bound rather than being
        // absorbed as one camera's bad luck.
        onResourcePressure: () => this.spawnPressure.report(deviceId),
      },
    )
    // Stamped BEFORE the spawn, so no segment this ffmpeg produces can be named
    // earlier than the mark. ffmpeg's `-segment_list` file is NOT cleared
    // between runs and the watcher below starts at `processed = 0`, so without
    // this the first passes replay the previous run's playlist and chase files
    // that were relocated hours ago (83% of all retries, measured 08-10..13).
    const writerStartedMs = this.now()
    writer.start()

    // THE attach measurement. Until 2026-08-20 nothing on this path recorded a
    // duration, so "motion at 14:21:38, footage at 14:22:20" (camera 1436) had
    // no attributable cause: placement probe, broker RPC, mkdir and ffmpeg
    // spawn were one opaque 42 s. Each phase is separated here because they
    // fail for unrelated reasons — a slow statfs on a FUSE volume and a cold
    // broker look identical in a single total.
    this.deps.logger.info('recorder: writer spawned', {
      tags: { deviceId },
      meta: {
        profile,
        // The broker prints this same string on `restream pre-roll served` and
        // `restream pre-roll replay done`. It is the ONLY way to ask "did the
        // window the broker measured reach THIS writer".
        consumer: consumerTag,
        placementMs: placementDoneMs - attachProfileStartMs,
        // The staging-directory check (D667): a table read, plus the reap
        // grace when a predecessor's writer was still there.
        claimMs: claimDoneMs - placementDoneMs,
        getStreamMs: streamAcquiredMs - claimDoneMs,
        mkdirMs: mkdirDoneMs - streamAcquiredMs,
        attachProfileMs: writerStartedMs - attachProfileStartMs,
        segmentSeconds,
      },
    })

    // Start the liveness clock at the PIN, not at the first segment: the 68-minute
    // loss was a writer that never produced a first one.
    this.lastSegmentAt.set(idleKey(deviceId, profile), this.now())

    // Whether THIS attach has logged its first segment. Owned by the attach's
    // own finalize callback, never by a (device, profile) key: a shared latch
    // was cleared BEFORE the teardown flush, so the flush's final segment
    // re-latched it — logged as "first segment" with the writer's whole
    // lifetime as the delay — and the stale latch then swallowed the NEXT
    // attach's genuine line (audit of camera 3836, 2026-09-28).
    let firstSegmentSeen = false
    const drainKey = path.resolve(outDir)
    const drainedPredecessor = this.drainedPlaylists.get(drainKey) ?? null
    // Consumed, not peeked: this watcher's own drain re-arms it.
    this.drainedPlaylists.delete(drainKey)
    const watcher = (this.deps.startWatcher ?? startSegmentWatcher)({
      outDir,
      drainedPredecessor,
      onDrained: (drained) => {
        this.drainedPlaylists.set(drainKey, drained)
      },
      // Not deduced from the output directory and not inherited from the bound
      // logger: every line this watcher writes is read per camera (D521).
      deviceId,
      writerStartedMs,
      now: () => this.now(),
      // The playlist rolled past entries nobody handled. The hour ledger is
      // about to be asked whether those hours are COMPLETE, and this is the
      // only moment anything knows they are not.
      onSegmentsMissed: (missed) => {
        this.deps.onSegmentsMissed?.(missed, profile)
      },
      intervalMs:
        this.deps.watchIntervalMs > 0 ? this.deps.watchIntervalMs : DEFAULT_WATCH_INTERVAL_MS,
      onFinalized: async (startMs, durMs, flatAbsPath) => {
        const segmentAt = this.now()
        this.lastSegmentAt.set(idleKey(deviceId, profile), segmentAt)
        this.lastProducedAt.set(idleKey(deviceId, profile), segmentAt)
        const recovered = this.stallMonitor.noteSegment(deviceId, segmentAt)
        if (recovered !== null) {
          this.deps.emitRecordingHealth?.(EventCategory.RecordingHealthOk, {
            deviceId: recovered.deviceId,
          })
        }
        // The FIRST segment of an attach measures what `FIRST_SEGMENT_GRACE_MS`
        // is supposed to bound: how long after the spawn ffmpeg managed to name
        // a file. The constant is 5 s, sized from a 3.2 s observation; camera
        // 1439 was measured at 25 s in the field, which silently costs the whole
        // pull. Log it so the bound is set from data, not from one sample.
        // ONLY a segment this writer could have produced. On a restart the
        // first things through this callback are staging orphans recovered from
        // the PREVIOUS run: measured live on 2026-08-20, they reported
        // `spawnToFirstSegmentMs: -2650308` (minus 44 minutes) and would have
        // made the very latency this line exists to measure unreadable. A
        // segment named before the spawn is not this attach's first — skip it
        // WITHOUT latching, so the real first segment is still measured.
        if (startMs >= writerStartedMs - PREVIOUS_RUN_SKEW_MS && !firstSegmentSeen) {
          firstSegmentSeen = true
          this.deps.logger.info('recorder: first segment of this attach', {
            tags: { deviceId },
            meta: {
              profile,
              consumer: consumerTag,
              // The file to point `ffprobe` at.
              //
              // `startMs` — this segment's `-strftime` name — DOES NOT MEAN
              // "when the media in it begins", and for the FIRST segment of an
              // attach it does not even mean "when the file started filling".
              // The broker's SDP carries `sprop-vps/sps/pps`, so ffmpeg's
              // `avformat_find_stream_info` returns without reading a single
              // packet and the segment muxer opens (and NAMES) file #1 at
              // spawn — before the RTSP prime has been served. The file then
              // sits empty until the burst lands, and the media inside begins
              // one whole pre-roll window before the live edge at that instant.
              // Measured 2026-08-20 by hand-running this exact argv against a
              // `/recording` dial: 30.09 s of wall clock, 40.05 s of media.
              // So the NAME cannot answer any question about the pre-roll, and
              // the path has to be printed for `ffprobe` to answer it.
              file: path.basename(flatAbsPath),
              // The MEDIA duration (`#EXTINF`). NOT independent evidence for a
              // first segment: `segment-watcher` clamps a first `#EXTINF` to
              // the successor's start, so for THIS line it can be derived from
              // the very names that lie. Read it against `segmentSeconds` as a
              // sanity check, never as a burst measurement — the burst is
              // measured on the broker side (`restream pre-roll served`) and
              // confirmed with `ffprobe` on `file`.
              durMs,
              spawnToFirstSegmentMs: startMs - writerStartedMs,
              finalizeLagMs: this.now() - (startMs + durMs),
              graceMs: FIRST_SEGMENT_GRACE_MS,
              segmentSeconds,
            },
          })
        }
        await this.handleFinalizedSegment(
          deviceId,
          profile,
          placement,
          // The LIVE gate's decision, carried to the KEEP gate: a segment this
          // attach could not physically have produced any sooner is kept even
          // if the demand window closed while ffmpeg was still dialling.
          { attachedAtMs: writerStartedMs, segmentSeconds },
          startMs,
          durMs,
          flatAbsPath,
        )
      },
      logger: deviceLog,
    })

    return {
      profile,
      writer,
      watcher,
      pipelineKey: source.pipelineKey,
      outDir,
      segmentSeconds,
      audio,
    }
  }

  /**
   * Index a finalized segment — unless it was recorded under an `events` band
   * and falls OUTSIDE every trigger's `[trigger-preBufferSec, trigger+postBufferSec]`
   * window, in which case it is discarded (deleted, never indexed). Continuous
   * footage (or any segment with no active events band) is always indexed: the
   * keep/discard gate touches `events`-mode segments only, so the continuous
   * path is unchanged.
   */
  private async handleFinalizedSegment(
    deviceId: number,
    profile: CamProfile,
    placement: RecordingsLocation,
    attach: AttachWindow,
    startMs: number,
    durMs: number,
    flatAbsPath: string,
  ): Promise<void> {
    try {
      const config = await this.deps.loadConfig(deviceId)
      const band = activeBandAt({ bands: effectiveBands(config) }, new Date(startMs + durMs))
      const triggers = this.triggersFor(deviceId)
      if (
        band?.mode === 'events' &&
        !segmentRetainedForEvents(startMs, startMs + durMs, band, triggers, attach)
      ) {
        this.reportDiscardedSegment(deviceId, profile, attach, band, triggers, startMs, durMs)
        await fs.unlink(flatAbsPath).catch(() => {
          /* already gone — ok */
        })
        return
      }
      // This attach has produced footage, so a later discard from it is the
      // normal tail of a window rather than a wholly wasted pull.
      if (band?.mode === 'events') {
        this.attachRetained.set(idleKey(deviceId, profile), attach.attachedAtMs)
      }
      await this.deps.segmentStore.onFinalized({
        deviceId,
        profile,
        locationId: placement.id,
        locationRoot: placement.root,
        flatAbsPath,
        startMs,
        durMs,
      })
    } catch (err: unknown) {
      this.deps.logger.warn('recorder: onFinalized failed', {
        tags: { deviceId },
        meta: { profile, error: errMsg(err) },
      })
    }
  }

  /**
   * Name a discarded `events`-band segment. This branch deletes recorded
   * footage and used to write NOTHING: on camera 1439 the operator saw `pinned`
   * then `unpinned` with an empty timeline in between and no line anywhere said
   * why — the recorder had spawned ffmpeg, pulled 4K RTSP for 31 s and unlinked
   * every segment it produced.
   *
   * Level is chosen, not defaulted. A discard at the TAIL of a window is the
   * feature working (`info`) — the writer keeps running until the next converge
   * tick and those trailing segments were never asked for. A discard from an
   * attach that has retained NOTHING is a fault (`warn`): the whole pull was
   * wasted, which is exactly the shape of the 1439 loss and of any future
   * regression in the attach allowance.
   */
  private reportDiscardedSegment(
    deviceId: number,
    profile: CamProfile,
    attach: AttachWindow,
    band: RecordingBand,
    triggers: TriggerState,
    startMs: number,
    durMs: number,
  ): void {
    const { preMs, postMs } = resolveBandBufferMs(band)
    const keptAnything = this.attachRetained.get(idleKey(deviceId, profile)) === attach.attachedAtMs
    const meta = {
      profile,
      startMs,
      durMs,
      // The WINDOWS the gate actually compared against, not "the last trigger".
      // A discard is only diagnosable against the episodes it missed: with a
      // single scalar, a segment dropped 200 ms past one episode and a segment
      // dropped between two episodes printed the same line.
      //
      // Keyed by SOURCE (`triggerKey`) and restricted to the sources THIS band
      // listens for — it replaces the fixed `motionWindows`/`audioWindows`
      // pair, which cannot name `object:person` or `sensor:42`. With four
      // additive sources the next question after "why was this discarded" is
      // "which of them did it miss", and two fixed fields cannot answer it.
      triggerWindows: Object.fromEntries(
        bandTriggerSources(band).map((source) => [
          triggerKey(source),
          triggerWindowsFor(triggers, source).map((w) => ({
            firstMs: w.firstMs,
            lastMs: w.lastMs,
          })),
        ]),
      ),
      postMs,
      preMs,
      attachedAtMs: attach.attachedAtMs,
      missedByMs: segmentMissedByMs(startMs, band, triggers, attach),
      keptAnythingFromThisAttach: keptAnything,
    }
    if (keptAnything) {
      this.deps.logger.info(
        'recorder: discarding events segment outside every trigger window (tail of the window)',
        { tags: { deviceId }, meta },
      )
      return
    }
    this.deps.logger.warn(
      'recorder: discarding events segment — this attach has retained NOTHING, the whole pull is wasted',
      { tags: { deviceId }, meta },
    )
  }

  /**
   * Resolve the storage location a (device, profile) writes to, at an attach
   * boundary. Delegates to the injected {@link RecordingControllerDeps.placeProfile}
   * when the addon supplied one; otherwise to the pure `resolvePlacement` in
   * `roots.ts`, which matches on the location's declared `type`
   * (`recordings` / `recordingsLow`) rather than its `<type>:<instance>` id —
   * so `low` correctly routes to `recordingsLow`.
   */
  private async resolvePlacement(
    deviceId: number,
    profile: CamProfile,
  ): Promise<RecordingsLocation> {
    if (this.deps.placeProfile) return this.deps.placeProfile(deviceId, profile)
    return resolvePlacement(this.deps.locations(), profile)
  }

  /** Stop one profile's writer + watcher and release its broker lease. */
  private async teardownProfile(deviceId: number, r: ProfileRecording): Promise<void> {
    // Timed per step: every boot finds ~one stranded segment PER WRITER, and
    // whether that is "the 5 s SIGTERM grace is too short for N parallel
    // teardowns over FUSE" or "ffmpeg dies before ENDLIST so flush() has
    // nothing to consume" is only decidable from these two numbers.
    const teardownStartMs = Date.now()
    try {
      // Writer first, watcher second: a graceful ffmpeg exit writes ENDLIST
      // plus its final segment. `flush()` then consumes that final playlist
      // entry before the watcher is stopped and relocation sees a stable tree.
      this.retiring.add(r.writer)
      await r.writer.stopAndWait()
    } catch {
      /* idempotent */
    } finally {
      this.retiring.delete(r.writer)
    }
    const writerStopMs = Date.now() - teardownStartMs
    try {
      await r.watcher.flush?.()
    } catch {
      /* best-effort final tail; watcher polling already indexed prior files */
    }
    this.deps.logger.info('recorder: profile teardown drained', {
      tags: { deviceId },
      meta: {
        profile: r.profile,
        writerStopMs,
        flushMs: Date.now() - teardownStartMs - writerStopMs,
      },
    })
    try {
      await this.deps.onWriterClosed?.(deviceId, r.profile)
    } catch (err: unknown) {
      this.deps.logger.warn(
        'recorder: sealing the closed writer’s hour failed — it stays unsealed',
        {
          tags: { deviceId },
          meta: { profile: r.profile, error: errMsg(err) },
        },
      )
    }
    try {
      r.watcher.stop()
    } catch {
      /* idempotent */
    }
    try {
      // Bounded: a release hanging on a restarting broker must not stall the
      // whole shutdown past the supervisor's 5s SIGTERM grace (see
      // RELEASE_RPC_TIMEOUT_MS). Abandoning it is safe — the writer above is
      // already stopped, so the source loses its RTSP consumer and idles out.
      await withDeadline(
        this.deps.api.streamBroker.releaseStreamWithCodec.mutate(
          { pipelineKey: r.pipelineKey },
          nodePin(this.deps.ownerNodeId),
        ),
        RELEASE_RPC_TIMEOUT_MS,
        'releaseStreamWithCodec',
      )
    } catch (err: unknown) {
      this.deps.logger.warn(
        'recorder: releaseStreamWithCodec failed — lease dropped unreleased (broker idles the source once the writer is gone)',
        {
          tags: { deviceId },
          meta: {
            profile: r.profile,
            pipelineKey: r.pipelineKey,
            error: errMsg(err),
          },
        },
      )
    }
  }

  /** Stop every profile recording for a device (no-op when not recording). */
  private async detachDevice(deviceId: number): Promise<void> {
    const recordings = this.active.get(deviceId)
    if (!recordings) return
    this.active.delete(deviceId)
    this.skippedProfiles.delete(deviceId)
    for (const r of recordings) {
      this.lastSegmentAt.delete(idleKey(deviceId, r.profile))
      this.lastProducedAt.delete(idleKey(deviceId, r.profile))
      this.attachRetained.delete(idleKey(deviceId, r.profile))
    }
    // Parallel, and each release is deadline-bounded (teardownProfile never
    // throws): N profiles tear down in ~one RELEASE_RPC_TIMEOUT_MS worst case,
    // not N of them — a device set must fit inside the supervisor's SIGTERM
    // grace or the runner is SIGKILLed mid-shutdown.
    await Promise.all(recordings.map((r) => this.teardownProfile(deviceId, r)))
    this.deps.logger.info('recorder unpinned broker source(s) — recording stopped', {
      tags: { deviceId },
      meta: { pipelineKeys: recordings.map((r) => r.pipelineKey) },
    })
  }

  /** Acquire a reversible maintenance pause without mutating camera settings. */
  async pause(): Promise<void> {
    if (this.stopped || this.paused) return
    this.paused = true
    // No device may wake itself while the lease is held. `resume()` re-evaluates
    // every configured device, which re-arms each one from its current config.
    this.wakeups.cancelAll()
    // Admission is closed before this point. Wait through every attach that
    // crossed the pre-pause gate; performAttach sees `paused` before publishing
    // active writers and tears any partial profile set down itself.
    while (this.attachingTasks.size > 0) {
      await Promise.allSettled([...this.attachingTasks.values()])
    }
    // Keep the watcher alive through each writer's graceful exit so a final
    // segment cannot be omitted from the migration work list.
    await Promise.all(Array.from(this.active.keys()).map((deviceId) => this.detachDevice(deviceId)))
  }

  /** Release the maintenance pause and converge persisted recording intent. */
  async resume(): Promise<void> {
    if (this.stopped || !this.paused) return
    this.paused = false
    let ids: readonly number[] = []
    try {
      ids = await this.deps.enabledDeviceIds()
    } catch (err: unknown) {
      this.deps.logger.warn('recorder: resume could not enumerate configured devices', {
        meta: { error: errMsg(err) },
      })
    }
    for (const deviceId of ids) await this.evaluateDevice(deviceId)
  }

  /** Tear EVERYTHING down: timers, restore subscription, every writer/watcher/lease. */
  async stop(): Promise<void> {
    this.stopped = true
    this.wakeups.cancelAll()
    this.livenessPass?.stop()
    this.livenessPass = null
    this.placementPass?.stop()
    this.placementPass = null
    this.reconcilePass?.stop()
    this.reconcilePass = null
    this.restore?.stop()
    this.restore = null
    // Parallel across devices for the same reason detachDevice is parallel
    // across profiles: total graceful-stop time must stay under the runner
    // supervisor's 5s SIGTERM grace, whatever the fleet size.
    await Promise.all(Array.from(this.active.keys()).map((deviceId) => this.detachDevice(deviceId)))
  }
}

/** Build a `stream-broker` readiness scope for one node. */
export function brokerScope(nodeId: string): ReadinessScope {
  return { type: 'node', nodeId }
}

/** Default broker readiness gate timeout (ms) — matches the old recorder. */
export const BROKER_READY_TIMEOUT_MS = 10_000

/** Wrap a cached capability handle into the `brokerCall` gate the controller needs. */
export function makeBrokerCall(handle: ICapabilityHandle): RecordingControllerDeps['brokerCall'] {
  return <R>(fn: () => Promise<R>): Promise<R> => handle.call(fn, BROKER_READY_TIMEOUT_MS)
}
