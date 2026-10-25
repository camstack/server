/**
 * Apple Foundation Models availability on THIS node, as a mirrored slice.
 *
 * The read (`current`) never waits on a probe: it answers what the mirror
 * holds and, when that is stale, starts ONE background refresh (the D224
 * serve-and-revalidate posture). A read never joins a refresh in flight.
 *
 * Four states, never a boolean (D315). What is KNOWN without asking the helper
 * is answered without spawning it: not a Mac, or a Darwin kernel older than
 * macOS 26. A probe that did not answer is `unknown` — a failed measurement is
 * never "unavailable" (D393), and never "available" either.
 */
import {
  type AppleFmAvailability,
  AppleFmAvailabilitySchema,
  type IScopedLogger,
} from '@camstack/types'
import type { HelperOutcome, HelperRequestOptions } from './afm-helper.js'
import { type AfmProbeRequest, AfmProbeReplySchema } from './afm-protocol.js'

/** Darwin 25 is macOS 26 (Tahoe), the first release with the framework. */
const MIN_DARWIN_MAJOR = 25
const DEFAULT_PROBE_TIMEOUT_MS = 10_000
const DEFAULT_REVALIDATE_MS = 60_000
const DEFAULT_NOT_READY_BACKOFF = { initialMs: 30_000, maxMs: 600_000 } as const

export interface AvailabilityHelper {
  request(payload: AfmProbeRequest, opts: HelperRequestOptions): Promise<HelperOutcome>
}

export interface NotReadyBackoff {
  readonly initialMs: number
  readonly maxMs: number
}

export interface AppleFmAvailabilityDeps {
  readonly platform: string
  /** `process.arch`. Apple Intelligence needs Apple silicon; the helper is arm64 only. */
  readonly arch: string
  /** `os.release()` — the Darwin kernel version. */
  readonly osRelease: string
  readonly helper: AvailabilityHelper
  readonly logger: IScopedLogger
  readonly probeTimeoutMs?: number
  readonly revalidateMs?: number
  readonly notReadyBackoff?: NotReadyBackoff
  readonly now?: () => number
}

function stateKey(a: AppleFmAvailability): string {
  return a.state === 'unavailable' ? `unavailable:${a.reason}` : a.state
}

export class AppleFmAvailabilityMirror {
  private slice: AppleFmAvailability = { state: 'unknown', error: 'not probed yet' }
  private fetchedAt: number | null = null
  private inFlight = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private bootTimer: ReturnType<typeof setTimeout> | null = null
  private nextNotReadyDelay: number
  private readonly now: () => number
  private readonly backoff: NotReadyBackoff

  constructor(private readonly deps: AppleFmAvailabilityDeps) {
    this.now = deps.now ?? Date.now
    this.backoff = deps.notReadyBackoff ?? DEFAULT_NOT_READY_BACKOFF
    this.nextNotReadyDelay = this.backoff.initialMs
  }

  /** The slice; a stale one also starts a background refresh. */
  current(): AppleFmAvailability {
    const known = this.staticAbsence()
    if (known !== null) return known
    const stale =
      this.fetchedAt === null ||
      this.now() - this.fetchedAt >= (this.deps.revalidateMs ?? DEFAULT_REVALIDATE_MS)
    if (stale && !this.inFlight) void this.refresh()
    return this.slice
  }

  /** Probe now. The boot path and the backoff use it; a read never awaits it. */
  async refresh(): Promise<AppleFmAvailability> {
    const known = this.staticAbsence()
    if (known !== null) return known
    this.inFlight = true
    try {
      const outcome = await this.deps.helper.request(
        { op: 'probe' },
        { timeoutMs: this.deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS },
      )
      this.apply(this.interpret(outcome))
    } finally {
      this.inFlight = false
    }
    return this.slice
  }

  /** First probe after the node settled; never on the boot path itself. */
  start(delayMs: number): void {
    if (this.staticAbsence() !== null) return
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null
      void this.refresh()
    }, delayMs)
    this.bootTimer.unref?.()
  }

  dispose(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    if (this.bootTimer !== null) clearTimeout(this.bootTimer)
    this.retryTimer = null
    this.bootTimer = null
  }

  /** What is known WITHOUT the helper: not a Mac, or a macOS older than 26. */
  staticAbsence(): AppleFmAvailability | null {
    if (this.deps.platform !== 'darwin') {
      return { state: 'unsupported-platform', platform: this.deps.platform }
    }
    if (this.deps.arch !== 'arm64') {
      // An Intel Mac: the arm64 helper cannot even start there, and it would be
      // crash-counted into `helperCrashed` — the wrong sentence for "no".
      return { state: 'unsupported-platform', platform: `darwin/${this.deps.arch}` }
    }
    const major = Number.parseInt(this.deps.osRelease.split('.')[0] ?? '', 10)
    if (Number.isFinite(major) && major < MIN_DARWIN_MAJOR) {
      return {
        state: 'unavailable',
        reason: 'osTooOld',
        osVersion: null,
        detail: `Darwin ${this.deps.osRelease} predates macOS 26, the first release with Foundation Models`,
      }
    }
    return null
  }

  private interpret(outcome: HelperOutcome): AppleFmAvailability {
    switch (outcome.kind) {
      case 'reply': {
        const parsed = AfmProbeReplySchema.safeParse(outcome.reply)
        if (parsed.success) return parsed.data.availability
        return { state: 'unknown', error: 'the helper answered a probe this addon cannot read' }
      }
      case 'unavailable':
        return {
          state: 'unavailable',
          reason: outcome.reason,
          osVersion: null,
          detail: outcome.detail,
        }
      case 'timeout':
        return {
          state: 'unknown',
          error: `the probe did not answer within ${String(this.deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)} ms`,
        }
      case 'crashed':
        return { state: 'unknown', error: `the helper exited during the probe: ${outcome.detail}` }
      case 'cancelled':
      case 'busy':
        return { state: 'unknown', error: `the probe was not run (${outcome.kind})` }
    }
  }

  private apply(next: AppleFmAvailability): void {
    // Validated on the way in, so a slice never holds a shape the cap refuses.
    const checked = AppleFmAvailabilitySchema.parse(next)
    const from = stateKey(this.slice)
    const to = stateKey(checked)
    if (from !== to) {
      this.deps.logger.info('apple foundation models availability changed', {
        meta: {
          from,
          to,
          ...(checked.state === 'unavailable' ? { detail: checked.detail } : {}),
          ...(checked.state === 'unknown' ? { error: checked.error } : {}),
          ...(checked.state === 'available'
            ? { osVersion: checked.osVersion, contextSize: checked.contextSize }
            : {}),
        },
      })
    }
    this.slice = checked
    this.fetchedAt = this.now()
    this.scheduleNotReadyRetry(checked)
  }

  /** `modelNotReady` is transient (a download): look again, less often each time. */
  private scheduleNotReadyRetry(a: AppleFmAvailability): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (a.state !== 'unavailable' || a.reason !== 'modelNotReady') {
      this.nextNotReadyDelay = this.backoff.initialMs
      return
    }
    const delay = this.nextNotReadyDelay
    this.nextNotReadyDelay = Math.min(this.backoff.maxMs, delay * 2)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.refresh()
    }, delay)
    this.retryTimer.unref?.()
  }
}
