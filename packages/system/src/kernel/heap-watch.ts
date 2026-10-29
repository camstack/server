/**
 * heap-watch — hub-main's own memory, on the record, and returned to the OS.
 *
 * ## Why this exists
 *
 * hub-main used to be launched with `--max-old-space-size=1536` (docker-entrypoint;
 * the cap was removed on 2026-08-02, so the live ceiling is now V8's own default —
 * 4288MB in this container — and this module reads it at runtime rather than
 * assuming a number). It logged NOTHING about its own heap. When it died on
 * 2026-08-01/02 the only trace was V8's own stderr line:
 *
 *     FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
 *
 * which carries no process name, no heap number and no history — the whole
 * server restarts and the evidence is gone. Four of those in ~15h, and the one
 * at 06:57:57 landed nine seconds after a viewer opened a WebRTC session, which
 * is why the app sat in a permanent "loading": the hub was dying as it
 * connected.
 *
 * `[mem]` reports already exist for forked addon runners (SIGUSR2 in
 * `addon-runner.ts`) — hub-main, the one process that actually OOMs, was the
 * one process with no telemetry at all.
 *
 * **And for 27 days after that it still had none where anyone could read it.**
 * The watch was started correctly and passed NO SINK, so it fell back to
 * `console.log`, which is not an `ILogDestination` — 42 hours of Loki carried a
 * line for every runner and none for hub-main. Read
 * {@link createDeferredHeapWatchSink} before trusting anything below: a
 * heartbeat with no destination is indistinguishable from no heartbeat (D285).
 *
 * ## What it gives
 *
 * A heartbeat carrying the numbers that separate the two possible stories, and
 * a WARN as the heap approaches the ceiling — the line that will exist BEFORE
 * the next fatal instead of after it:
 *
 *  - `heapUsedMb` climbing steadily between restarts → a leak;
 *  - `heapUsedMb` flat with a sharp jump under load → a burst allocation, and
 *    the timestamp says what was being served.
 *
 * Since 2026-08-29 the line also says **WHERE in the V8 heap** the bytes are —
 * `oldSpace` and `largeObjectSpace`, appended after everything already on it.
 * `heapUsed` alone cannot separate "millions of small objects" from "a handful
 * of huge ones", and those lead to opposite searches; the recorder's unnamed
 * ~1.4 GB retained set is the case that proved it. See
 * {@link formatHeapSpaces} for which spaces are printed and why the rest are
 * not.
 *
 * `external`/`arrayBuffers` ride along because they are NOT bounded by
 * `--max-old-space-size` and are most of the gap between a 1.5GB cap and the
 * ~2.05GB RSS observed live: a diagnosis that only looks at the JS heap
 * misreads that process by 500MB.
 *
 * ## And then the heartbeat explained the "off-heap leak", which was not one
 *
 * 2026-08-08, measured on the live hub over 1019 consecutive samples and seven
 * separate boots: **hub-main's RSS is a HIGH-WATER MARK, not a leak.** In every
 * one of those 1019 samples RSS was >= the running maximum of
 * `heapTotal + external`, never once below it, and
 * `RSS_peak - peak(heapTotal + external)` landed between 874MB and 1639MB on
 * every boot — a roughly constant native floor on top of a number that only
 * ever goes up. RSS tracked the highest point the process ever reached and
 * stayed there: 3.3GB -> 4.5GB -> 5.2GB, and 7.8GB on the worst boot.
 *
 * Two things push that peak, and neither is a retained object:
 *
 *  - the JS heap sawtooths to 2.0-2.8GB because the ceiling is 4288MB and
 *    nothing creates pressure before then;
 *  - `arrayBuffers` accumulates DEAD Buffers — up to 3.65GB — because V8 only
 *    sweeps them on a major GC. Eleven collapses were captured, and every
 *    single one coincides with `heapUsed` dropping to its ~650MB floor. No code
 *    released a reference at 13:23:03; a mark-compact ran.
 *
 * At the peak V8 has committed the pages, and **an ordinary major GC does not
 * give them back.** Proven on the production hub: `smaps` showed 10,819 mapped
 * 256KB pages (V8's `kRegularPageSize`) holding 2704MB while V8 itself reported
 * `total_physical_size` of only 846MB — ~7,800 pages committed, resident, and
 * outside V8's own accounting. One `gc({ flavor: 'last-resort' })` took 417ms
 * and returned RSS 3355MB -> 1237MB, pages 10,819 -> 2,963.
 *
 * So the fix for the "~3GB/2h off-heap growth" is not a retainer hunt. It is to
 * ask V8 for the pages back when the process is visibly holding more than it is
 * using — which is what `shouldReclaim` decides and what the heartbeat now does.
 *
 * The cost is a stop-the-world on the hub's router process — 250-450ms when
 * first measured, 654ms on the largest pass seen since — bounded to once per
 * `HEAP_RECLAIM_MIN_INTERVAL_MS`. The alternative, measured, is a ratchet to
 * 7.8GB and the OOM that ends it.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import * as v8 from 'node:v8'
import * as vm from 'node:vm'
import { createAnonRssReader } from './anon-rss.js'
import {
  createEventPlaneMeter,
  type EventPlaneReader,
  formatEventPlane,
} from './event-plane-report.js'
import {
  createSocketPlaneMeter,
  formatSocketPlane,
  type SocketPlaneCounters,
  type SocketPlaneReader,
} from './socket-plane-report.js'
import {
  formatMeshQueue,
  type MeshPeerQueue,
  type MeshQueueReader,
} from './moleculer/mesh-queue-report.js'
import {
  createOutboundQueueGate,
  formatOutboundQueueVerdict,
  type OutboundQueueGateOptions,
  type OutboundQueueReading,
} from './outbound-queue-watch.js'
import { formatHeapSpaces, type HeapSpaceReader, readHeapSpaces } from './heap-spaces.js'
import { createGcCensus, formatGcCensus, type NodeGcObserver, nodeGcObserver } from './gc-census.js'
import {
  createProcessCpuCensus,
  formatProcessCpu,
  readSelfTaskTicks,
  type TaskTicks,
} from './process-cpu-census.js'
import {
  type ArrayBufferCensus,
  type ArrayBufferCensusGateOptions,
  createArrayBufferCensusGate,
  formatArrayBufferCensus,
} from './array-buffer-census.js'

/**
 * What hub-main calls itself in a `[mem]` line.
 *
 * ## Why not `hub/main`
 *
 * A runner's label is its nodeId, and a nodeId is built in exactly one place as
 * `` `${parentNodeId}/${runnerId}` `` (`kernel/moleculer/addon-runner.ts:222`) —
 * so every runner label contains a `/` and every hub-local one is `hub/<runner>`.
 * A label with NO slash therefore cannot be produced by that rule, which makes
 * `hub-main` unambiguous by construction rather than by convention: no future
 * addon, group or agent can ever claim it.
 *
 * It also sorts where it belongs. `-` (0x2D) precedes `/` (0x2F), so a sorted
 * `[mem]` census puts `hub-main` immediately before `hub/decoder`,
 * `hub/recorder`, `hub/stream-broker` — the composition root first, then the
 * runners it forked. `hub/main` would sort into the middle of its own children
 * and would be one addon id away from a collision.
 *
 * And it is the name the rest of this repository already uses — the docblocks,
 * {@link HUB_MAIN_RSS_BUDGET_MB}, {@link HUB_RSS_BUDGET_ENV}, every ADR. A log
 * label that disagreed with the prose would be a second vocabulary for one
 * process, which is the exact failure this telemetry exists to remove.
 */
export const HUB_MAIN_HEAP_WATCH_LABEL = 'hub-main'

/** The agent's root process (container or desktop): `[mem] agent-main`. */
export const AGENT_MAIN_HEAP_WATCH_LABEL = 'agent-main'

/** Heartbeat period. Slow enough to be free, fast enough that the sample before
 *  a fatal is recent. */
export const HEAP_WATCH_INTERVAL_MS = 60_000

/** Warn above this share of the heap ceiling. Chosen so the warning precedes
 *  the fatal by more than one interval under realistic growth. */
export const HEAP_WATCH_WARN_RATIO = 0.8

/**
 * ## The heartbeat could not see the thing it was built to see
 *
 * 2026-08-08 18:28:32Z, hub-main (pid 8) died on `Reached heap limit`. The last
 * `[mem]` line was 18:27:30.433 reading `heapUsed=1086MB` — 25%, unremarkable —
 * and V8's own trace 62 seconds later read 4083MB with a Mark-Compact that
 * reclaimed 4MB of 4090MB. Between those two facts there is not one sample.
 *
 * At `HEAP_WATCH_INTERVAL_MS` the whole event fits inside a single gap, so
 * `HEAP_WATCH_WARN_RATIO` never had a reading to fire on. The docblock above
 * promises "the line that will exist BEFORE the next fatal instead of after
 * it"; on the only occasion that mattered, it did not exist.
 *
 * Measured the same day over 397 consecutive live samples: p50 1266MB, p95
 * 1995MB, **max 2847MB** — 0.66 of the 4288MB ceiling. So the routine sawtooth
 * never approaches 0.8, and the only path to 0.8 is a burst that outruns the
 * sampler. A threshold reachable only through a blind spot is decoration.
 *
 * The fix is not a faster heartbeat — 30 lines a minute forever, to describe a
 * process that is fine, is how a log stops being read. It is to sample fast
 * only while the heap is somewhere the routine sawtooth does not go.
 */

/** Sampling period once escalated. Bounded below by log volume, above by the
 *  62s window the 2026-08-08 fatal hid in: ~30 readings across that window is
 *  a trajectory, and a trajectory separates a burst from a climb. */
export const HEAP_WATCH_FAST_INTERVAL_MS = 2_000

/**
 * Escalate above this share of the ceiling.
 *
 * 0.70 is 3002MB: clear of the measured routine max (2847MB) so steady state
 * never escalates, and below {@link HEAP_WATCH_WARN_RATIO} so the fast cadence
 * is already running by the time the warn is reachable.
 */
export const HEAP_WATCH_ESCALATE_RATIO = 0.7

/**
 * Release escalation below this share.
 *
 * Hysteresis, not a second threshold: hub-main's heap sawtooths continuously,
 * so a single ratio would flap the mode on every GC. 0.60 is 2573MB — a real
 * retreat rather than the trough of one collection.
 */
export const HEAP_WATCH_DEESCALATE_RATIO = 0.6

/** Sampling cadence. `escalated` costs log lines and buys resolution. */
export type HeapWatchMode = 'steady' | 'escalated'

/**
 * The cadence state machine, pure so the thresholds are testable without
 * allocating three gigabytes to reach them.
 */
export function nextMode(
  current: HeapWatchMode,
  usedRatio: number,
  escalateRatio: number = HEAP_WATCH_ESCALATE_RATIO,
  deescalateRatio: number = HEAP_WATCH_DEESCALATE_RATIO,
): HeapWatchMode {
  if (current === 'escalated') return usedRatio < deescalateRatio ? 'steady' : 'escalated'
  return usedRatio >= escalateRatio ? 'escalated' : 'steady'
}

/**
 * Reclaim once the process holds this many MB beyond what it is USING.
 *
 * Live calibration, both readings from the same hub minutes apart: 2491MB
 * stranded before the reclaim, 438MB after. 438MB is this process's irreducible
 * native floor (sqlite pages, libvips, sharp, thread stacks, node's own text) —
 * collecting against it would buy nothing and cost a stall every minute.
 *
 * ## Why this came down from 1536 (2026-08-17)
 *
 * The trigger was originally set to fire only on an unmistakable strand. It
 * does, and the pass on the record works exactly as designed:
 *
 *     [mem] reclaim hub-main stranded=2365MB rss=4016MB→2368MB freed=1648MB took=654ms
 *
 * But the number it was protecting against changed. The host now runs with a
 * 24GiB cgroup ceiling and **no swap**, and is OOM-killing a neighbouring VM.
 * RSS this process is holding and not using is no longer merely untidy — it is
 * the headroom something else needed, and the OOM is triggered by the PEAK, not
 * by the average. A trigger of 1536 means the peak is allowed to stand 1.5GiB
 * above the floor before anything happens.
 *
 * 1024 is 2.3x the measured 438MB floor, so ordinary movement around the floor
 * can never trip it, and every pass that does fire still returns roughly
 * `1024 - 438` ≈ **580MB minimum** — a real return for a 250-650ms stall,
 * not a stall spent collecting noise.
 */
export const HEAP_RECLAIM_TRIGGER_MB = 1024

/**
 * Floor on how often the stop-the-world may run.
 *
 * Ten minutes was chosen to keep the worst case under 0.1% of the router's
 * time. The worst case is not what governs the cost, though: the reclaim only
 * runs when {@link shouldReclaim} says the process is genuinely stranded, and
 * after a pass it is at the ~438MB floor. Live off-heap growth was measured at
 * roughly 3GB/2h ≈ 25MB/min, so re-stranding the ~580MB needed to qualify again
 * takes on the order of **20 minutes** — well outside any floor considered
 * here. In steady state this constant therefore costs nothing at all.
 *
 * What it does govern is a BURST, which is the only case that matters on a host
 * with no swap: the ten-minute floor let a peak that re-formed in seconds stand
 * for ten minutes. Two minutes bounds that, and even the pathological case of a
 * process that re-strands instantly costs 654ms per 120s — 0.55% of the
 * router's time, against a ~1.5GiB peak it removes each pass.
 */
export const HEAP_RECLAIM_MIN_INTERVAL_MS = 120_000

/**
 * Consecutive floor-to-floor passes after which the reclaim is announced as
 * STEADY STATE rather than a rescue.
 *
 * The floor above is documented as a bound on a BURST, on the measured premise
 * that re-stranding the trigger takes ~20 minutes. Measured on the live hub
 * 2026-08-25 it takes under two: 13 passes in 30 minutes, every one of them
 * firing the instant {@link HEAP_RECLAIM_MIN_INTERVAL_MS} elapsed, `took=`
 * 556-695ms each. Nothing in the record said so, because a pass that fires
 * every floor period and a pass that fires once an hour print the same line.
 *
 * Six is 12 minutes of back-to-back passes: long enough that a genuine burst
 * (which subsides) never reaches it, short enough that a process which has
 * quietly made the stop-the-world part of its steady state is named within the
 * quarter-hour.
 *
 * ## Until 2026-08-29 this counter changed nothing, and that was the bug
 *
 * It used to WARN and leave the cadence alone — "the pass is load-bearing and
 * keeps running". Then hub-main's first 25 minutes of telemetry arrived and
 * showed what that costs. See {@link HEAP_RECLAIM_STEADY_STATE_INTERVAL_MS}:
 * the system already knew the difference between a rescue and a steady state
 * and simply refused to act on it.
 */
export const RECLAIM_STEADY_STATE_PASSES = 6

/**
 * Floor on the pass once it has PROVEN it is steady state, not a rescue.
 *
 * ## Why `stranded` cannot discriminate on hub-main
 *
 * {@link strandedMb} is `rss − heapUsed − external`: everything the process
 * holds that those two numbers do not name. That lumps together two things with
 * opposite fixes —
 *
 *  - V8 pages committed at a sawtooth peak, which `gc(last-resort)` RETURNS;
 *  - glibc arena memory already freed and never handed back, which **no V8
 *    flavor can reach** (nothing in this repository calls `malloc_trim`).
 *
 * {@link HEAP_RECLAIM_TRIGGER_MB} was calibrated against a hub-main whose strand
 * was mostly the first kind, and a pass then took it back under the trigger. Once
 * the second kind grows past 1024 MB the quantity can never fall back under it,
 * and the gate degenerates. Measured on the live hub 2026-08-29, first 25
 * minutes of hub-main telemetry ever collected:
 *
 *  - `stranded` sat at **1031–2313 MB for the entire boot**, i.e.
 *    {@link shouldReclaim} never once said no. **What is written as a threshold
 *    is, on this process, an unconditional 120-second timer.**
 *  - Nine minutes out of nine that contained a reclaim show `loopMax` ≈ the
 *    reclaim's own duration (555–869 ms). Every minute without one is
 *    107–435 ms. **The largest recurring event-loop stall on the process that
 *    mediates every cross-runner call is the memory patch it applies to itself.**
 *  - Each pass freed less than the last (1193 → 462 MB) while the post-pass RSS
 *    floor ratcheted **1940 → 3510 MB in fourteen minutes**, with `heapUsed`
 *    never moving. It is compacting a heap that is not the problem.
 *
 * ## The fix is not a bigger trigger
 *
 * Raising {@link HEAP_RECLAIM_TRIGGER_MB} would move the number at which the same
 * degeneration happens, and it would silence `hub/recorder` — whose single pass
 * in six hours is the only cheap proof anyone has that the recorder's 1.4 GB is
 * RETAINED (a forced compaction freed 507 MB and V8 still held 1.44 GB live).
 * The discriminator is not the level of the strand; it is **whether the strand
 * ever falls back under the trigger between passes**, which is precisely what
 * {@link RECLAIM_STEADY_STATE_PASSES} already counts and used only to talk about.
 *
 * So the counter becomes load-bearing: once the pass has fired at the floor
 * {@link RECLAIM_STEADY_STATE_PASSES} times running, the trigger has demonstrably
 * stopped discriminating on this process, and the cadence falls back to a period
 * chosen for its COST rather than to a threshold pretending to be a gate.
 *
 * ## Why 600_000, and why that is not a regression
 *
 * It is the value {@link HEAP_RECLAIM_MIN_INTERVAL_MS} held before 2026-08-17,
 * and the reason it came down is recorded there: *"the ten-minute floor let a
 * peak that re-formed in seconds stand for ten minutes"*. That argument is about
 * a BURST — and a burst subsides, which resets the run and restores the 120 s
 * floor. It never applied to a process in proven steady state. So the burst
 * bound is untouched and the steady state gets the period the burst argument was
 * never about.
 *
 * ## What each process does after this change
 *
 *  - **hub-main**: first six passes at 120 s, unchanged. From the seventh
 *    consecutive floor-to-floor pass, every 600 s. Stop-the-world cost on the
 *    router falls from ~0.58% of wall clock to ~0.12%. The ArrayBuffer probe
 *    survives at six passes an hour — the finding it produced needed ten passes
 *    total, not ten in twenty-five minutes.
 *  - **`hub/recorder`**: zero change, by construction. `passesAtFloor` only
 *    increments when a pass fires within `minIntervalMs * 2` of the previous
 *    one; the recorder's strand takes six hours to re-form, so the counter is
 *    reset to 1 on every pass and can never reach six. The 507 MB probe is
 *    intact.
 *  - **Anything that recovers**: the run resets the moment the strand falls back
 *    under the trigger, and the 120 s floor returns with it.
 */
export const HEAP_RECLAIM_STEADY_STATE_INTERVAL_MS = 600_000

/**
 * The floor in force for the NEXT pass, given how many have fired at the floor.
 *
 * Pure, so the cadence change is testable without stranding a gigabyte to reach
 * it — and so the one place that decides it can be read on its own.
 */
export function reclaimIntervalMs(
  passesAtFloor: number,
  minIntervalMs: number = HEAP_RECLAIM_MIN_INTERVAL_MS,
  steadyStateIntervalMs: number = HEAP_RECLAIM_STEADY_STATE_INTERVAL_MS,
  steadyStatePasses: number = RECLAIM_STEADY_STATE_PASSES,
): number {
  // Never SHORTEN a caller's floor: a test or an operator passing a long
  // `minIntervalMs` must not have it silently replaced by the default.
  return passesAtFloor >= steadyStatePasses
    ? Math.max(minIntervalMs, steadyStateIntervalMs)
    : minIntervalMs
}

/**
 * Event-loop delay over the window since the previous read, in milliseconds.
 *
 * Why the heartbeat carries this at all: hub-main's event loop is the cluster's
 * only queue (D181 — every settings read from every runner and every agent,
 * every UDS handshake and every cross-runner cap call is served on it, and a
 * live CPU profile of a boot put `(idle)` at 0.1%). The reclaim pass is a
 * stop-the-world ON that loop, and `took=` prices the PASS without ever pricing
 * what it delays. 104ms against a p99 of 4ms is a visible stall; the same 104ms
 * against a p99 of 900ms is noise inside a queue that was already saturated.
 * Those are opposite conclusions, and until now the log could not tell them
 * apart.
 */
export interface LoopDelaySample {
  readonly p50Ms: number
  readonly p99Ms: number
  readonly maxMs: number
}

/** What a loop with nothing recorded yet reports. */
export const ZERO_LOOP_DELAY: LoopDelaySample = { p50Ms: 0, p99Ms: 0, maxMs: 0 }

export interface LoopDelayMeter {
  /** Percentiles over the window since the previous read. Reading RESETS it. */
  readonly read: () => LoopDelaySample
  readonly stop: () => void
}

/**
 * A `perf_hooks` interval histogram, read once per LOGGED line.
 *
 * The histogram samples in libuv at `resolutionMs` and costs nothing to keep
 * enabled; the expensive part would be reading it on every 2s probe, which
 * would also destroy the window the line claims to describe (probe and log
 * cadences are deliberately different — see {@link startHeapWatch}).
 *
 * An EMPTY histogram is the trap: Node answers `min = 9223372036854776000` and
 * `percentile()` throws on some versions, so a first heartbeat that read it
 * naively would print `loopMax=9223372036854ms` and be read as a catastrophe on
 * every boot. `count === 0` short-circuits to {@link ZERO_LOOP_DELAY}.
 *
 * ## `loopP50=20ms` was the SAMPLER, not the loop (fixed 2026-08-29)
 *
 * `monitorEventLoopDelay` records the whole INTERVAL between its own timer
 * firings, not the excess over the interval it asked for. So on a loop with
 * nothing wrong the histogram reads `resolution`, and every `[mem]` line this
 * process has ever emitted said `loopP50=20ms` — which was read, repeatedly in
 * one session, as "hub-main is chronically 20 ms behind". It is not; 20 was the
 * default `resolutionMs` of this very function.
 *
 * The delay is `interval − resolution`, and that is not a fudge factor — it is
 * the only reading the four resolutions agree on. Measured here, one 120 ms
 * block observed by four histograms at once:
 *
 * | resolution | raw p50 | raw max | max − resolution |
 * | --- | --- | --- | --- |
 * | 20 ms | 20.40 ms | 137.63 ms | 117.6 ms |
 * | 10 ms | 10.22 ms | 123.60 ms | 113.6 ms |
 * | 5 ms | 5.11 ms | 123.60 ms | 118.6 ms |
 * | 1 ms | 1.27 ms | 121.04 ms | 120.0 ms |
 *
 * Raw, the four disagree by 16 ms about the same event and none of them reports
 * the block. Corrected, they agree within 7 ms and all four name it. The
 * subtraction costs nothing and needs no faster sampler — a 1 ms resolution
 * would be 1 000 extra timer wakeups per second on the process that already
 * serves ~44 000 socket operations per second, to buy 2 ms of accuracy on a
 * quantity nobody reads below 100 ms.
 *
 * **Readings from before this change are 20 ms high.** `loopP99=21–28ms` in the
 * 2026-08-29 census is really 1–8 ms; `loopMax=2804ms` is really 2784 ms. Do not
 * compare a pre-fix series with a post-fix one without shifting it.
 *
 * Returns undefined if the platform declines, so the caller keeps a heartbeat
 * either way.
 */
export function createLoopDelayMeter(resolutionMs: number = 20): LoopDelayMeter | undefined {
  try {
    const histogram = monitorEventLoopDelay({ resolution: resolutionMs })
    histogram.enable()
    // The sampler's own period is in every reading by construction. Clamped at
    // zero: an idle loop's `min` lands a hair UNDER the resolution, and a
    // negative delay would be read as a broken meter rather than as a quiet one.
    const delay = (nanoseconds: number): number =>
      Math.max(0, Math.round(nanoseconds / 1e6) - resolutionMs)
    return {
      read: (): LoopDelaySample => {
        try {
          if (histogram.count === 0) return ZERO_LOOP_DELAY
          const sample: LoopDelaySample = {
            p50Ms: delay(histogram.percentile(50)),
            p99Ms: delay(histogram.percentile(99)),
            maxMs: delay(histogram.max),
          }
          histogram.reset()
          return sample
        } catch {
          return ZERO_LOOP_DELAY
        }
      },
      stop: (): void => {
        histogram.disable()
      },
    }
  } catch {
    return undefined
  }
}

/** Whether anyone CHOSE this process's old-space ceiling, or V8 derived one. */
export type HeapCeilingOrigin = 'explicit' | 'v8-default'

/**
 * Read the origin of the old-space ceiling off node's own options.
 *
 * hub-main is the only process in the cluster whose ceiling nobody chose. Every
 * forked runner is given V8 heap flags by `process-service.ts`; hub-main gets
 * `--max-old-space-size` from `docker-entrypoint.sh` ONLY when the operator sets
 * `CAMSTACK_HUB_HEAP_MB`, and on the live container it is unset — verified
 * 2026-08-25 by reading pid 7's argv, a bare `node .../starter.js`. So the
 * ceiling in force is whatever V8 derives from the host (4288MB there), and the
 * only record of that was a comment inside an image nobody rebuilds to read.
 *
 * A fact about the running process belongs in the running process's log, and
 * `execArgv` answers it for free at boot.
 */
export function heapCeilingOrigin(
  execArgv: readonly string[] = process.execArgv,
): HeapCeilingOrigin {
  // Node accepts the dashed and underscored spellings, and both `=N` and a
  // separate argument. Matching only `--max-old-space-size=` would report
  // "no ceiling" on a process that has one.
  const explicit = execArgv.some((arg) => /^--max[-_]old[-_]space[-_]size(=|$)/.test(arg))
  return explicit ? 'explicit' : 'v8-default'
}

/** Env var the launch-args module hands the node: who chose its heap ceiling. */
export const HEAP_CEILING_SOURCE_ENV = 'CAMSTACK_HEAP_CEILING_SOURCE'

const LAUNCHER_SOURCES: ReadonlySet<string> = new Set([
  'override',
  'legacy-env',
  'computed',
  'v8-default',
])

/**
 * Who chose this process's ceiling, as told by the launch-args module (ADR 0970).
 * Only the two launcher-controlled processes report it: a forked runner inherits
 * the variable but its ceiling is sized by process-service, so for it the claim
 * would be false.
 */
function launcherCeilingSource(label: string): string | undefined {
  if (label !== HUB_MAIN_HEAP_WATCH_LABEL && label !== AGENT_MAIN_HEAP_WATCH_LABEL) {
    return undefined
  }
  const value = process.env[HEAP_CEILING_SOURCE_ENV]
  return value !== undefined && LAUNCHER_SOURCES.has(value) ? value : undefined
}

export interface HeapSample {
  readonly rssMb: number
  readonly heapUsedMb: number
  readonly heapTotalMb: number
  readonly heapLimitMb: number
  readonly externalMb: number
  readonly arrayBuffersMb: number
  /**
   * `RssAnon` (Linux): private anonymous resident memory, the part a
   * `last-resort` GC or `malloc_trim` can actually hand back. `undefined` when
   * it was not measured (macOS, Windows, a failed `/proc` read) — never 0
   * (D393); {@link strandedMb} then falls back to `rssMb`.
   */
  readonly anonRssMb?: number
  /** heapUsed / heapLimit, 0-1. */
  readonly usedRatio: number
  /** True once the heap is close enough to the ceiling to be worth shouting. */
  readonly nearLimit: boolean
}

const MB = (bytes: number): number => Math.round(bytes / 1048576)

/**
 * Build a sample from raw readings. Pure so the thresholds are testable without
 * allocating a gigabyte to reach them.
 */
export function buildHeapSample(
  mem: NodeJS.MemoryUsage,
  heapLimitBytes: number,
  warnRatio: number = HEAP_WATCH_WARN_RATIO,
  anonRssBytes?: number,
): HeapSample {
  const usedRatio = heapLimitBytes > 0 ? mem.heapUsed / heapLimitBytes : 0
  return {
    rssMb: MB(mem.rss),
    heapUsedMb: MB(mem.heapUsed),
    heapTotalMb: MB(mem.heapTotal),
    heapLimitMb: MB(heapLimitBytes),
    externalMb: MB(mem.external),
    arrayBuffersMb: MB(mem.arrayBuffers),
    ...(anonRssBytes === undefined ? {} : { anonRssMb: MB(anonRssBytes) }),
    usedRatio: Math.round(usedRatio * 100) / 100,
    nearLimit: usedRatio >= warnRatio,
  }
}

/** Minimal sink so this module stays usable before any logger exists — the
 *  starter runs before the kernel's logging is wired. */
export interface HeapWatchSink {
  readonly info: (line: string) => void
  readonly warn: (line: string) => void
}

const consoleSink: HeapWatchSink = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
}

/**
 * A sink that starts on stdout and is repointed at the real logger the moment
 * one exists.
 *
 * ## The gap this closes
 *
 * hub-main has had this heartbeat since 2026-08-02, started from
 * `server/backend/src/main.ts` as the very first statement of `bootstrap()`.
 * It was never wired to the LOG MANAGER, only to {@link consoleSink} — i.e. to
 * `console.log`, which is not a destination. Every forked runner passes a sink
 * backed by its `IScopedLogger` (`kernel/moleculer/addon-runner.ts:729`), so a
 * runner's `[mem]` line fans out to the buffer, the console destination, the
 * rotated file AND the Loki destination; hub-main's went to a file descriptor
 * and nowhere else. Result: 42 hours of Loki with a `[mem]` line for every
 * runner in the cluster and not one for the largest process in it, whose growth
 * to ~4.8 GB was consequently never trended, only inferred.
 *
 * ## Why late binding rather than moving the call
 *
 * The heartbeat cannot simply be started later. Its whole point is that a
 * process which dies early still leaves samples — the fatal that motivated it
 * landed nine seconds after a viewer connected — and `LoggingService` does not
 * exist until the Fastify app has been booted, hundreds of lines into
 * `bootstrap()`. So the sink is handed over instead of the start being delayed:
 * boot lines keep going to stdout exactly as they do today, and every line from
 * the handover on enters the log manager.
 *
 * Nothing before the handover is lost from Loki by accident, only by design:
 * `LogManager.addDestination` replays its ring buffer into a destination that
 * registers late, so the heartbeat lines emitted between the handover and the
 * Loki addon's own registration still ship.
 */
export interface DeferredHeapWatchSink {
  /** Hand this to {@link startHeapWatch}. */
  readonly sink: HeapWatchSink
  /** Point every SUBSEQUENT line at `target`. Last call wins. */
  readonly attach: (target: HeapWatchSink) => void
}

/**
 * Build a {@link DeferredHeapWatchSink}.
 *
 * The handover announces itself, once, through the NEW target: that line is the
 * only in-band evidence that hub-main's telemetry actually reached the log
 * manager on a given boot. Its absence from Loki means the wiring is broken —
 * which is precisely the state this module was in, undetected, for 42 hours.
 */
export function createDeferredHeapWatchSink(
  label: string = HUB_MAIN_HEAP_WATCH_LABEL,
  fallback: HeapWatchSink = consoleSink,
): DeferredHeapWatchSink {
  let target: HeapWatchSink = fallback
  const sink: HeapWatchSink = {
    info: (line) => {
      target.info(line)
    },
    warn: (line) => {
      target.warn(line)
    },
  }
  const attach = (next: HeapWatchSink): void => {
    target = next
    next.info(
      `[mem] ${label} heartbeat attached to the log manager — earlier lines went to stdout ` +
        `only and are not in the log buffer, the rotated file or Loki.`,
    )
  }
  return { sink, attach }
}

/**
 * RSS the process is holding but not using.
 *
 * The subtrahend is heapUSED, not heapTotal, deliberately: the pages V8
 * committed at a sawtooth peak and no longer needs are counted inside heapTotal,
 * and they are precisely what this number exists to see.
 *
 * ## What this number can and CANNOT be asked
 *
 * It answers exactly one question: *are there pages a `last-resort` GC could
 * hand back?* For that it is correct, and {@link shouldReclaim} is the only
 * gate that should ever be built on it.
 *
 * It can never answer *is this process too big?*, because `external` is
 * subtracted by construction. A process whose growth is entirely `external` —
 * Buffers, `arrayBuffers`, what a native addon mallocs — moves `rss` and the
 * subtrahend by the same amount, so this number is **algebraically constant
 * while the process triples**. That is not a threshold set too high; the
 * quantity cannot represent the event.
 *
 * It cost 11.4GB and a ~154 second stall of the whole container to establish
 * that. See {@link RssBudgetOptions} for the number that does answer it.
 */
export function strandedMb(s: HeapSample): number {
  // `VmRSS` also counts file-backed pages (mmap'd SQLite, shared libraries):
  // reclaimable by the kernel, never by a GC. sqlite-settings ran 45 useless
  // passes in a day with VmRSS 1079 = RssAnon 585 + RssFile 493. Where the
  // anonymous part is known, it is the honest numerator.
  return (s.anonRssMb ?? s.rssMb) - s.heapUsedMb - s.externalMb
}

/** Whether it is worth paying a stop-the-world to get those pages back. */
export function shouldReclaim(s: HeapSample, triggerMb: number = HEAP_RECLAIM_TRIGGER_MB): boolean {
  return strandedMb(s) > triggerMb
}

/**
 * Which of the three MEASURED growth shapes dominates a process's footprint.
 *
 * These are not categories invented for a log line. They are what `smaps` found
 * on the three live processes on 2026-08-27, and each one has a different lever:
 *
 * | process | evidence | shape |
 * | --- | --- | --- |
 * | `hub/recorder` | 1509.8MB in V8's 256KB page ranges, 53.9MB `brk`, `external` 8MB | `v8-heap` |
 * | `hub/stream-broker` | 242.6MB V8 pages but **1159.1MB `brk`**, `arrayBuffers` 829MB | `external` |
 * | `hub-main` | 1295.1MB V8 pages, 566.7MB `brk`, **2.7GB across 13 anonymous mappings >=64MB** | `native-residue` |
 *
 *  - `v8-heap` — live JS retainers. `--max-old-space-size` is the bound, and the
 *    fix is the retained set (the recorder's ~7.1M `SegmentRow`s).
 *  - `external` — Buffers and native `external`. **No V8 flag bounds any of
 *    it**; `hub/pipeline-analytics` reached 5735MB with `--max-old-space-size=1024`
 *    in force the whole time.
 *  - `native-residue` — memory already freed that the allocator has not returned
 *    to the kernel. This is what the reclaim pass exists for, and the only shape
 *    where `MALLOC_ARENA_MAX` / `VIPS_CONCURRENCY` are the lever — both of which
 *    are ALREADY applied here, so a `native-residue` line means that lever is
 *    spent and the answer is upstream.
 *
 * Reporting only "it is big" leaves the operator to guess between three
 * different fixes, two of which cannot work.
 */
export type RssGrowthShape = 'v8-heap' | 'external' | 'native-residue'

/** Where a process's footprint stands against the budget its role declared. */
export type RssBudgetState = 'within' | 'over'

/** The footprint, split into the three parts that imply different fixes. */
export interface RssBreakdown {
  readonly rssMb: number
  readonly budgetMb: number
  /** How far past the budget. 0 when within — "how far over" has no meaning below it. */
  readonly overMb: number
  readonly heapUsedMb: number
  readonly externalMb: number
  /** `rss − heapUsed − external`: native the other two numbers do not name. */
  readonly nativeResidueMb: number
  readonly arrayBuffersMb: number
  readonly shape: RssGrowthShape
}

/** Share of RSS, as a whole percent. Never divides by zero. */
function share(partMb: number, rssMb: number): number {
  return rssMb > 0 ? Math.round((partMb / rssMb) * 100) : 0
}

/**
 * Split a sample into the three shapes and name the dominant one.
 *
 * `nativeResidue` is clamped at 0: `process.memoryUsage()` reads its fields at
 * slightly different instants, so `heapUsed + external` can transiently exceed
 * `rss` and a negative residue would misclassify the sample.
 */
export function describeRss(s: HeapSample, budgetMb: number): RssBreakdown {
  const nativeResidueMb = Math.max(0, strandedMb(s))
  const shape: RssGrowthShape =
    s.heapUsedMb >= s.externalMb && s.heapUsedMb >= nativeResidueMb
      ? 'v8-heap'
      : s.externalMb >= nativeResidueMb
        ? 'external'
        : 'native-residue'
  return {
    rssMb: s.rssMb,
    budgetMb,
    overMb: Math.max(0, s.rssMb - budgetMb),
    heapUsedMb: s.heapUsedMb,
    externalMb: s.externalMb,
    nativeResidueMb,
    arrayBuffersMb: s.arrayBuffersMb,
    shape,
  }
}

/** What the operator can actually DO about each shape. */
const SHAPE_ADVICE: Readonly<Record<RssGrowthShape, string>> = {
  'v8-heap': 'live JS retainers — bounded by --max-old-space-size; the fix is the retained set',
  external:
    'Buffers / native external — NO V8 flag bounds this, and the old-space ceiling never will',
  'native-residue':
    'freed native memory the allocator has not returned — MALLOC_ARENA_MAX/VIPS_CONCURRENCY are already applied, so this lever is spent',
}

/**
 * Release the alarm below this share of the budget.
 *
 * Hysteresis, not a second budget: every process here sawtooths (the reclaim
 * pass alone moves hub-main by ~1.6GB), so a single threshold would print a
 * pair of lines on every cycle. 0.9 of the budget is a real retreat.
 */
export const RSS_BUDGET_RELEASE_RATIO = 0.9

/**
 * Floor on how often a crossing may be ANNOUNCED again.
 *
 * Hysteresis alone bounds flapping around the edge; it does not bound a process
 * that genuinely swings across the budget every reclaim cycle
 * ({@link HEAP_RECLAIM_MIN_INTERVAL_MS} is 2 minutes, so that is up to 30 pairs
 * of lines an hour, forever). A process that oscillates across its budget is ONE
 * story, and the operator needs it told once per quarter-hour, not thirty times.
 *
 * This is the discipline the rest of this module already follows and the one the
 * log needed: on 2026-08-27 two real alarms were buried under 83,198 Hikvision
 * heartbeat lines in 12h. A watchdog that shouts is a watchdog that gets muted.
 */
export const RSS_BUDGET_REANNOUNCE_MIN_MS = 900_000

/**
 * The alarm state machine, pure so the thresholds are testable without
 * allocating five gigabytes to reach them.
 */
export function nextRssBudgetState(
  current: RssBudgetState,
  rssMb: number,
  budgetMb: number,
  releaseRatio: number = RSS_BUDGET_RELEASE_RATIO,
): RssBudgetState {
  if (current === 'over') return rssMb < budgetMb * releaseRatio ? 'within' : 'over'
  return rssMb > budgetMb ? 'over' : 'within'
}

/** A full collection that also asks V8 to hand the pages back to the OS. */
export type HeapReclaimer = () => void

interface GcOptions {
  readonly execution: 'sync'
  readonly flavor: 'last-resort'
}
type GcFunction = (options: GcOptions) => void

function isGcFunction(value: unknown): value is GcFunction {
  return typeof value === 'function'
}

/**
 * Build the reclaimer without requiring `--expose-gc` on argv.
 *
 * The flag is turned on, the function captured, and the flag turned straight
 * back off — a global `gc` left reachable by application code is a footgun, and
 * requiring an argv change would mean this cannot ship without a new image.
 * Verified against the live hub before being written: 266ms, RSS 1453 -> 1237.
 *
 * Returns undefined if V8 declines, so the caller keeps a heartbeat either way.
 */
export function createV8Reclaimer(): HeapReclaimer | undefined {
  try {
    v8.setFlagsFromString('--expose-gc')
    const gc: unknown = vm.runInNewContext('gc')
    v8.setFlagsFromString('--no-expose-gc')
    if (!isGcFunction(gc)) return undefined
    // 'last-resort' is the flavor that returns pages; a plain major GC sweeps
    // the dead ArrayBuffers but leaves RSS exactly where it was (measured).
    return () => gc({ execution: 'sync', flavor: 'last-resort' })
  } catch {
    return undefined
  }
}

/** Wiring for the reclaim pass. `readMemory`/`heapLimitBytes` exist so a test
 *  can reach a gigabyte-scale state without allocating one. */
export interface HeapReclaimOptions {
  readonly reclaim: HeapReclaimer
  readonly readMemory?: () => NodeJS.MemoryUsage
  /** `RssAnon` in bytes, or `undefined` when unmeasured. Default: `/proc/self/status` on Linux. */
  readonly readAnonRssBytes?: () => number | undefined
  readonly heapLimitBytes?: number
  readonly triggerMb?: number
  readonly minIntervalMs?: number
  /** Floor once the pass is proven steady state. See
   *  {@link HEAP_RECLAIM_STEADY_STATE_INTERVAL_MS}. */
  readonly steadyStateIntervalMs?: number
  readonly now?: () => number
  /** Sampling cadence once escalated. See {@link HEAP_WATCH_FAST_INTERVAL_MS}. */
  readonly fastIntervalMs?: number
  /** Ratio at which the fast cadence begins. See {@link HEAP_WATCH_ESCALATE_RATIO}. */
  readonly escalateRatio?: number
  /** Ratio at which it releases. See {@link HEAP_WATCH_DEESCALATE_RATIO}. */
  readonly deescalateRatio?: number
}

/**
 * The RSS budget for ONE process, and where the number came from.
 *
 * ## Why a DECLARED budget, and not a derived one
 *
 * Every bound this system had was derived, and each one is blind to most of a
 * process: `--max-old-space-size` bounds old space only, and `strandedMb`
 * subtracts `external` by construction. `hub/pipeline-analytics` was killed at
 * 11.4GB with a 1024MB old-space ceiling in force and a stranded number that
 * never moved. RSS is the quantity the host's OOM killer actually reads, so RSS
 * is the quantity that needs a ceiling — and RSS cannot be derived from any flag,
 * because most of it is not V8's.
 *
 * ## Why there is no single constant
 *
 * The legitimate footprint differs by an order of magnitude BY ROLE, measured
 * on the same host on the same day:
 *
 *  - `hub/recorder` legitimately holds ~1.5GB of live V8 index (~7.1M
 *    `SegmentRow`s, ~30 days x 13 cameras x 2 profiles) and declares a 3072MB
 *    old space to hold it;
 *  - `hub/stream-broker` legitimately holds ~900MB of `arrayBuffers` (47 RTP
 *    pre-roll rings) in the glibc heap, with an old space of only 224MB;
 *  - `hub/pipeline-analytics` has no legitimate multi-GB working set at all —
 *    it died at 11.4GB holding a 536MB heap.
 *
 * One constant would either wave through analytics' 11GB or scream at the
 * recorder's entirely correct 2GB. So the number lives **next to the role that
 * knows it**: an addon declares `execution.rssBudgetMb` in its own manifest,
 * exactly as it already declares `execution.maxOldSpaceMb`, and the runner takes
 * the MAXIMUM any co-located addon declares (D2/D29 — a runner is respawned as a
 * whole, so co-location must never silence the hungriest member).
 *
 * hub-main has no manifest, and its entrypoint is the LEAST deployable surface
 * in this system (the Dockerfile's own comment: a backend change is train-bound
 * by construction, and an image build does not ship it). Its budget therefore
 * lives in `@camstack/server`, which `applyServerUpdate` replaces the same day —
 * see {@link HUB_MAIN_RSS_BUDGET_MB}.
 *
 * ## And a process with no declaration is UNWATCHED, out loud
 *
 * `budgetMb: undefined` does not select a default. Defaulting would be the same
 * mistake in a new place: a number nobody measured, applied to a process nobody
 * profiled, producing either silence or noise with equal authority. The process
 * says once, at boot, that nothing is watching it. Most runners are in this
 * state today and that is the honest report — measurements exist for four
 * processes, so four processes carry a budget.
 */
export interface RssBudgetOptions {
  /** MB. `undefined` → this process is declared UNWATCHED and says so at boot. */
  readonly budgetMb: number | undefined
  /** Named in every line, so a budget that is wrong is traceable to its author. */
  readonly source: string
  /** See {@link RSS_BUDGET_RELEASE_RATIO}. */
  readonly releaseRatio?: number
  /** See {@link RSS_BUDGET_REANNOUNCE_MIN_MS}. */
  readonly reannounceMinMs?: number
}

/**
 * The line that says HOW the process grew, not merely that it did.
 *
 * `heapUsed`, `external` and the native residue each carry their share of RSS,
 * because the shares are what separate the three fixes — and on the process this
 * module failed to catch, the shares were 9% / 74% / 16%, which names the answer
 * on sight.
 */
function formatOverBudget(label: string, b: RssBreakdown, source: string): string {
  return (
    `[mem] ${label} OVER RSS BUDGET rss=${b.rssMb}MB budget=${b.budgetMb}MB over=+${b.overMb}MB ` +
    `shape=${b.shape} heapUsed=${b.heapUsedMb}MB(${share(b.heapUsedMb, b.rssMb)}%) ` +
    `external=${b.externalMb}MB(${share(b.externalMb, b.rssMb)}%) ` +
    `nativeResidue=${b.nativeResidueMb}MB(${share(b.nativeResidueMb, b.rssMb)}%) ` +
    `arrayBuffers=${b.arrayBuffersMb}MB budgetFrom="${source}" — ${SHAPE_ADVICE[b.shape]}`
  )
}

/**
 * The heartbeat line.
 *
 * ## Nothing here may be renamed or moved
 *
 * `heapUsed` says HOW MUCH; the per-space suffix says WHERE, which is the half
 * that names a retained set. The suffix is APPENDED after the loop fields for
 * one reason: every existing field then keeps its name and its position, so the
 * `hl loki-query` pipelines written against this line keep matching. A rename or
 * a reorder is the one change to a log format that silently breaks a query
 * nobody will re-run until they need it.
 */
function format(
  label: string,
  s: HeapSample,
  loop: LoopDelaySample | undefined,
  budgetMb: number | undefined,
  suffix: string,
): string {
  const line =
    `[mem] ${label} rss=${s.rssMb}MB heapUsed=${s.heapUsedMb}MB heapTotal=${s.heapTotalMb}MB ` +
    `heapLimit=${s.heapLimitMb}MB used=${Math.round(s.usedRatio * 100)}% ` +
    `external=${s.externalMb}MB arrayBuffers=${s.arrayBuffersMb}MB` +
    // The budget rides on the ROUTINE line too, so the state is readable from any
    // sample and not only from the transition that announced it.
    (budgetMb === undefined ? '' : ` rssBudget=${budgetMb}MB`)
  if (loop === undefined) return `${line}${suffix}`
  return `${line} loopP50=${loop.p50Ms}ms loopP99=${loop.p99Ms}ms loopMax=${loop.maxMs}ms${suffix}`
}

/**
 * The optional per-line probes.
 *
 * An OBJECT rather than two more positional parameters: `startHeapWatch` already
 * takes eight, and a ninth and tenth `undefined` at a call site is how a caller
 * ends up passing the loop meter into the space reader. Every field is optional,
 * so a caller that wants neither passes nothing.
 */
export interface HeapWatchProbes {
  /** Per-V8-space breakdown. Defaults to the real reader. */
  readonly readSpaces?: HeapSpaceReader
  /**
   * UDS + cross-node event fan-out. No default: a forked runner has no child
   * registry, and printing zeros for a plane that does not exist is worse than
   * printing nothing. Only hub-main and an agent's main pass one.
   */
  readonly eventPlane?: EventPlaneReader
  /**
   * Per-peer UDS socket traffic, split by frame kind. No default, for the same
   * reason as {@link eventPlane}: a forked runner has no child registry, and the
   * plane it does have (its single channel to its parent) is already reported
   * from the parent's side. Only hub-main and an agent's main pass one.
   */
  readonly socketPlane?: SocketPlaneReader
  /**
   * The write queue of every Moleculer TCP socket to a peer node. No default:
   * only a process with a broker on a real transporter has one. Those sockets
   * are UNREF'D by Moleculer, so a sum over `_getActiveHandles()` never listed
   * them — the hole in the 2026-09-10 exclusion of "every socket queue"
   * (D446). Read on every probe, judged with the UDS queues below.
   */
  readonly meshQueue?: MeshQueueReader
  /**
   * Thresholds for the outbound-queue gate. The gate itself is created
   * whenever {@link socketPlane} or {@link meshQueue} is given; this only
   * tunes it (tests, or a process with a different notion of "held").
   */
  readonly outboundQueue?: OutboundQueueGateOptions
  /**
   * The ArrayBuffer census that ARMS ITSELF. No default: it costs a forced
   * full GC when it fires, and only hub-main has an episode on record (two
   * silent linear climbs to 1.3 GB and 5 GB on 2026-09-10, each released in
   * one instant with no line, the second two hours before the OOM). A runner
   * that legitimately holds gigabytes of ArrayBuffers (`hub/stream-broker`,
   * ~900 MB of RTP pre-roll rings) would fire it forever. See
   * `array-buffer-census.ts` for the gate, the cost and what it is NOT.
   */
  readonly arrayBufferCensus?: ArrayBufferCensusProbe
  /**
   * How the GC census observes collections. Defaults to the real Node
   * observer, for EVERY process — the rate is half of what a GC costs and the
   * line has never carried it (see `gc-census.ts`). A spec passes its own so a
   * sequence of collections can be posed; nothing in production passes one.
   */
  readonly gcObserver?: NodeGcObserver
  /**
   * How this process reads its own CPU. Defaults to the real
   * `process.cpuUsage()` and the real `/proc/self/task`, for EVERY process —
   * `docker stats` reports the cgroup, and nothing on any line said what share
   * of it this process was (see `process-cpu-census.ts`). A spec passes its own
   * so a cost can be posed; nothing in production passes one.
   */
  readonly processCpu?: ProcessCpuProbe
}

/** The two readings `process-cpu-census.ts` needs, injectable for a spec. */
export interface ProcessCpuProbe {
  readonly cpuUsageUs: () => number
  readonly readTasks: () => readonly TaskTicks[] | null
}

/** How the census is wired: the census itself plus the gate's thresholds. */
export interface ArrayBufferCensusProbe extends ArrayBufferCensusGateOptions {
  readonly census: ArrayBufferCensus
}

/**
 * Every outbound queue the heartbeat can reach, as the gate wants them: the
 * UDS children (only those whose channel keeps a reading — an unmeasured
 * peer is not a zero) and the mesh writer sockets, each prefixed with its
 * plane.
 */
export function outboundQueueReadings(
  uds: SocketPlaneCounters | undefined,
  mesh: readonly MeshPeerQueue[] | undefined,
): readonly OutboundQueueReading[] {
  const readings: OutboundQueueReading[] = []
  for (const peer of uds?.peers ?? []) {
    if (peer.queuedBytes === null) continue
    readings.push({ peerId: `uds:${peer.peerId}`, bytes: peer.queuedBytes })
  }
  for (const node of mesh ?? []) {
    readings.push({ peerId: `mesh:${node.nodeId}`, bytes: node.queuedBytes })
  }
  return readings
}

/**
 * Start the heartbeat. Returns a stop function.
 *
 * `unref`ed so it can never hold the process open, and every read is wrapped:
 * a diagnostic that can crash the process it watches is worse than none.
 */
export function startHeapWatch(
  label: string = HUB_MAIN_HEAP_WATCH_LABEL,
  sink: HeapWatchSink = consoleSink,
  intervalMs: number = HEAP_WATCH_INTERVAL_MS,
  reclaimOptions?: HeapReclaimOptions,
  loopDelay: LoopDelayMeter | undefined = createLoopDelayMeter(),
  execArgv: readonly string[] = process.execArgv,
  announceCeilingOrigin: boolean = true,
  rssBudget?: RssBudgetOptions,
  probes?: HeapWatchProbes,
): () => void {
  const readSpaces = probes?.readSpaces ?? readHeapSpaces
  // Read ONCE PER LINE, same as the loop histogram: the registries count
  // cumulatively, so a delta is only meaningful against the previous LOGGED
  // reading, and reading on the 2s probe would make every window 2s long.
  const eventPlane =
    probes?.eventPlane === undefined ? undefined : createEventPlaneMeter(probes.eventPlane)
  // Same cadence, same reason: the channel counters are cumulative, so a delta
  // is only meaningful against the previous LOGGED reading.
  const socketPlane =
    probes?.socketPlane === undefined ? undefined : createSocketPlaneMeter(probes.socketPlane)
  const readMemory = reclaimOptions?.readMemory ?? ((): NodeJS.MemoryUsage => process.memoryUsage())
  const now = reclaimOptions?.now ?? ((): number => Date.now())
  // Read ONCE PER LINE, like the loop histogram and the two plane meters: the
  // read closes the window, so reading it on the 2s probe would make every
  // window 2s long and throw away the ~58s the line claims to describe.
  const gcObserver = probes?.gcObserver ?? nodeGcObserver()
  const gcCensus = createGcCensus(gcObserver.install, gcObserver.kinds, now(), gcObserver.flagBits)
  // Read ONCE PER LINE, for the same reason as the census above: the read
  // closes the window. `process.cpuUsage()` is ~1 µs and the `/proc` scan is a
  // readdir plus ~11 small reads — a minute apart on hub-main, five on a
  // runner. Neither is on the 2 s probe path (D469).
  const cpuProbe = probes?.processCpu
  const processCpu = createProcessCpuCensus({
    cpuUsageUs:
      cpuProbe?.cpuUsageUs ??
      ((): number => {
        const u = process.cpuUsage()
        return u.user + u.system
      }),
    readTasks: cpuProbe?.readTasks ?? readSelfTaskTicks,
    startedAt: now(),
  })
  const triggerMb = reclaimOptions?.triggerMb ?? HEAP_RECLAIM_TRIGGER_MB
  const minIntervalMs = reclaimOptions?.minIntervalMs ?? HEAP_RECLAIM_MIN_INTERVAL_MS
  const steadyStateIntervalMs =
    reclaimOptions?.steadyStateIntervalMs ?? HEAP_RECLAIM_STEADY_STATE_INTERVAL_MS
  const fastIntervalMs = reclaimOptions?.fastIntervalMs ?? HEAP_WATCH_FAST_INTERVAL_MS
  const escalateRatio = reclaimOptions?.escalateRatio ?? HEAP_WATCH_ESCALATE_RATIO
  const deescalateRatio = reclaimOptions?.deescalateRatio ?? HEAP_WATCH_DEESCALATE_RATIO
  let lastReclaimAt = Number.NEGATIVE_INFINITY
  /** Consecutive passes that fired the instant the floor elapsed. See
   *  {@link RECLAIM_STEADY_STATE_PASSES}. */
  let passesAtFloor = 0
  let steadyStateAnnounced = false

  const readAnonRss =
    reclaimOptions?.readAnonRssBytes ?? createAnonRssReader((line) => sink.warn(line))
  const read = (): HeapSample => {
    const limit = reclaimOptions?.heapLimitBytes ?? v8.getHeapStatistics().heap_size_limit
    return buildHeapSample(readMemory(), limit, HEAP_WATCH_WARN_RATIO, readAnonRss())
  }

  const maybeReclaim = (sample: HeapSample): void => {
    if (reclaimOptions === undefined) return
    if (!shouldReclaim(sample, triggerMb)) {
      // The strand fell back under the trigger between passes: the pass is
      // behaving as the safety net it was designed to be, so the run resets.
      passesAtFloor = 0
      steadyStateAnnounced = false
      return
    }
    // The floor in force right now. Once the pass has proven it is steady state
    // rather than a rescue, `stranded` has stopped discriminating on this
    // process and the cadence falls back to a period chosen for its COST — see
    // HEAP_RECLAIM_STEADY_STATE_INTERVAL_MS for the measurement that forced it.
    const floorMs = reclaimIntervalMs(passesAtFloor, minIntervalMs, steadyStateIntervalMs)
    const sinceLast = now() - lastReclaimAt
    if (sinceLast < floorMs) return
    // Fired the moment it was allowed to, on a process that never fell back
    // under the trigger in between. Two floor periods of slack keeps a probe
    // landing a tick late from resetting a genuine run.
    passesAtFloor = sinceLast <= floorMs * 2 ? passesAtFloor + 1 : 1
    lastReclaimAt = now()
    const startedAt = now()
    try {
      reclaimOptions.reclaim()
    } catch (error) {
      // A reclaim that silently does nothing reads as "it was never needed".
      sink.warn(`[mem] reclaim failed — ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const after = read()
    sink.info(
      `[mem] reclaim ${label} stranded=${strandedMb(sample)}MB ` +
        `rss=${sample.rssMb}MB→${after.rssMb}MB freed=${sample.rssMb - after.rssMb}MB ` +
        `arrayBuffers=${sample.arrayBuffersMb}MB→${after.arrayBuffersMb}MB took=${now() - startedAt}ms` +
        // APPENDED, never inserted: every field before this keeps its name AND
        // its position, because the Loki queries written against this line
        // match on the prefix.
        //
        // `after` is read IMMEDIATELY after a synchronous compacting
        // `gc({ flavor: 'last-resort' })`, so `after.heapUsedMb` is the LIVE
        // SET at t+0 — what survives a full compaction, which is the one number
        // that separates "a large retained set" from "a sawtooth against the
        // allocation limit", and the only way to get it without a heap
        // snapshot. It was already computed here and thrown away: on 2026-08-29
        // the recorder's live set had to be argued from a heartbeat 40 SECONDS
        // after the pass, and every reader since has had to argue about what
        // happened in those 40 seconds. Cost: one string concatenation on a
        // path that has just spent ~1000ms in stop-the-world.
        ` heapUsed=${sample.heapUsedMb}MB→${after.heapUsedMb}MB` +
        (sample.anonRssMb === undefined
          ? ''
          : ` anon=${sample.anonRssMb}MB→${after.anonRssMb === undefined ? 'n/a' : `${after.anonRssMb}MB`}`),
    )
    if (passesAtFloor >= RECLAIM_STEADY_STATE_PASSES && !steadyStateAnnounced) {
      steadyStateAnnounced = true
      const nextFloorMs = reclaimIntervalMs(passesAtFloor, minIntervalMs, steadyStateIntervalMs)
      sink.warn(
        `[mem] reclaim ${label} has run at the floor for ${passesAtFloor} consecutive passes ` +
          `(every ${minIntervalMs}ms) — the stop-the-world is now STEADY STATE, not a rescue: ` +
          `stranded never fell back under ${triggerMb}MB between passes, so the trigger is not ` +
          `discriminating on this process and what is left deciding is the timer. ` +
          `BACKING OFF to every ${nextFloorMs}ms — the pass keeps running (it is still the only ` +
          `measurement of this process's live ArrayBuffer set) at a cost the router can pay. ` +
          `The allocation source is what needs the fix; this pass only bounds its peak.`,
      )
    }
  }

  let mode: HeapWatchMode = 'steady'
  let lastLoggedAt = Number.NEGATIVE_INFINITY
  // The FIRST line after boot carries EVERY V8 space (min 0 MB): the boot floor
  // (415 MB on pipeline-analytics) needs attribution and the routine filter would
  // hide whichever space holds it (D867). Later lines revert to the filtered set.
  let firstLinePending = true

  // ── RSS against a declared budget ────────────────────────────────────────
  // A budget of 0 or less is not a budget; treat it as "undeclared" so an
  // operator can disable the alarm with `...RSS_BUDGET_MB=0` and get the
  // unwatched announcement rather than a process that trips on its first byte.
  const budgetMb =
    rssBudget?.budgetMb !== undefined && rssBudget.budgetMb > 0 ? rssBudget.budgetMb : undefined
  const budgetSource = rssBudget?.source ?? 'unspecified'
  const releaseRatio = rssBudget?.releaseRatio ?? RSS_BUDGET_RELEASE_RATIO
  const reannounceMinMs = rssBudget?.reannounceMinMs ?? RSS_BUDGET_REANNOUNCE_MIN_MS
  let budgetState: RssBudgetState = 'within'
  let lastBudgetWarnAt = Number.NEGATIVE_INFINITY
  /** Only pair a "back within" with an over-budget line that was actually said. */
  let overBudgetAnnounced = false

  /**
   * One line per STATE CHANGE, never one per sample.
   *
   * The probe runs every {@link HEAP_WATCH_FAST_INTERVAL_MS}; warning on every
   * sample above the budget would put 30 lines a minute in the hub's shared log
   * for a process that is legitimately, steadily large. That is precisely the
   * failure mode that buried two real alarms under 83,198 heartbeat lines on
   * 2026-08-27, so the crossing is the event and the level is not.
   */
  const checkRssBudget = (sample: HeapSample, at: number): void => {
    if (budgetMb === undefined) return
    const previous = budgetState
    budgetState = nextRssBudgetState(previous, sample.rssMb, budgetMb, releaseRatio)
    if (budgetState === previous) return
    if (budgetState === 'over') {
      // Hysteresis bounds flapping at the edge; this bounds a process that
      // genuinely swings across the budget every reclaim cycle.
      if (at - lastBudgetWarnAt < reannounceMinMs) return
      lastBudgetWarnAt = at
      overBudgetAnnounced = true
      sink.warn(formatOverBudget(label, describeRss(sample, budgetMb), budgetSource))
      return
    }
    if (!overBudgetAnnounced) return
    overBudgetAnnounced = false
    sink.info(
      `[mem] ${label} back within its RSS budget — rss=${sample.rssMb}MB budget=${budgetMb}MB`,
    )
  }

  /**
   * PROBING and LOGGING are separate cadences, and that separation is the whole
   * point.
   *
   * The 2026-08-08 fatal escaped a 60s heartbeat because the burst began and
   * ended between two samples. Deciding "is the heap elevated?" only when a
   * line is due would reproduce that exactly: the process would still be read
   * once a minute, and a 62-second climb would still be invisible. So the timer
   * runs at the FAST period always — `process.memoryUsage()` is tens of
   * microseconds, i.e. free at this rate — and the slow period governs only how
   * often a steady process is allowed to say so.
   *
   * Never probe slower than the log cadence, or a caller passing a short
   * `intervalMs` would silently get the long one.
   */
  const probeIntervalMs = Math.min(fastIntervalMs, intervalMs)

  const tick = (): void => {
    try {
      const sample = read()
      const previous = mode
      mode = nextMode(previous, sample.usedRatio, escalateRatio, deescalateRatio)
      const at = now()
      const due = at - lastLoggedAt >= intervalMs
      // Escalated readings are the record of the climb — every one is kept.
      // Steady ones stay at the original once-a-minute so the log remains
      // readable when nothing is wrong.
      if (mode === 'escalated' || due) {
        lastLoggedAt = at
        const firstLine = firstLinePending
        firstLinePending = false
        // Read ONCE PER LINE: the read resets the histogram, so reading it on
        // every probe would throw away the ~58s the line claims to describe and
        // report the max of the last 2s under the same name.
        //
        // The per-space read is ONCE PER LINE for a different reason — cost.
        // Measured on Node 24.17: `v8.getHeapSpaceStatistics()` is 1216 ns
        // against 981 ns for `process.memoryUsage()`, so putting it on the 2s
        // probe would slightly more than DOUBLE the probe (1156 -> 2391 ns) to
        // compute a breakdown thrown away 29 times out of 30. On the emit path
        // it is 1.2 µs a minute, which is nothing, and the breakdown then
        // describes exactly the sample printed beside it.
        const line = format(
          label,
          sample,
          loopDelay?.read(),
          budgetMb,
          // APPENDED after the fan-out fields, never interleaved: the existing
          // `[mem]` fields keep their names and their order because the Loki
          // queries written against this line depend on the prefix.
          `${formatHeapSpaces(readSpaces(), firstLine ? 0 : undefined)}${formatEventPlane(eventPlane?.read())}` +
            formatSocketPlane(socketPlane?.read()) +
            formatMeshQueue(meshQueue?.()) +
            // LAST, after every field D446 and D456 appended: the GC rate is
            // the newest question this line answers, and nothing that reads
            // the older prefixes may move.
            formatGcCensus(gcCensus?.read(at)) +
            // LAST, after the GC rate D458 appended: what this PROCESS costs,
            // and how much of that is V8's background threads. `gcPauseMs` is
            // the main-thread pause and understated the real GC cost by 14x on
            // hub-main and 28x on stream-broker; `docker stats` reports the
            // cgroup and was read as if it described hub-main alone (D469).
            formatProcessCpu(processCpu.read(at)),
        )
        // Near the ceiling this is the last line before a possible fatal, so it
        // must not be filtered out as routine.
        if (sample.nearLimit) sink.warn(`${line} — APPROACHING HEAP LIMIT`)
        else if (mode === 'escalated') {
          // Says WHY the log suddenly got dense.
          sink.warn(`${line} — heap elevated, sampling every ${probeIntervalMs}ms`)
        } else sink.info(line)
      }
      if (previous === 'escalated' && mode === 'steady') {
        sink.info(`[mem] ${label} heap back to routine — logging every ${intervalMs}ms`)
      }
      // Checked on EVERY probe, not only when a line is due: the 2026-08-27
      // climb to 11.4GB and the ~154s container stall that ended it fit inside
      // one 5-minute runner heartbeat, exactly as the 2026-08-08 heap fatal fit
      // inside one 60s one. A budget evaluated at log cadence would reproduce
      // that blind spot in a new quantity.
      checkRssBudget(sample, at)
      maybeReclaim(sample)
      judgeArrayBuffers(sample, at)
      judgeOutboundQueues(at)
    } catch {
      // Never let the watcher take down what it is watching.
    }
  }

  // ── The outbound queues, judged on every probe ────────────────────────
  // A level, not a delta, so the raw READER is used here (the meter above
  // diffs traffic and must be read once per line; the queue is read as often
  // as the budget is). Every peer carries its plane as a prefix so a line
  // names `uds:pipeline-orchestrator` or `mesh:agent-a`, never a bare
  // id that could be either.
  const meshQueue = probes?.meshQueue
  const queueReader = probes?.socketPlane
  const queueGate =
    queueReader === undefined && meshQueue === undefined
      ? undefined
      : createOutboundQueueGate(probes?.outboundQueue)
  const judgeOutboundQueues = (at: number): void => {
    if (queueGate === undefined) return
    const readings = outboundQueueReadings(queueReader?.(), meshQueue?.())
    for (const verdict of queueGate.observe(readings, at)) {
      // Both verdicts are WARN: the hold is the retention the census exists
      // to name, and the release is the boundary both 2026-09-10 episodes
      // crossed with no line.
      sink.warn(formatOutboundQueueVerdict(label, verdict))
    }
  }

  // ── The ArrayBuffer census, armed by the probe itself ─────────────────
  // Judged on EVERY probe for the same reason the budget is: an episode that
  // begins and ends between two logged lines is invisible at log cadence, and
  // the 2026-09-10 releases took under 2 s. The census runs asynchronously
  // (inspector protocol) and never overlaps itself; while one is in flight the
  // gate's verdicts are dropped, not queued — the next probe re-judges.
  const censusProbe = probes?.arrayBufferCensus
  const censusGate =
    censusProbe === undefined ? undefined : createArrayBufferCensusGate(censusProbe)
  let censusInFlight = false
  const judgeArrayBuffers = (sample: HeapSample, at: number): void => {
    if (censusProbe === undefined || censusGate === undefined) return
    const verdict = censusGate.observe(sample.arrayBuffersMb, at)
    if (verdict.kind === 'released') {
      // The boundary both episodes crossed with no line. Whatever released it
      // did not say so; this at least puts a timestamp next to it.
      sink.warn(
        `[mem] ${label} arrayBuffers RELEASED ${verdict.fromMb}MB→${verdict.toMb}MB between two ` +
          `probes ${probeIntervalMs}ms apart — no owner logged this release; whatever held them ` +
          `let go in one instant (a socket that died, a queue that drained, a map that was cleared). ` +
          `Correlate with every line of this process in that window.`,
      )
      return
    }
    if (verdict.kind !== 'take' || censusInFlight) return
    censusInFlight = true
    const startedAt = now()
    const rawMb = sample.arrayBuffersMb
    void censusProbe
      .census()
      .then((report) => {
        sink.warn(
          formatArrayBufferCensus(label, report, {
            rawMb,
            tookMs: now() - startedAt,
            reason: verdict.reason,
          }),
        )
      })
      .catch((error: unknown) => {
        // A census that silently fails reads as "the episode never reached the
        // threshold", which is the one reading this exists to make impossible.
        sink.warn(
          `[mem] ${label} arrayBuffer census FAILED after ${now() - startedAt}ms ` +
            `(trigger: ${verdict.reason}) — ${error instanceof Error ? error.message : String(error)}`,
        )
      })
      .finally(() => {
        censusInFlight = false
      })
  }

  const timer = setInterval(tick, probeIntervalMs)
  timer.unref?.()
  tick()
  // Once, at boot: a ceiling nobody chose is a fact about THIS process, and it
  // is unreadable anywhere else — it lives in an image comment and in argv.
  // Only where the absence is UNEXPLAINED, though: see the caller in
  // startRunnerHeapWatch for why a runner never asks.
  // A process nobody gave a budget is NOT watched, and says so rather than
  // being watched against an invented default. Only a caller that PARTICIPATES
  // in the mechanism (i.e. passed `rssBudget` at all) reports — the production
  // callers, `main.ts` and `startRunnerHeapWatch`, always do, so the branch is
  // guaranteed wherever it matters and stays quiet in unrelated tests.
  if (rssBudget !== undefined && budgetMb === undefined) {
    sink.info(
      `[mem] ${label} is NOT WATCHED against an RSS budget — no budget declared ` +
        `(${budgetSource}). rss growth outside the V8 heap raises nothing here: ` +
        `--max-old-space-size bounds old space only, and stranded subtracts external by ` +
        `construction. Declare execution.rssBudgetMb once this process has a measured ` +
        `working set.`,
    )
  }
  const ceilingSource = launcherCeilingSource(label)
  if (announceCeilingOrigin && heapCeilingOrigin(execArgv) === 'v8-default') {
    sink.info(
      `[mem] ${label} heap ceiling is V8's DEFAULT (${read().heapLimitMb}MB) — no ` +
        `--max-old-space-size on argv. Nothing here CHOSE that number; it is derived ` +
        `from host RAM and moves with it.` +
        (ceilingSource === undefined ? '' : ` set by ${ceilingSource}`),
    )
  } else if (announceCeilingOrigin && ceilingSource !== undefined) {
    sink.info(`[mem] ${label} heap ceiling = ${read().heapLimitMb}MB, set by ${ceilingSource}`)
  }
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    // A histogram left enabled keeps libuv sampling for a watcher nobody reads.
    loopDelay?.stop()
    // Same rule for the GC observer: a PerformanceObserver left connected keeps
    // taking a callback per collection for a line that will never be printed.
    gcCensus?.stop()
  }
}

/**
 * Steady heartbeat period for a HEAVY addon runner.
 *
 * hub-main logs once a minute because it is ONE process. The heavy runners are
 * ~7 per node sharing the same hub log stream; at 60s each they would put 7
 * routine lines a minute in it forever, which is how a log stops being read.
 * Five minutes keeps the per-runner record (a leak is still a visible climb
 * across samples) at ~1.4 lines/min across the class.
 *
 * This slows LOGGING only. The probe keeps running at
 * {@link HEAP_WATCH_FAST_INTERVAL_MS} (probe and log cadences are separate —
 * see the comment inside {@link startHeapWatch}), so the reclaim gate and the
 * escalated burst-sampling react exactly as fast as hub-main's.
 */
export const RUNNER_HEAP_WATCH_INTERVAL_MS = 300_000

/** Wiring for {@link startRunnerHeapWatch}. */
export interface RunnerHeapWatchOptions {
  /**
   * `CAMSTACK_RUNNER_HEAP_PROFILE` as the parent passed it. Anything but
   * `'heavy'` (including unset — the un-annotated default is light) starts
   * nothing: light runners are small, already carry V8 heap flags, and a
   * quiet runner must never pay a stop-the-world.
   */
  readonly heapProfile: string | undefined
  /** Log label — the runner's nodeId, so `[mem]` lines group per runner. */
  readonly label: string
  readonly sink: HeapWatchSink
  /**
   * `CAMSTACK_RUNNER_HEAP_RECLAIM` as the environment carries it. `'off'`
   * keeps the heartbeat and disables only the reclaim pass — the operator
   * kill-switch for the media path, usable without a rebuild.
   */
  readonly reclaimSwitch?: string
  /** Heartbeat period override. Defaults to {@link RUNNER_HEAP_WATCH_INTERVAL_MS}. */
  readonly intervalMs?: number
  /** Test injection. Production omits it and gets {@link createV8Reclaimer}. */
  readonly reclaimOptions?: HeapReclaimOptions
  /**
   * `CAMSTACK_RUNNER_RSS_BUDGET_MB` as the parent passed it — the MAXIMUM
   * `execution.rssBudgetMb` any co-located addon declares, resolved from the
   * manifests in `process-service.ts`. Absent means no co-located addon declared
   * one, and the runner reports itself UNWATCHED. See {@link RssBudgetOptions}.
   */
  readonly rssBudgetMb?: string
}

/**
 * Parse a budget carried across a process boundary as an env string.
 *
 * Anything that is not a positive finite integer is `undefined` — i.e. the
 * process is UNWATCHED and says so. A malformed budget must never round to a
 * silent default: that is the failure this whole mechanism exists to remove.
 */
export function parseRssBudgetMb(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.floor(parsed)
}

/** Env var carrying a runner's declared RSS budget from parent to child. */
export const RUNNER_RSS_BUDGET_ENV = 'CAMSTACK_RUNNER_RSS_BUDGET_MB'

/** Operator override for hub-main's budget, applied without a release. */
export const HUB_RSS_BUDGET_ENV = 'CAMSTACK_HUB_RSS_BUDGET_MB'

/**
 * hub-main's declared RSS budget, in MB.
 *
 * ## Why the number lives HERE and not in the image
 *
 * hub-main has no manifest to declare it in, and the obvious alternative — the
 * entrypoint that already knew about `CAMSTACK_HUB_HEAP_MB` — is the least
 * deployable surface in this system. The Dockerfile says so itself: the image
 * never contains this repo's backend, so a value written there reaches a running
 * hub only on an image rebuild. `main.ts` is what `applyServerUpdate` replaces,
 * which is exactly why the heartbeat was started from there in the first place.
 * A budget that cannot ship is not a budget.
 *
 * ## Why 4096
 *
 * hub-main's entitlement is its old-space ceiling plus its measured native
 * floor. The floor is 438MB, established live across five consecutive
 * `gc(last-resort)` passes that landed within 4MB of each other
 * (4559/4561/4560/4562/4563MB) — sqlite pages, libvips, sharp, thread stacks and
 * node's own text. Against the 3072MB ceiling in force on 2026-08-27 that is
 * ~3.5GB of legitimate footprint, and 4096 leaves it ~600MB of slack.
 *
 * **This WILL fire on the hub as measured on 2026-08-27, and that is the point.**
 * That process sat at 4.87GiB with `external` at 360MB: ~2.8GB of it was native
 * memory already freed and never returned, spread across 13 anonymous mappings
 * >=64MB, with only 1295MB in V8 pages. `MALLOC_ARENA_MAX=2` and
 * `VIPS_CONCURRENCY=1` were already applied — verified from `/proc/<pid>/environ`
 * — so that lever is spent and the residue stands. The alarm reporting a
 * genuinely over-budget process is the mechanism working; a number picked to sit
 * just above today's RSS would be a rubber stamp.
 *
 * An operator who decides that residue is the cost of doing business moves it in
 * one place with {@link HUB_RSS_BUDGET_ENV}, and the decision is on the record
 * instead of being absorbed by a threshold nobody set.
 */
export const HUB_MAIN_RSS_BUDGET_MB = 4096

/** hub-main's budget: the declared number, or the operator's override. */
export function hubMainRssBudget(env: NodeJS.ProcessEnv = process.env): RssBudgetOptions {
  const override = env[HUB_RSS_BUDGET_ENV]
  if (override !== undefined) {
    return { budgetMb: parseRssBudgetMb(override), source: HUB_RSS_BUDGET_ENV }
  }
  return { budgetMb: HUB_MAIN_RSS_BUDGET_MB, source: 'HUB_MAIN_RSS_BUDGET_MB (kernel/heap-watch)' }
}

/**
 * Start the heap watch + stranded-page reclaimer for ONE addon runner, iff it
 * is a heavy one. Returns the stop function, or undefined when nothing started.
 *
 * ## Why heavy runners get hub-main's mechanism
 *
 * Because a heap ceiling cannot reach what actually strands in them. Every
 * media-path runner now carries an old-space ceiling sized from its own
 * measured peak (`addon-pipeline` manifest + its `manifest-heap-ceilings` spec),
 * and that changes nothing here: what a heavy runner strands is NATIVE —
 * `external`, `arrayBuffers`, glibc arena free lists — none of which
 * `--max-old-space-size` bounds. Measured 2026-08-25, `hub/pipeline-analytics`
 * reported `stranded=2552MB` while holding an 81MB V8 heap under a 1024MB
 * ceiling that was in force the whole time. hub-main had exactly this shape and
 * its reclaimer is proven live — 11 passes in 4h, 375–1652MB returned per pass
 * at 550–680ms each. Same mechanism, same `shouldReclaim` stranded-over-trigger
 * gate; never a second implementation.
 *
 * ## The stall, priced for the runners that get it
 *
 * A pass is a sub-second stop-the-world at most once per
 * {@link HEAP_RECLAIM_MIN_INTERVAL_MS}, and only while >1GiB is stranded. For
 * the recorder — finalizing a segment every ~300ms across 34 profile-writers —
 * the pause delays WATCHER work, not video: ffmpeg children keep writing to
 * disk independently, the playlist tail is the durable queue, and the next
 * tick drains what accrued. For stream-broker a pass can hitch live frames
 * once per qualifying window; after a pass the runner sits at its floor and
 * re-stranding the trigger takes tens of minutes, so in practice the class
 * pays a few passes per hour against the multi-GiB peak that was OOM-killing
 * a neighbouring VM on a host with no swap.
 */
export function startRunnerHeapWatch(options: RunnerHeapWatchOptions): (() => void) | undefined {
  if (options.heapProfile !== 'heavy') return undefined
  const intervalMs = options.intervalMs ?? RUNNER_HEAP_WATCH_INTERVAL_MS
  // Always present, even when the parent declared nothing: `budgetMb: undefined`
  // is what makes the runner report itself UNWATCHED instead of silently having
  // no alarm. The RSS budget is independent of the reclaim kill-switch — turning
  // the stop-the-world off must never also turn the reporting off.
  const rssBudget: RssBudgetOptions = {
    budgetMb: parseRssBudgetMb(options.rssBudgetMb),
    source: `manifest execution.rssBudgetMb (via ${RUNNER_RSS_BUDGET_ENV})`,
  }
  if (options.reclaimSwitch === 'off') {
    // Heartbeat-only: the record stays (a silent disable would read as "it was
    // never needed") while the pass is off.
    return startHeapWatch(
      options.label,
      options.sink,
      intervalMs,
      undefined,
      undefined,
      undefined,
      false,
      rssBudget,
    )
  }
  let reclaimOptions = options.reclaimOptions
  if (reclaimOptions === undefined) {
    const reclaimer = createV8Reclaimer()
    reclaimOptions = reclaimer === undefined ? undefined : { reclaim: reclaimer }
  }
  return startHeapWatch(
    options.label,
    options.sink,
    intervalMs,
    reclaimOptions,
    undefined,
    undefined,
    // A runner DOES ask who chose its ceiling — since 2026-08-25 no shipped
    // addon declares `execution.maxOldSpaceMb: 0`, so `process-service.ts` puts
    // `--max-old-space-size` on every heavy runner's argv. An absent flag is
    // therefore no longer a declaration: it means the manifest drifted or the
    // runner is executing a stale deploy, and both are worth one line at boot.
    // (This was `false` while the media path ran uncapped on purpose; leaving it
    // false now would suppress the only signal that the ceiling went missing.)
    true,
    rssBudget,
  )
}
