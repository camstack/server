/**
 * Pool memory watchdog — bounds the RSS of the long-lived Python inference
 * subprocesses (detection `inference_pool.py`, audio `yamnet_audio.py`,
 * post-analysis `raw_tensor_inference.py` / `text_encoder_inference.py`)
 * BEFORE the kernel's OOM killer does, and emits the periodic per-pool
 * memory line that makes an hours-long leak legible after the fact.
 *
 * Why this exists (2026-08-18 audit): the pools leak over hours — measured
 * 97 / 78 / 171 / 689 MB with the 689 MB one climbing ~7 MB per 30 min —
 * then get OOM-killed (anon-rss 3.8 GB inside the CamStack cgroup at 11:45,
 * 8.8 GB host-wide at 17:02, same day), respawn at ~100 MB and repeat. The
 * host is 62 GiB with NO swap and the pressure killed the co-hosted Home
 * Assistant VM twice. The kernel was the only bound; this module makes the
 * bound ours, and makes every step of the ramp visible in Loki.
 *
 * Placement: this lives in `@camstack/types` because BOTH `addon-pipeline`
 * and `addon-post-analysis` need it, addons must not import each other, and
 * self-contained addon bundles INLINE the bare `@camstack/types` entry at
 * build time (see tools/build/vite-lib.preset.ts) — so the code ships with a
 * plain `camstack deploy` of each addon, no framework train required. It is
 * deliberately free of Node imports (`fs`, `child_process`): the pure policy
 * below is also consumed through the types index that UI builds import.
 * The `/proc` READ lives in each addon; the parse lives here.
 */

import type { IScopedLogger } from '../interfaces/logging.js'

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface PoolMemoryPolicy {
  /** Sweep cadence. 60 s makes a 6-hour ramp 360 points (legible) at ~4
   *  lines/min across all pools (no flood); the addon log ring only holds
   *  ~10 min, but these lines are shipped to Loki which holds days. */
  readonly sampleIntervalMs: number
  /** Samples IGNORED after a pool (re)appears before baseline capture
   *  starts. Model loads land in the first minutes and inflate RSS —
   *  a baseline taken at spawn would be the empty interpreter (~40 MB)
   *  and every loaded pool would instantly look leaky. */
  readonly baselineSettleSamples: number
  /** Post-settle samples whose MEDIAN becomes the baseline. Median, not
   *  mean: one inference burst mid-window must not drag the baseline up. */
  readonly baselineSampleCount: number
  /** Restart when RSS exceeds `restartMultiple × baseline`. Relative, not
   *  absolute: an absolute MB number ages badly as models change, while
   *  "4× what this pool settled at with its own models loaded" survives a
   *  model swap unchanged. */
  readonly restartMultiple: number
  /** Never restart below this RSS regardless of the multiple. The pools
   *  settle at 78–171 MB today; without a floor, 4× a 78 MB baseline
   *  (312 MB) would flap on legitimate working-set growth (a second model
   *  loaded, a larger frame cache). Below the floor the pool is not a
   *  host-level threat on a 62 GiB machine. */
  readonly floorBytes: number
  /** Restart at this RSS even when the baseline is unknown or huge. This is
   *  the backstop for (a) a pool that ramps before its baseline exists and
   *  (b) a baseline poisoned by an already-leaking pool at guard start.
   *  3 GiB sits well under the observed kill sizes (3.8 / 8.8 GB anon-rss)
   *  and far above any legitimate settled pool observed on this fleet. */
  readonly ceilingBytes: number
  /** Minimum gap between watchdog restarts of ONE pool. A pool that
   *  re-crosses within minutes of a restart is leaking faster than a
   *  restart can pay for — restarting it in a tight loop would trade an
   *  OOM for a detection outage. */
  readonly cooldownMs: number
  /** Watchdog restarts allowed per pool per `restartWindowMs`; past this
   *  the watchdog STOPS restarting and escalates (error log). Mirrors the
   *  CrashSupervisor circuit-breaker rule (D6) at pool granularity: never
   *  an unbounded restarter. */
  readonly maxRestartsPerWindow: number
  /** Window for `maxRestartsPerWindow`. */
  readonly restartWindowMs: number
}

const MB = 1024 * 1024

export const DEFAULT_POOL_MEMORY_POLICY: PoolMemoryPolicy = {
  sampleIntervalMs: 60_000,
  baselineSettleSamples: 5,
  baselineSampleCount: 3,
  restartMultiple: 4,
  floorBytes: 1024 * MB,
  ceilingBytes: 3072 * MB,
  cooldownMs: 30 * 60_000,
  maxRestartsPerWindow: 6,
  restartWindowMs: 24 * 60 * 60_000,
}

/**
 * Resolve the policy from env overrides (`CAMSTACK_POOL_MEM_*`). Garbage or
 * absent values keep the default — an operator typo must never disable the
 * bound or set it to zero.
 */
export function resolvePoolMemoryPolicy(
  env: Readonly<Record<string, string | undefined>>,
): PoolMemoryPolicy {
  const num = (key: string, fallback: number, min: number): number => {
    const raw = env[key]
    if (raw === undefined) return fallback
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
  }
  const d = DEFAULT_POOL_MEMORY_POLICY
  return {
    sampleIntervalMs: num('CAMSTACK_POOL_MEM_INTERVAL_MS', d.sampleIntervalMs, 5_000),
    baselineSettleSamples: d.baselineSettleSamples,
    baselineSampleCount: d.baselineSampleCount,
    restartMultiple: num('CAMSTACK_POOL_MEM_MULTIPLE', d.restartMultiple, 1.5),
    floorBytes: num('CAMSTACK_POOL_MEM_FLOOR_MB', d.floorBytes / MB, 128) * MB,
    ceilingBytes: num('CAMSTACK_POOL_MEM_CEILING_MB', d.ceilingBytes / MB, 256) * MB,
    cooldownMs: num('CAMSTACK_POOL_MEM_COOLDOWN_MS', d.cooldownMs, 60_000),
    maxRestartsPerWindow: num('CAMSTACK_POOL_MEM_MAX_RESTARTS', d.maxRestartsPerWindow, 1),
    restartWindowMs: num('CAMSTACK_POOL_MEM_RESTART_WINDOW_MS', d.restartWindowMs, 60_000),
  }
}

// ---------------------------------------------------------------------------
// /proc/<pid>/status parsing (pure — the fs read lives in the addon)
// ---------------------------------------------------------------------------

export interface ProcMemory {
  readonly rssBytes: number
  /** Virtual size. The 2026-08-18 kills showed total-vm 47.5 GB vs 11.3 GB at
   *  similar RSS — tracking VmSize alongside Threads is the cheap lead on
   *  "allocator arenas vs thread stacks" the audit flagged. */
  readonly vmBytes: number
  /** Peak RSS (VmHWM) — the `resource.getrusage` maxrss equivalent, readable
   *  from OUTSIDE the process, so it covers the pools whose wire protocol has
   *  no command channel (yamnet / raw-tensor). */
  readonly hwmBytes: number
  readonly swapBytes: number
  readonly threads: number
}

/** Parse the fields this watchdog needs out of `/proc/<pid>/status` text.
 *  Returns null when VmRSS is missing (dead pid, kernel thread, bad read). */
export function parseProcStatus(text: string): ProcMemory | null {
  const kb = (label: string): number | null => {
    const match = text.match(new RegExp(`^${label}:\\s+(\\d+)\\s*kB`, 'm'))
    return match ? Number(match[1]) * 1024 : null
  }
  const rssBytes = kb('VmRSS')
  if (rssBytes === null) return null
  const threadsMatch = text.match(/^Threads:\s+(\d+)/m)
  return {
    rssBytes,
    vmBytes: kb('VmSize') ?? 0,
    hwmBytes: kb('VmHWM') ?? 0,
    swapBytes: kb('VmSwap') ?? 0,
    threads: threadsMatch ? Number(threadsMatch[1]) : 0,
  }
}

// ---------------------------------------------------------------------------
// Pure evaluation core
// ---------------------------------------------------------------------------

export interface PoolMemoryState {
  readonly settleSeen: number
  readonly baselineWindow: readonly number[]
  readonly baselineBytes: number | null
  /** Timestamps of WATCHDOG restarts (never kernel kills — those reset the
   *  baseline via the pid-change path but must not eat the budget). */
  readonly restartsAt: readonly number[]
  readonly lastRestartAt: number | null
}

export function initialPoolMemoryState(): PoolMemoryState {
  return {
    settleSeen: 0,
    baselineWindow: [],
    baselineBytes: null,
    restartsAt: [],
    lastRestartAt: null,
  }
}

export type PoolMemoryAction = 'ok' | 'baseline-pending' | 'restart' | 'cooldown' | 'exhausted'

export interface PoolMemoryVerdict {
  readonly state: PoolMemoryState
  readonly action: PoolMemoryAction
  readonly baselineBytes: number | null
  readonly thresholdBytes: number
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function advanceBaseline(
  state: PoolMemoryState,
  rssBytes: number,
  policy: PoolMemoryPolicy,
): PoolMemoryState {
  if (state.baselineBytes !== null) return state
  if (state.settleSeen < policy.baselineSettleSamples) {
    return { ...state, settleSeen: state.settleSeen + 1 }
  }
  const window = [...state.baselineWindow, rssBytes]
  if (window.length < policy.baselineSampleCount) {
    return { ...state, baselineWindow: window }
  }
  return { ...state, baselineWindow: window, baselineBytes: median(window) }
}

/** The one place a pool's restart threshold is computed. */
export function poolMemoryThreshold(
  baselineBytes: number | null,
  policy: PoolMemoryPolicy,
): number {
  if (baselineBytes === null) return policy.ceilingBytes
  return Math.min(
    policy.ceilingBytes,
    Math.max(policy.floorBytes, policy.restartMultiple * baselineBytes),
  )
}

function pruneRestarts(
  restartsAt: readonly number[],
  nowMs: number,
  policy: PoolMemoryPolicy,
): readonly number[] {
  return restartsAt.filter((t) => nowMs - t < policy.restartWindowMs)
}

/**
 * Evaluate one RSS sample. Pure: returns the successor state plus the verdict.
 * The caller performs (and logs) the restart, then commits it via
 * {@link commitWatchdogRestart}.
 */
export function evaluatePoolMemory(
  state: PoolMemoryState,
  rssBytes: number,
  nowMs: number,
  policy: PoolMemoryPolicy,
): PoolMemoryVerdict {
  const next = advanceBaseline(state, rssBytes, policy)
  const thresholdBytes = poolMemoryThreshold(next.baselineBytes, policy)
  if (rssBytes <= thresholdBytes) {
    return {
      state: next,
      action: next.baselineBytes === null ? 'baseline-pending' : 'ok',
      baselineBytes: next.baselineBytes,
      thresholdBytes,
    }
  }
  const inWindow = pruneRestarts(next.restartsAt, nowMs, policy)
  const pruned: PoolMemoryState = { ...next, restartsAt: inWindow }
  if (inWindow.length >= policy.maxRestartsPerWindow) {
    return { state: pruned, action: 'exhausted', baselineBytes: next.baselineBytes, thresholdBytes }
  }
  if (pruned.lastRestartAt !== null && nowMs - pruned.lastRestartAt < policy.cooldownMs) {
    return { state: pruned, action: 'cooldown', baselineBytes: next.baselineBytes, thresholdBytes }
  }
  return { state: pruned, action: 'restart', baselineBytes: next.baselineBytes, thresholdBytes }
}

/** Record a performed watchdog restart: budget consumed, baseline reset —
 *  the recreated pool is a NEW process and gets a fresh settle window. */
export function commitWatchdogRestart(state: PoolMemoryState, nowMs: number): PoolMemoryState {
  return {
    ...initialPoolMemoryState(),
    restartsAt: [...state.restartsAt, nowMs],
    lastRestartAt: nowMs,
  }
}

/** Reset baseline tracking (pool process replaced OUTSIDE the watchdog —
 *  kernel OOM kill + respawn, idle-reaper eviction, tuning respawn). The
 *  restart budget is kept: it bounds the WATCHDOG, not the pool. */
export function resetPoolBaseline(state: PoolMemoryState): PoolMemoryState {
  return {
    ...initialPoolMemoryState(),
    restartsAt: state.restartsAt,
    lastRestartAt: state.lastRestartAt,
  }
}

export interface RestartCandidate {
  readonly key: string
  readonly rssBytes: number
  readonly thresholdBytes: number
}

/**
 * Pick ONE pool to restart this sweep — the worst overage ratio. Restarting
 * several pools at once (e.g. after a model rollout grew every baseline)
 * would take detection down on every camera simultaneously; one per sweep
 * means the survivors keep serving while the worst offender reloads, and the
 * next sweep (one interval later) takes the next one.
 */
export function pickRestartCandidate(candidates: readonly RestartCandidate[]): string | null {
  if (candidates.length === 0) return null
  let worst = candidates[0]!
  for (const c of candidates) {
    if (c.rssBytes / c.thresholdBytes > worst.rssBytes / worst.thresholdBytes) worst = c
  }
  return worst.key
}

// ---------------------------------------------------------------------------
// Watchdog service — the sweep loop
// ---------------------------------------------------------------------------

/** One pool's sample for a sweep. `meta` carries the owner's cheap internals
 *  (backlog, shed counts, models loaded, Python-side mem stats) verbatim into
 *  the periodic `pool memory` line. */
export interface PoolMemoryTelemetry {
  readonly key: string
  readonly pids: readonly number[]
  /** Max worker RSS for the pool — the kernel kills a PROCESS, so the bound
   *  tracks the biggest worker, not the pool sum. */
  readonly rssBytes: number
  readonly meta?: Readonly<Record<string, unknown>>
}

export interface PoolMemoryWatchdogOptions {
  readonly policy: PoolMemoryPolicy
  /** Enumerate the live pools with their current RSS + internals. */
  readonly sample: () => Promise<readonly PoolMemoryTelemetry[]>
  /** Dispose-and-recreate the named pool via the owner's EXISTING lifecycle
   *  machinery (idle-reaper dispose path, lazy re-init) — the watchdog is a
   *  trigger, never a second process supervisor. */
  readonly restart: (key: string) => Promise<void>
  readonly log: IScopedLogger
  readonly now?: () => number
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

interface TrackedPool {
  readonly state: PoolMemoryState
  readonly pids: readonly number[]
}

export class PoolMemoryWatchdog {
  private readonly pools = new Map<string, TrackedPool>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private sweeping = false
  private stopped = false
  private readonly opts: PoolMemoryWatchdogOptions
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void

  constructor(opts: PoolMemoryWatchdogOptions) {
    this.opts = opts
    this.now = opts.now ?? (() => Date.now())
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t))
  }

  start(): void {
    if (this.timer || this.stopped) return
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      this.clearTimer(this.timer)
      this.timer = null
    }
  }

  private arm(): void {
    const timer = this.setTimer(() => {
      void this.sweep().finally(() => {
        if (!this.stopped) this.arm()
      })
    }, this.opts.policy.sampleIntervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    this.timer = timer
  }

  /** One sweep: sample → log every pool → restart at most one. Public so the
   *  loop is testable without fake global timers. */
  async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      await this.doSweep()
    } catch (err) {
      // A watchdog that dies silently is a bound that silently stopped
      // existing — the exact failure mode this repo keeps re-learning.
      this.opts.log.warn('pool memory sweep failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    } finally {
      this.sweeping = false
    }
  }

  private async doSweep(): Promise<void> {
    const nowMs = this.now()
    const samples = await this.opts.sample()
    const candidates: RestartCandidate[] = []
    const verdictByKey = new Map<string, PoolMemoryVerdict>()

    for (const t of samples) {
      const tracked = this.pools.get(t.key)
      let state = tracked?.state ?? initialPoolMemoryState()
      // `tracked.pids` is emptied after OUR OWN restart — the pid change that
      // follows one is expected and must not warn as an outside event.
      if (tracked && tracked.pids.length > 0 && !samePids(tracked.pids, t.pids)) {
        // The process behind this pool changed without us restarting it —
        // kernel OOM kill + respawn, idle eviction, tuning respawn. Say so
        // (an OOM kill that respawns quietly is how this leak stayed
        // invisible), and re-baseline the fresh process.
        this.opts.log.warn('pool process changed outside the watchdog — re-baselining', {
          meta: { poolKey: t.key, previousPids: tracked.pids, pids: t.pids },
        })
        state = resetPoolBaseline(state)
      }
      const verdict = evaluatePoolMemory(state, t.rssBytes, nowMs, this.opts.policy)
      this.pools.set(t.key, { state: verdict.state, pids: t.pids })
      verdictByKey.set(t.key, verdict)

      // The periodic record. One line per pool per sweep, shipped to Loki —
      // this is the historical data that makes "when did it start climbing,
      // and what else moved with it" answerable after the fact.
      this.opts.log.info('pool memory', {
        meta: {
          poolKey: t.key,
          pids: t.pids,
          rssMb: Math.round(t.rssBytes / MB),
          baselineMb:
            verdict.baselineBytes === null ? null : Math.round(verdict.baselineBytes / MB),
          thresholdMb: Math.round(verdict.thresholdBytes / MB),
          action: verdict.action,
          ...t.meta,
        },
      })

      if (verdict.action === 'restart') {
        candidates.push({
          key: t.key,
          rssBytes: t.rssBytes,
          thresholdBytes: verdict.thresholdBytes,
        })
      } else if (verdict.action === 'cooldown') {
        this.opts.log.warn('pool over memory threshold but inside restart cooldown', {
          meta: {
            poolKey: t.key,
            rssMb: Math.round(t.rssBytes / MB),
            thresholdMb: Math.round(verdict.thresholdBytes / MB),
            cooldownMs: this.opts.policy.cooldownMs,
          },
        })
      } else if (verdict.action === 'exhausted') {
        this.opts.log.error(
          'pool memory watchdog gave up — restart budget exhausted, pool leaks faster than restarts can pay for; needs a heap profile (py-spy / tracemalloc)',
          {
            meta: {
              poolKey: t.key,
              rssMb: Math.round(t.rssBytes / MB),
              thresholdMb: Math.round(verdict.thresholdBytes / MB),
              maxRestartsPerWindow: this.opts.policy.maxRestartsPerWindow,
              restartWindowMs: this.opts.policy.restartWindowMs,
            },
          },
        )
      }
    }

    // Drop state for pools that disappeared (disposed by their owner).
    for (const key of [...this.pools.keys()]) {
      if (!samples.some((t) => t.key === key)) this.pools.delete(key)
    }

    const pickedKey = pickRestartCandidate(candidates)
    if (pickedKey === null) return
    const picked = candidates.find((c) => c.key === pickedKey)!
    const verdict = verdictByKey.get(pickedKey)!
    const tracked = this.pools.get(pickedKey)!
    const restartsInWindow = tracked.state.restartsAt.length + 1
    this.opts.log.warn('pool memory watchdog restarting pool — RSS over threshold', {
      meta: {
        poolKey: pickedKey,
        pids: tracked.pids,
        rssMb: Math.round(picked.rssBytes / MB),
        thresholdMb: Math.round(picked.thresholdBytes / MB),
        baselineMb: verdict.baselineBytes === null ? null : Math.round(verdict.baselineBytes / MB),
        restartsInWindow,
        deferredCandidates: candidates.filter((c) => c.key !== pickedKey).map((c) => c.key),
      },
    })
    try {
      await this.opts.restart(pickedKey)
      this.pools.set(pickedKey, {
        state: commitWatchdogRestart(tracked.state, this.now()),
        pids: [],
      })
    } catch (err) {
      // A restart that fails and says nothing leaves the pool over threshold
      // with everyone believing it was handled.
      this.opts.log.error('pool memory watchdog restart failed', {
        meta: {
          poolKey: pickedKey,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }
}

function samePids(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort((x, y) => x - y)
  const sortedB = [...b].sort((x, y) => x - y)
  return sortedA.every((v, i) => v === sortedB[i])
}
