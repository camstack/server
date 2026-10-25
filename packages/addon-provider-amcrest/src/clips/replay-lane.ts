/**
 * ONE `/cam/playback` replay per camera at a time, held by the provider and
 * never learned from the wire.
 *
 * ## The fact this module owns, and the number that was wrong
 *
 * **The camera's replay refusal is `DESCRIBE 404`** — byte-identical to
 * `/totally/bogus/path`, and byte-identical to a clip the card has rolled
 * over. A provider that reported that 404 as "this clip is gone" would tell
 * the operator a clip which exists does not. That half is D611/D315 and it is
 * why this file exists.
 *
 * The *ceiling* is the part the earlier note got wrong, and it is worth
 * spelling out because it is what stops this being a constant. The
 * 2026-09-23 feasibility re-measurement recorded "exactly THREE slots, and the
 * fourth is a 404". Re-measured on 3836 the same day, with the hub's own live
 * main and sub streams running:
 *
 * | run | sessions granted | first refusal |
 * | --- | --- | --- |
 * | 10 asked | **9** | `DESCRIBE 404` on the 10th |
 * | 12 asked | **8** | `DESCRIBE 404` on the 9th |
 *
 * So the ceiling is neither three nor stable: it is a TOTAL session budget the
 * playbacks share with whatever else is dialling the camera, and the hub's own
 * live streams attach and detach with every detection session. A provider
 * cannot hold a number it does not own. Two of the granted sessions also
 * answered `PLAY 200` and then delivered **zero RTP in four seconds**, which
 * is the same branch as one that refuses, wearing a success code (D391).
 *
 * ## So the lane counts OUR replays, not the camera's
 *
 * One at a time, per device. That is what a viewer needs — a viewer plays one
 * clip — and it is the only number this addon can be the authority for. It
 * does two things:
 *
 * - a second ask never dials a camera we are already holding, so it cannot
 *   spend a slot that is scarce for reasons we cannot see;
 * - a `DESCRIBE 404` that arrives while this lane holds nothing else is
 *   reported as the CAMERA's refusal, by name, and never as an absence.
 *
 * ## A queue, with two different patiences
 *
 * Every ask that finds the camera held joins ONE FIFO queue per camera, and a
 * release hands the slot straight to the head of it — never to whoever asks
 * next. How long an ask may stay in it depends on what it is for:
 *
 * - a **still** waits its turn, however long that is. It used to wait two
 *   seconds and be refused `replay-busy`; the tile then came back on its own
 *   retry ladder, so a page of tiles turned into a chain of refusals and
 *   re-dials (2026-09-25, 3836: seventeen `replay-busy` in six hours). A
 *   queued still costs the camera nothing. The queue is BOUNDED
 *   ({@link REPLAY_LANE_MAX_PENDING} per camera — a page of tiles, not a
 *   scroll history) and an ask whose caller went away LEAVES it (`signal`),
 *   so nobody dials the camera for a tile that is no longer on a screen.
 * - a **playback** waits {@link REPLAY_LANE_WAIT_MS} and no longer, ahead of
 *   every queued still. The commonest overlap is one operator moving from clip
 *   A to clip B: the broker tears A down and dials B in the same breath, and a
 *   few hundred milliseconds covers it. Queueing behind a playback that is
 *   still PLAYING would mean waiting the whole length of somebody else's clip
 *   (this source arrives at ~1.1× realtime): that is not a lane, it is a
 *   hostage.
 */
import type { IScopedLogger } from '@camstack/types'

/**
 * How long a PLAYBACK may wait for a slot that is being released.
 *
 * A holder shutting down kills its ffmpeg and the camera's socket dies with
 * it; there is no teardown handshake to flush. Two seconds is an order of
 * magnitude over that and an order of magnitude under the shortest clip this
 * camera writes.
 */
export const REPLAY_LANE_WAIT_MS = 2_000

/**
 * How many asks may wait for one camera at once. A timeline page mounts 4–8
 * tiles (viewport + 320 px); anything past that is a refusal by name
 * (`queue-full`) rather than a queue that grows with every scroll.
 */
export const REPLAY_LANE_MAX_PENDING = 8

/**
 * What a lease was taken for. It travels into the refusal, so it is named.
 *
 * - `stream` — an operator is watching a clip. It is what the camera is FOR,
 *   it runs at realtime for the clip's whole length, and nothing preempts it.
 * - `still` — a thumbnail mint (`clip-still.ts`). SPECULATIVE: nobody asked
 *   for it by tapping, so a playback that arrives takes the slot from it AT
 *   ONCE, and goes ahead of every still already queued.
 *
 * The FILE path does not take a lease: it is HTTP (`RPC_Loadfile`), a
 * different surface of the camera with a different budget, and folding it in
 * here would refuse an export because a clip was playing.
 */
export type ReplayPurpose = 'stream' | 'still'

export interface ReplayLeaseHeld {
  readonly kind: 'held'
  /** Idempotent. Called only once the camera's socket is really gone. */
  release(): void
}

export interface ReplayLeaseBusy {
  readonly kind: 'busy'
  /** What is holding this camera's replay. */
  readonly holder: ReplayPurpose
  /** How long that holder has had it. */
  readonly heldForMs: number
  /** How long this ask waited before giving up. */
  readonly waitedMs: number
  /** The sentence a surface may show. */
  readonly detail: string
}

/** The caller went away (its `signal` aborted) before its turn came. */
export interface ReplayLeaseAbandoned {
  readonly kind: 'abandoned'
  /** How long it had waited. */
  readonly waitedMs: number
}

export type ReplayLease = ReplayLeaseHeld | ReplayLeaseBusy | ReplayLeaseAbandoned

export interface ReplayLane {
  /**
   * Take this camera's replay, wait in its queue, or say who has it.
   *
   * `onYield` is how a lease declares itself PREEMPTIBLE: it is called when
   * something that outranks this purpose asks for the slot, and the holder is
   * expected to close its socket and release. A lease that passes no `onYield`
   * simply cannot be preempted.
   *
   * `signal` is the caller's own lifetime: when it aborts while the ask is
   * still queued, the ask leaves the queue and answers `abandoned`.
   */
  acquire(
    deviceId: number,
    purpose: ReplayPurpose,
    onYield?: () => void,
    signal?: AbortSignal,
  ): Promise<ReplayLease>
  /** For a cheap question that must not wait (D54). */
  held(deviceId: number): boolean
}

export interface ReplayLaneDeps {
  readonly logger: IScopedLogger
  readonly now?: () => number
  /** How long a PLAYBACK may queue. A still has no such bound. */
  readonly waitMs?: number
  /** How many asks may queue per camera. */
  readonly maxPending?: number
}

interface Holding {
  readonly purpose: ReplayPurpose
  readonly sinceMs: number
  /** Set only by a preemptible holder. Called at most once. */
  readonly onYield?: () => void
}

/**
 * One queued ask. `grant` TAKES the slot on the waiter's behalf, synchronously,
 * before its promise resolves: between a release and the waiter's next
 * microtask the camera is already held, so no ask arriving in that gap can take
 * it too (two `/cam/playback` sessions on one camera is the thing this lane
 * exists to prevent).
 */
interface Waiter {
  readonly purpose: ReplayPurpose
  grant(): void
}

/**
 * May an ask for `asked` take the slot from a holder holding it for `holder`?
 *
 * ONE rule, in one place, and it is not symmetric: a playback outranks a
 * speculative mint and nothing outranks a playback. A mint does not preempt
 * another mint either — two tiles take turns rather than killing each other's
 * replay and leaving neither with a picture.
 */
export function replayPreempts(asked: ReplayPurpose, holder: ReplayPurpose): boolean {
  return asked === 'stream' && holder === 'still'
}

/** Where a new waiter goes: a playback ahead of every still, else the tail. */
function queuePosition(queue: readonly Waiter[], purpose: ReplayPurpose): number {
  if (purpose === 'still') return queue.length
  const firstStill = queue.findIndex((w) => w.purpose === 'still')
  return firstStill === -1 ? queue.length : firstStill
}

export function createReplayLane(deps: ReplayLaneDeps): ReplayLane {
  const now = deps.now ?? ((): number => Date.now())
  const waitMs = deps.waitMs ?? REPLAY_LANE_WAIT_MS
  const maxPending = deps.maxPending ?? REPLAY_LANE_MAX_PENDING
  const holding = new Map<number, Holding>()
  const queues = new Map<number, Waiter[]>()

  const leave = (deviceId: number, waiter: Waiter): void => {
    const queue = queues.get(deviceId)
    if (queue === undefined) return
    const index = queue.indexOf(waiter)
    if (index !== -1) queue.splice(index, 1)
    if (queue.length === 0) queues.delete(deviceId)
  }

  const take = (
    deviceId: number,
    purpose: ReplayPurpose,
    onYield?: () => void,
  ): ReplayLeaseHeld => {
    const entry: Holding = {
      purpose,
      sinceMs: now(),
      ...(onYield === undefined ? {} : { onYield }),
    }
    holding.set(deviceId, entry)
    let released = false
    return {
      kind: 'held',
      release: () => {
        if (released) return
        released = true
        if (holding.get(deviceId) !== entry) return
        holding.delete(deviceId)
        // HANDED to the head of the queue, not woken to race for it: a new
        // ask arriving between this release and the waiter's turn must not
        // jump a queue that has been waiting.
        const next = queues.get(deviceId)?.[0]
        if (next === undefined) return
        leave(deviceId, next)
        next.grant()
      },
    }
  }

  const refuse = (
    deviceId: number,
    purpose: ReplayPurpose,
    current: Holding,
    waitedMs: number,
    detail: string,
    branch: string,
  ): ReplayLeaseBusy => {
    const heldForMs = now() - current.sinceMs
    const extras = {
      tags: { deviceId },
      meta: { branch, asked: purpose, holder: current.purpose, heldForMs, waitedMs },
    }
    // A refusal we issue OURSELVES still gets a line (D391). A playback that
    // did not play is dropped work, warned; a still is deferred to its tile
    // and DEBUGs, as `clip-still-mint.ts` promises — a WARN per tile of a
    // page is noise, not evidence.
    if (purpose === 'stream') {
      deps.logger.warn('videoclips: a replay was refused — this node already holds one', extras)
    } else {
      deps.logger.debug('videoclips: a still was refused a place in the replay queue', extras)
    }
    return { kind: 'busy', holder: current.purpose, heldForMs, waitedMs, detail }
  }

  return {
    held: (deviceId) => holding.has(deviceId),
    acquire: async (deviceId, purpose, onYield, signal) => {
      const askedAt = now()
      if (signal?.aborted === true) return { kind: 'abandoned', waitedMs: 0 }
      const current = holding.get(deviceId)
      if (current === undefined) return take(deviceId, purpose, onYield)

      const queue = queues.get(deviceId) ?? []
      // The bound is on STILLS. A playback is never refused for a queue of
      // speculative work: it goes ahead of every still, and at most one
      // playback can be waiting (a second one times out behind it).
      if (purpose === 'still' && queue.length >= maxPending) {
        return refuse(
          deviceId,
          purpose,
          current,
          0,
          `queue-full: ${String(queue.length)} replays are already waiting for this camera ` +
            `(at most ${String(maxPending)}) — nothing about this clip; ask again once the ` +
            'queue drains',
          'replay-queue-full',
        )
      }

      type Outcome =
        | { readonly kind: 'granted'; readonly lease: ReplayLeaseHeld }
        | { readonly kind: 'timeout' }
        | { readonly kind: 'abandoned' }
      let settle: (value: Outcome) => void = () => undefined
      const settled = new Promise<Outcome>((resolve) => {
        settle = resolve
      })
      let timer: ReturnType<typeof setTimeout> | null = null
      let done = false
      const finish = (value: Outcome): void => {
        if (done) return
        done = true
        if (timer !== null) clearTimeout(timer)
        timer = null
        signal?.removeEventListener('abort', onAbort)
        settle(value)
      }
      const waiter: Waiter = {
        purpose,
        grant: () => {
          finish({ kind: 'granted', lease: take(deviceId, purpose, onYield) })
        },
      }
      const onAbort = (): void => {
        leave(deviceId, waiter)
        finish({ kind: 'abandoned' })
      }
      // QUEUED FIRST, then the holder is asked to yield: a holder that releases
      // synchronously inside `onYield` must hand the slot to THIS ask.
      queue.splice(queuePosition(queue, purpose), 0, waiter)
      queues.set(deviceId, queue)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (purpose === 'stream') {
        timer = setTimeout(() => {
          timer = null
          leave(deviceId, waiter)
          finish({ kind: 'timeout' })
        }, waitMs)
      }

      if (replayPreempts(purpose, current.purpose) && current.onYield !== undefined) {
        // AT ONCE: the holder is speculative and this ask is not.
        deps.logger.debug('videoclips: a speculative replay was asked to give the slot back', {
          tags: { deviceId },
          meta: { branch: 'replay-yield', asked: purpose, holder: current.purpose },
        })
        current.onYield()
      }

      const outcome = await settled
      const waitedMs = now() - askedAt
      if (outcome.kind === 'granted') return outcome.lease
      if (outcome.kind === 'abandoned') return { kind: 'abandoned', waitedMs }
      const after = holding.get(deviceId) ?? current
      return refuse(
        deviceId,
        purpose,
        after,
        waitedMs,
        `replay-busy: this camera is already serving a clip ${after.purpose} for this node, ` +
          `held for ${String(now() - after.sinceMs)} ms — nothing about this clip, and nothing a ` +
          'retry against the camera would change',
        'replay-busy',
      )
    },
  }
}
