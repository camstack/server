/**
 * The provider's OWN CoverPreview lane — two queues, one in flight per host.
 *
 * The library already serialises CoverPreview: one in flight per api instance,
 * a 50-deep FIFO that throws past that, and a process-wide host-keyed backoff
 * that doubles on a 400. What a FIFO cannot express is PRIORITY, and the two
 * kinds of mint this feature has are not equal — an operator staring at a tile
 * must not wait behind twenty prefetches for clips nobody opened.
 *
 * So the provider keeps two queues of its own, hands the library at most ONE
 * CoverPreview per host at a time, drains `interactive` before `prefetch`, and
 * re-checks between every prefetch mint (D549 16).
 *
 * ## Two things it refuses to do
 *
 * **Wait when the queue is full.** A request past the bound is REFUSED with
 * `queue-full`, so the route can answer 204 with a reason. A request held open
 * behind forty-nine others is a spinner the operator cannot cancel, and the
 * camera will have rolled the clip over before it is served.
 *
 * **Let a prefetch probe a sulking host.** While a host's 400 backoff is open
 * a prefetch is skipped entirely; only an interactive request may probe it,
 * because only an interactive request has somebody waiting for the answer.
 *
 * The backoff mirrors the library's (1 s doubling to 30 s) rather than
 * replacing it: this one decides whether to ASK at all, the library's decides
 * how long to wait once asked.
 */

import { ThumbQueueRefusedError } from './clip-still-refusal.js'

/** How long one waiting mint is worth, as a retry hint. Coarse on purpose:
 *  the client floors it with its own backoff and caps its own attempts, so a
 *  wrong hint can neither cause a hammer nor a hang. */
export const THUMB_DRAIN_HINT_PER_WAITER_MS = 1_000

/** How many mints may be waiting per host before a request is refused. */
export const THUMB_QUEUE_CAPACITY = 16

export const THUMB_BACKOFF_INITIAL_MS = 1_000
export const THUMB_BACKOFF_MAX_MS = 30_000

export type ThumbLane = 'interactive' | 'prefetch'

export interface ThumbJob {
  readonly host: string
  readonly lane: ThumbLane
  run(): Promise<Buffer>
}

export interface ClipThumbQueueDeps {
  readonly now?: () => number
}

interface Waiting {
  readonly lane: ThumbLane
  readonly job: ThumbJob
  readonly resolve: (value: Buffer) => void
  readonly reject: (err: Error) => void
}

interface HostState {
  readonly waiting: Waiting[]
  running: boolean
  backoffUntilMs: number
  backoffMs: number
}

/**
 * A camera REFUSAL — the only failure that earns a host a backoff. A decode
 * failure is ours, not the camera's, and punishing the host for it would stop
 * minting for every clip on that hub.
 */
function isCameraRefusal(message: string): boolean {
  return /rejected/i.test(message) && /(responseCode|resp_code)\s*=?\s*400/i.test(message)
}

export class ClipThumbQueue {
  private readonly hosts = new Map<string, HostState>()
  private readonly now: () => number

  constructor(deps: ClipThumbQueueDeps = {}) {
    this.now = deps.now ?? (() => Date.now())
  }

  backoffOpen(host: string): boolean {
    const state = this.hosts.get(host)
    return state !== undefined && state.backoffUntilMs > this.now()
  }

  /**
   * Is this host busy with, or owed, operator-facing work?
   *
   * The periodic catalog refresh asks before it spends the host's one lane:
   * an operator staring at a tile must never wait behind a timer, and a host
   * whose 400 backoff is open must not be probed by anything that has nobody
   * waiting for the answer — the same rule that already keeps a PREFETCH off
   * a sulking host.
   *
   * Either a mint is in flight or the host is sulking. There is deliberately
   * no third clause for "an interactive request is queued": a queued request
   * means a mint is running, so `running` already covers it, and a clause
   * that can never be the reason for the answer is a leftover that reads as
   * verification. The lane is one per host, so a PREFETCH holding it defers
   * the refresh too — which is right: the refresh is the lowest-priority
   * thing on this host.
   */
  busy(host: string): boolean {
    const state = this.hosts.get(host)
    if (state === undefined) return false
    return state.backoffUntilMs > this.now() || state.running
  }

  backoffUntil(host: string): number {
    return this.hosts.get(host)?.backoffUntilMs ?? 0
  }

  private stateFor(host: string): HostState {
    const existing = this.hosts.get(host)
    if (existing !== undefined) return existing
    const made: HostState = { waiting: [], running: false, backoffUntilMs: 0, backoffMs: 0 }
    this.hosts.set(host, made)
    return made
  }

  /**
   * Queue a mint. Rejects — rather than waits — when the lane is full or when
   * a prefetch meets an open backoff; both refusals are named so the route can
   * put the reason on the 204.
   */
  async submit(job: ThumbJob): Promise<Buffer> {
    const state = this.stateFor(job.host)

    if (job.lane === 'prefetch' && state.backoffUntilMs > this.now()) {
      throw new ThumbQueueRefusedError(
        'camera-backoff',
        `camera-backoff: host ${job.host} refused a CoverPreview recently; prefetch skipped until ` +
          `the backoff closes (only an interactive request probes it)`,
        state.backoffUntilMs - this.now(),
      )
    }
    if (state.waiting.length >= THUMB_QUEUE_CAPACITY) {
      throw new ThumbQueueRefusedError(
        'queue-full',
        `queue-full: ${state.waiting.length} thumbnail mints already waiting for host ${job.host}`,
        state.waiting.length * THUMB_DRAIN_HINT_PER_WAITER_MS,
      )
    }

    return new Promise<Buffer>((resolve, reject) => {
      state.waiting.push({ lane: job.lane, job, resolve, reject })
      void this.drain(job.host)
    })
  }

  private async drain(host: string): Promise<void> {
    const state = this.stateFor(host)
    if (state.running) return
    // Interactive first, then prefetch, each FIFO within its lane.
    const index = state.waiting.findIndex((w) => w.lane === 'interactive')
    const pick = index === -1 ? 0 : index
    const next = state.waiting[pick]
    if (next === undefined) return
    state.waiting.splice(pick, 1)

    // Re-check the backoff BETWEEN jobs: a prefetch queued before a refusal
    // must not run after it.
    if (next.lane === 'prefetch' && state.backoffUntilMs > this.now()) {
      next.reject(
        new ThumbQueueRefusedError(
          'camera-backoff',
          `camera-backoff: host ${host} is backing off; prefetch skipped`,
          state.backoffUntilMs - this.now(),
        ),
      )
      void this.drain(host)
      return
    }

    state.running = true
    try {
      const bytes = await next.job.run()
      state.backoffUntilMs = 0
      state.backoffMs = 0
      next.resolve(bytes)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      if (isCameraRefusal(message)) {
        state.backoffMs =
          state.backoffMs === 0
            ? THUMB_BACKOFF_INITIAL_MS
            : Math.min(state.backoffMs * 2, THUMB_BACKOFF_MAX_MS)
        state.backoffUntilMs = this.now() + state.backoffMs
      }
      next.reject(err instanceof Error ? err : new Error(message))
    } finally {
      state.running = false
      void this.drain(host)
    }
  }
}
