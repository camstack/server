/**
 * Shared control-plane reachability poller for camera devices.
 *
 * `device.online` must reflect CONTROL-PLANE REACHABILITY — "can we talk to
 * the camera's management API right now" — NOT whether video happens to be
 * flowing through the stream broker. A camera that dials on-demand (no
 * consumer attached) is fully reachable yet has no active stream; driving
 * `online` from stream health falsely marks it OFFLINE.
 *
 * Every camera provider owns a cheap control-plane round-trip (Hikvision
 * ISAPI `getDeviceInfo`, Amcrest Dahua CGI `getDeviceInfo`, ONVIF
 * `getDeviceInformation`, RTSP `OPTIONS`/TCP-connect). Each provider passes
 * that round-trip as a `probe: () => Promise<boolean>` and this helper runs
 * the loop, applies hysteresis, and drives the device's `online` setter.
 *
 * Hysteresis rules (avoid flapping on a single dropped packet):
 *   - mark ONLINE immediately on the first successful probe;
 *   - mark OFFLINE only after {@link REACHABILITY_FAILURES_TO_OFFLINE}
 *     CONSECUTIVE failures.
 *
 * Robustness rules:
 *   - each probe is bounded by {@link REACHABILITY_PROBE_TIMEOUT_MS} so a hung
 *     control channel can't wedge the loop;
 *   - a single in-flight probe at a time — a slow probe never stacks up;
 *   - the loop never throws (a rejected/thrown probe counts as a failure);
 *   - `isEnabled()` gates each tick so a soft-disabled device isn't polled.
 */

/** Poll cadence — probe every camera's control plane on this interval. */
export const REACHABILITY_POLL_INTERVAL_MS = 30_000

/**
 * Consecutive failures required before flipping `online` to `false`.
 * ONLINE is asserted on the first success; OFFLINE waits for N misses so a
 * single transient timeout doesn't flap the flag.
 */
export const REACHABILITY_FAILURES_TO_OFFLINE = 3

/** Per-probe timeout — an unreachable/hung control channel resolves as a miss. */
export const REACHABILITY_PROBE_TIMEOUT_MS = 10_000

/**
 * Minimal logger surface the poller uses. Declared with METHOD syntax
 * (not a property arrow) so the parameter check is bivariant — a scoped
 * logger whose `debug` takes a structured `LogExtras` second argument
 * satisfies this without the caller having to import the logger types.
 */
export interface ReachabilityPollLogger {
  debug(message: string, meta?: unknown): void
}

export interface ReachabilityPollOptions {
  /**
   * Control-plane round-trip. Resolve `true` when the camera is reachable,
   * `false` (or throw/reject) when it is not. Never assume it resolves —
   * the poller bounds it with a timeout regardless.
   */
  readonly probe: () => Promise<boolean>
  /**
   * Drives the device's online flag — typically `(v) => { device.online = v }`
   * or `device.markOnline`. Called only on an actual transition decision
   * (idempotent setters are fine; `markOnline` already no-ops on no-change).
   */
  readonly setOnline: (online: boolean) => void
  /**
   * Gate for each tick. Return `false` to skip the probe entirely (e.g. a
   * soft-disabled device, or a sleeping battery camera). Default: always on.
   * A skipped tick does NOT count as a failure and leaves `online` untouched.
   */
  readonly isEnabled?: () => boolean
  /** Override the 30s cadence (tests). */
  readonly intervalMs?: number
  /** Override the 3-miss offline threshold (tests). */
  readonly failuresToOffline?: number
  /** Override the 10s per-probe timeout (tests). */
  readonly probeTimeoutMs?: number
  /** Optional scoped logger for probe-failure diagnostics. */
  readonly logger?: ReachabilityPollLogger
  /**
   * Run the first probe immediately instead of waiting one interval.
   * Default `true` — a freshly-activated camera should reflect reachability
   * without a 30s blind window.
   */
  readonly runImmediately?: boolean
}

export interface ReachabilityPollHandle {
  /** Stop the loop and release the timer. Idempotent. */
  readonly stop: () => void
}

/** Reject after `ms`; always clears its own timer. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${String(ms)}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Start the reachability poll loop. Returns a handle whose `stop()` clears the
 * timer and prevents any further ticks. Start on device activation, stop on
 * device teardown (`removeDevice`) so no timer leaks.
 */
export function startReachabilityPoll(options: ReachabilityPollOptions): ReachabilityPollHandle {
  const intervalMs = options.intervalMs ?? REACHABILITY_POLL_INTERVAL_MS
  const failuresToOffline = options.failuresToOffline ?? REACHABILITY_FAILURES_TO_OFFLINE
  const probeTimeoutMs = options.probeTimeoutMs ?? REACHABILITY_PROBE_TIMEOUT_MS
  const runImmediately = options.runImmediately ?? true

  let stopped = false
  let running = false
  let consecutiveFailures = 0
  let timer: ReturnType<typeof setInterval> | undefined

  const tick = async (): Promise<void> => {
    if (stopped) return
    // Single in-flight probe — a slow round-trip must not stack up behind
    // the interval firing again.
    if (running) return
    if (options.isEnabled && !options.isEnabled()) return
    running = true
    try {
      const reachable = await withTimeout(
        Promise.resolve().then(options.probe),
        probeTimeoutMs,
        'reachability probe',
      )
      if (stopped) return
      if (reachable) {
        consecutiveFailures = 0
        options.setOnline(true)
      } else {
        registerFailure('probe resolved unreachable')
      }
    } catch (error: unknown) {
      if (stopped) return
      registerFailure(error instanceof Error ? error.message : 'probe threw')
    } finally {
      running = false
    }
  }

  const registerFailure = (reason: string): void => {
    consecutiveFailures += 1
    options.logger?.debug('reachability probe failed', {
      reason,
      consecutiveFailures,
      failuresToOffline,
    })
    if (consecutiveFailures >= failuresToOffline) {
      options.setOnline(false)
    }
  }

  timer = setInterval(() => {
    void tick()
  }, intervalMs)
  // Don't keep the process alive purely for this poll.
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    timer.unref()
  }

  if (runImmediately) void tick()

  return {
    stop: (): void => {
      if (stopped) return
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}
