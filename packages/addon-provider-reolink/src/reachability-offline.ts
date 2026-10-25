/**
 * Offline from SUSTAINED unreachability (D904).
 *
 * Until 2026-10-22 a Reolink camera went offline ONLY on the firmware's own
 * `offline` push. A camera that loses power sends no push — it is simply gone —
 * so camera 108 stayed `online` for 2 h 15 m with its control socket dead and
 * every login answering `EHOSTUNREACH`. The operator's rule: if the socket is
 * not reachable, offline must happen.
 *
 * D49 still holds: ONE failed probe never flips state. A failure opens a window
 * of {@link REACHABILITY_OFFLINE_WINDOW_MS}; any success inside it closes the
 * window and nothing is said. When the window ends with no success, ONE fresh
 * confirmation probe runs, and only its failure declares the camera offline —
 * two observations a window apart must agree before the destructive verdict.
 * While offline, a recovery probe runs every {@link REACHABILITY_RECOVERY_PROBE_MS}
 * (a mains camera: a login is cheap and wakes nothing), and the FIRST success —
 * that probe, or a login/stream somebody else's demand paid for — declares it
 * online again, once.
 *
 * Pure state machine: timers are the global ones (fake-timer friendly), the
 * probe and the two verdicts are injected. The camera owns the emits.
 */

/**
 * 2 min. Long enough to ride out what is NOT an outage: a camera reboot after a
 * firmware update or a settings write (60–90 s on the fleet), a Wi-Fi roam, a
 * switch port renegotiating, and the reconnect ladder's own back-off (capped at
 * 30 s, so a window always holds several real attempts). Short enough that an
 * operator hears about a dead camera while it still matters — the recorder's
 * own stall alarm fires after ~4–5 min, and this must not lag behind it.
 */
export const REACHABILITY_OFFLINE_WINDOW_MS = 120_000

/** How often an offline camera is re-probed when nobody else is dialling it. */
export const REACHABILITY_RECOVERY_PROBE_MS = 30_000

export type ReachabilityProbeResult = 'reachable' | 'unreachable'

export type ReachabilityState = 'reachable' | 'failing' | 'offline'

export interface ReachabilityOfflineInfo {
  /** When the first unanswered failure of this outage was seen (epoch ms). */
  readonly since: number
  readonly failures: number
  readonly lastReason: string
}

export interface ReachabilityOnlineInfo {
  readonly offlineForMs: number
}

export interface ReachabilityTrackerDeps {
  /** One fresh reachability attempt (a login). Must not throw — classify instead. */
  readonly probe: () => Promise<ReachabilityProbeResult>
  readonly onOffline: (info: ReachabilityOfflineInfo) => void
  readonly onOnline: (info: ReachabilityOnlineInfo) => void
  readonly windowMs?: number
  readonly recoveryProbeMs?: number
}

const CONNECTIVITY_CODES: ReadonlySet<string> = new Set([
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EADDRNOTAVAIL',
  'EPIPE',
])

const CONNECTIVITY_TEXT =
  /EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|ENETDOWN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EADDRNOTAVAIL|EPIPE|timed? ?out|socket hang up|socket closed|not connected/i

function errorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null
  const code = err.code
  return typeof code === 'string' ? code : null
}

/**
 * Did this failure say the camera could not be REACHED? An answer that came
 * back (wrong password, a rejected command) proves the camera is there, and is
 * not a reason to call it offline.
 */
export function isConnectivityFailure(err: unknown): boolean {
  const code = errorCode(err)
  if (code !== null && CONNECTIVITY_CODES.has(code)) return true
  const text = err instanceof Error ? err.message : String(err)
  return CONNECTIVITY_TEXT.test(text)
}

export class ReachabilityOfflineTracker {
  private stateValue: ReachabilityState = 'reachable'
  private since = 0
  private failures = 0
  private lastReason = ''
  private offlineAt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private probing = false
  private disposed = false
  private readonly windowMs: number
  private readonly recoveryProbeMs: number

  constructor(private readonly deps: ReachabilityTrackerDeps) {
    this.windowMs = deps.windowMs ?? REACHABILITY_OFFLINE_WINDOW_MS
    this.recoveryProbeMs = deps.recoveryProbeMs ?? REACHABILITY_RECOVERY_PROBE_MS
  }

  get state(): ReachabilityState {
    return this.stateValue
  }

  /** The camera could not be reached (socket lost, a login refused at the network level). */
  noteFailure(reason: string): void {
    if (this.disposed) return
    this.failures += 1
    this.lastReason = reason
    if (this.stateValue !== 'reachable') return
    this.stateValue = 'failing'
    this.since = Date.now()
    this.arm(this.windowMs, () => this.confirm())
  }

  /** The camera answered (a login, a stream). Closes a window; ends an outage once. */
  noteReachable(): void {
    if (this.disposed) return
    const wasOffline = this.stateValue === 'offline'
    const offlineForMs = Date.now() - this.offlineAt
    this.clear()
    if (wasOffline) this.deps.onOnline({ offlineForMs })
  }

  /** The firmware said what the camera is (a push): forget our own verdict, emit nothing. */
  reset(): void {
    this.clear()
  }

  dispose(): void {
    this.disposed = true
    this.clear()
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.stateValue = 'reachable'
    this.failures = 0
    this.lastReason = ''
  }

  private arm(ms: number, fire: () => void): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      fire()
    }, ms)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** End of the window: one fresh probe must agree before the camera is called offline. */
  private confirm(): void {
    void this.runProbe((result) => {
      if (this.stateValue !== 'failing') return
      if (result === 'reachable') {
        this.noteReachable()
        return
      }
      this.stateValue = 'offline'
      this.offlineAt = Date.now()
      this.deps.onOffline({
        since: this.since,
        failures: this.failures,
        lastReason: this.lastReason,
      })
      this.arm(this.recoveryProbeMs, () => this.recover())
    })
  }

  private recover(): void {
    void this.runProbe((result) => {
      if (this.stateValue !== 'offline') return
      if (result === 'reachable') {
        this.noteReachable()
        return
      }
      this.arm(this.recoveryProbeMs, () => this.recover())
    })
  }

  private async runProbe(then: (result: ReachabilityProbeResult) => void): Promise<void> {
    if (this.probing || this.disposed) return
    this.probing = true
    let result: ReachabilityProbeResult
    try {
      result = await this.deps.probe()
    } catch {
      result = 'unreachable'
    } finally {
      this.probing = false
    }
    if (!this.disposed) then(result)
  }
}
