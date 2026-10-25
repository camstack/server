import {
  DEFAULT_NATIVE_LEASE_SETTINGS,
  type IScopedLogger,
  type NativeLeaseSettingsOverride,
} from '@camstack/types'

/**
 * A held slot in the node's live-decode-worker budget. Released exactly once,
 * when the session that holds it stops.
 */
export interface LiveWorkerLease {
  readonly release: () => void
}

/**
 * A start's place in the queue of starts the ceiling refused (D652).
 *
 * ONE per start, taken on its first refusal and kept until the start is over,
 * so its FIFO position is fixed at the first park: a start woken and refused
 * again (something else took the slot first), or retried by its fallback
 * timer, re-parks at the SAME place — never at the back. Every `wait` is
 * answered by at most one wake, and a woken start is out of the queue until it
 * parks again.
 */
export interface SlotWaiter {
  /** Park: `listener` fires once, when a returned slot is handed to THIS start. */
  wait(listener: () => void): void
  /** Leave the queue without a wake (the fallback timer fired). The place is kept. */
  cancel(): void
  /**
   * The start is over — admitted, or torn down. Leaves the queue and clears
   * the camera's refused memory, so its next refusal is a WARN again (D391): a
   * camera refused and torn down before it ever got a slot used to stay
   * "already warned" forever. `unusedWake`: the start was woken and torn down
   * before it could ask, so the slot it was handed is passed to the next parked
   * start instead of dying with it.
   */
  leave(unusedWake: boolean): void
}

/** One parked start, as the queue keys it: the place is the `seq`. */
interface ParkedStartKey {
  readonly seq: number
  readonly deviceId: number
}

/**
 * Default ceiling on decode workers alive at once, on ONE node.
 *
 * ## Why this is an admission decision and not a queue
 *
 * The runner already has a spawn gate (`maxConcurrentDecodeSpawns`), and it is
 * a RATE limit, not a concurrency limit: its permit is released when the worker
 * delivers its FIRST FRAME, not when the session ends. That is the right
 * behaviour for what it does — it stops a synchronized motion burst from
 * stampeding the shared iGPU with simultaneous cold starts — and it is the
 * reason nothing bounded the number of workers ALIVE. Measured on the live hub:
 * 1 → 8 workers and a ~4 GiB move in 8 seconds. That swing, not the average, is
 * what a host with no swap dies on.
 *
 * Queuing is the wrong shape here. A cold start clears in seconds, so queuing a
 * SPAWN is nearly free. A live decode session lasts as long as the motion does,
 * so queuing a SESSION means an unbounded wait followed by decoding footage of a
 * moment that has already passed — and the queue itself is another unbounded
 * structure. So a session that does not fit is REFUSED, loudly, per camera.
 *
 * A refusal is temporary and self-healing: `startGuardedSessionDecode` already
 * owns a retry ladder (2s → 5s → 15s → 30s, then 30s forever) for "no source
 * yet", and a refused session re-asks on exactly that ladder. The camera comes
 * back on its own as soon as a slot frees; nothing has to re-attach it.
 *
 * ## Why 8
 *
 * A decode worker measures ~320 MB RSS (after `nativeLeaseHoldFrames` was
 * restored to its default of 8 on 2026-08-17; it was ~1 GB before that). The
 * live peak observed on this cluster is 8 concurrent workers, i.e. ~2.5 GiB.
 * The default therefore makes the peak that has ALREADY happened the guaranteed
 * worst case rather than a coincidence of how many cameras saw motion together:
 * nothing that runs today starts being refused, and 9 workers can no longer
 * happen by accident. Operators with more RAM raise it per node.
 */
export const DEFAULT_MAX_LIVE_DECODE_WORKERS = 8

/**
 * Worst-case RSS of ONE decode worker, in MB — the number the ceiling above was
 * missing.
 *
 * ## Why the count alone was never a RAM bound
 *
 * The docblock above sized 8 workers at "~2.5 GiB" from a ~320 MB worker. Two
 * other figures for the same quantity already lived beside it: this module's
 * spec header records "1 -> 8 workers and ~4 GiB" (~500 MB each), and
 * `native-lease-store.ts` records that on a 4K camera the LEASE BUDGET binds
 * first at `leaseMb:1020, leaseFrames:43`. Measured on the live hub 2026-08-25,
 * sampled every 5 s: a worker reaches its plateau in under ten seconds
 * (314 MB @4 s -> 649 MB @9 s -> 651 MB steady; another 410 MB @3 s -> 823-859 MB)
 * and its floor at spawn is already 314-410 MB.
 *
 * So the real worst case is not a constant somebody measured once — it is
 * what the lease store can HOLD plus the tile and scene stores plus the
 * baseline, and every term but the last is an OPERATOR KNOB. Charging the
 * budget knob alone was the second mistake: the store is built with
 * `maxFrames: holdFrames`, so at the shipped defaults 8 × 4K RGB24 (~200 MB)
 * binds long before 1024 MB does. From 2026-08-28, when `budgetMb` went back
 * from the operator's 512 to the shipped 1024, that charge put every node's
 * ceiling at `floor(8192 / 1438) = 5`, and the Mac agent — carrying most of
 * the fleet at `detectWeight` 70 — refused 7,595 decodes in a day while its
 * workers measured `leaseMb` p50 24, max 190 (`leaseFrames` max 8: the COUNT
 * bound, never the budget). Raising `budgetMb` in the UI still silently
 * authorises more RAM once the frame count stops binding, which is the point.
 *
 * A count cannot express a RAM bound while the per-unit cost is itself
 * configurable. So the ceiling is DERIVED (see `LiveDecodeWorkerAdmission.ceiling`)
 * and {@link DEFAULT_MAX_LIVE_DECODE_WORKERS} degrades to an upper clamp.
 */
export const DECODE_WORKER_BASELINE_MB = 350

/**
 * The largest frame a held slot can cost: 4K RGB24, 3840 × 2160 × 3 bytes
 * = 24.9 MB. Measured twice — `leaseMb:1020 / leaseFrames:43` on the hub
 * (`native-lease-store.ts`) and `190 / 8` on the Mac agent, both 23.7 —
 * and rounded up. Admission does not know a source's resolution, and does
 * not need to: this is the ceiling any camera can reach.
 */
export const MAX_HELD_FRAME_MB = 25

/**
 * RAM this node lets live decode workers commit, in MB.
 *
 * ## Why 8192, and why 6144 was wrong
 *
 * 6144 shipped first, derived from the SHIPPED lease defaults (1024 + 64 + 350
 * = 1438 MB per worker) and a 13-minute concurrency sample. Both inputs were
 * wrong for the cluster it ran on, in opposite directions:
 *
 *  - the operator here runs `budgetMb: 512`, so a worker is worst-cased at
 *    **926 MB**, not 1438 — the old count of 8 was authorising 7.4 GiB, not the
 *    11.5 GiB the defaults implied;
 *  - the sample missed the peak. Measured across the change: at ceiling 8 the
 *    cluster refused 4 sessions in 30 minutes; at the ceiling 6144 derived
 *    (6 workers at 926 MB) it refused **43 in 10 minutes**, and the hub — which
 *    had never refused once — began refusing too. Demand genuinely reaches 8.
 *
 * A refusal is self-healing but it is not free: the retry ladder means the
 * camera decodes a motion window that has moved on. Trading real coverage for a
 * RAM headroom nobody measured a need for is the wrong side of the trade.
 *
 * 8192 restores exactly the concurrency this cluster had (`floor(8192/926) = 8`)
 * while keeping what the change was actually for: the bound is RAM, so raising
 * `budgetMb` back to the shipped 1024 now DROPS the ceiling to 5 instead of
 * silently authorising 11.5 GiB, and the refusal line names the megabytes.
 */
export const DEFAULT_NODE_DECODE_BUDGET_MB = 8192

/**
 * Worst-case RAM one decode worker may commit, from the lease knobs actually in
 * force. The SINGLE place the operator-facing budgets become the number the
 * ceiling is derived from — computing it anywhere else is exactly how the count
 * and the budget drifted apart.
 *
 * `override` carries only the knobs the operator SET (see
 * `native-lease-config.ts` on why "unset" includes a knob sitting at its
 * default); anything absent falls back to what the worker ships with.
 */
/**
 * How many frames of one camera the runner may have in inference at once:
 * the worker's hold minus one, never below one. The hold evicts oldest-first
 * when a newer marked frame lands, so the (hold)th outstanding ref is the one
 * that makes the first unreadable. See `runner.ts` `maxInflightPerCamera`.
 */
export function maxInflightPerCamera(override: NativeLeaseSettingsOverride): number {
  const holdFrames = override.holdFrames ?? DEFAULT_NATIVE_LEASE_SETTINGS.holdFrames
  return Math.max(1, holdFrames - 1)
}

export function decodeWorkerFootprintMb(override: NativeLeaseSettingsOverride): number {
  const budgetMb = override.budgetMb ?? DEFAULT_NATIVE_LEASE_SETTINGS.budgetMb
  const holdFrames = override.holdFrames ?? DEFAULT_NATIVE_LEASE_SETTINGS.holdFrames
  const tileBudgetMb = override.tileBudgetMb ?? DEFAULT_NATIVE_LEASE_SETTINGS.tileBudgetMb
  const sceneBudgetMb = override.sceneBudgetMb ?? DEFAULT_NATIVE_LEASE_SETTINGS.sceneBudgetMb
  // The lease store stops at `holdFrames` slots OR `budgetMb`, whichever comes
  // first — so the pixels it can hold are the smaller of the two.
  const heldPixelsMb = Math.min(budgetMb, holdFrames * MAX_HELD_FRAME_MB)
  return heldPixelsMb + tileBudgetMb + sceneBudgetMb + DECODE_WORKER_BASELINE_MB
}

export interface LiveDecodeWorkerAdmissionOptions {
  readonly limit: number
  readonly logger: IScopedLogger
  /**
   * RAM this node lets live decode workers commit, in MB. Omit to keep the
   * pure-count behaviour — the ceiling is then `limit`, unchanged.
   */
  readonly nodeBudgetMb?: number
  /**
   * Worst-case RSS of one worker, in MB — normally
   * {@link decodeWorkerFootprintMb} of the lease knobs in force. Omit together with
   * `nodeBudgetMb`; supplying one without the other derives nothing.
   */
  readonly workerFootprintMb?: number
}

/**
 * The node's live-decode-worker budget.
 *
 * One instance per runner addon. Not a semaphore: a semaphore's contract is
 * "wait", and waiting is the thing this deliberately does not do — see
 * {@link DEFAULT_MAX_LIVE_DECODE_WORKERS}.
 */
export class LiveDecodeWorkerAdmission {
  private limit: number
  private readonly logger: IScopedLogger
  private live = 0
  /**
   * Starts the ceiling refused, waiting to be told a slot came back — FIFO by
   * the start's FIRST park (D652): the key's `seq` is fixed when the start
   * takes its {@link SlotWaiter}, so a re-park keeps the place.
   */
  private readonly parked = new Map<ParkedStartKey, () => void>()
  private nextSeq = 0
  /**
   * Cameras currently refused. The refusal WARN fires on the transition into
   * this set, not on every retry: a start woken or retried while the node is
   * still full says so at debug (D652 — a wake must not become a WARN storm).
   * Cleared on admit AND when a parked start leaves (`SlotWaiter.leave`): a
   * camera torn down while refused must be news again next time (D391).
   */
  private readonly refusedDevices = new Set<number>()
  private nodeBudgetMb: number | undefined
  private workerFootprintMb: number | undefined

  constructor(options: LiveDecodeWorkerAdmissionOptions) {
    this.limit = Math.max(1, options.limit)
    this.logger = options.logger
    this.nodeBudgetMb = positiveOrUndefined(options.nodeBudgetMb)
    this.workerFootprintMb = positiveOrUndefined(options.workerFootprintMb)
  }

  /** Starts parked on a {@link SlotWaiter} right now — diagnostics and tests. */
  get slotWaiters(): number {
    return this.parked.size
  }

  /**
   * This start's place in the queue. A refused start waits on it instead of a
   * fixed timer, so a slot freed by a draining worker's exit is taken at once
   * (D652). Take it once per start, on the first refusal; keep it to the end.
   */
  slotWaiter(deviceId: number): SlotWaiter {
    const key: ParkedStartKey = { seq: this.nextSeq, deviceId }
    this.nextSeq += 1
    return {
      wait: (listener) => {
        this.parked.set(key, listener)
      },
      cancel: () => {
        this.parked.delete(key)
      },
      leave: (unusedWake) => {
        this.parked.delete(key)
        this.refusedDevices.delete(deviceId)
        // The slot handed to this start is still free: someone parked must
        // hear about it, or every other start waits out its full timer.
        if (unusedWake) this.wakeNext()
      },
    }
  }

  /**
   * ONE slot, ONE wake: the longest-parked start (lowest `seq`). Waking all N
   * produced N−1 refusals per freed slot. The woken start leaves the queue; if
   * something else took the slot first it parks again, at the same place.
   */
  private wakeNext(): void {
    let first: ParkedStartKey | undefined
    for (const key of this.parked.keys()) {
      if (first === undefined || key.seq < first.seq) first = key
    }
    if (first === undefined) return
    const wake = this.parked.get(first)
    this.parked.delete(first)
    wake?.()
  }

  /** Workers currently holding a slot. */
  get inFlight(): number {
    return this.live
  }

  /**
   * The ceiling actually in force: the RAM budget divided by one worker\'s worst
   * case, clamped by the hand-set count.
   *
   * Never zero. A node too small for even one worker still decodes one camera —
   * refusing every camera turns a memory bound into a total outage, and one
   * worker is the smallest unit of "this node does its job at all".
   */
  get ceiling(): number {
    const fromBudget = this.budgetDerivedCeiling()
    return fromBudget === undefined ? this.limit : Math.max(1, Math.min(this.limit, fromBudget))
  }

  /** MB currently committed by the workers holding a slot. */
  get committedMb(): number | undefined {
    return this.workerFootprintMb === undefined ? undefined : this.live * this.workerFootprintMb
  }

  private budgetDerivedCeiling(): number | undefined {
    if (this.nodeBudgetMb === undefined || this.workerFootprintMb === undefined) return undefined
    return Math.floor(this.nodeBudgetMb / this.workerFootprintMb)
  }

  /**
   * Apply a changed per-worker footprint — the operator moved `budgetMb` or
   * `tileBudgetMb`. Like {@link resize} this never kills a running session; it
   * only changes what the next admission is measured against.
   */
  resizeFootprint(workerFootprintMb: number): void {
    this.workerFootprintMb = positiveOrUndefined(workerFootprintMb)
  }

  /** Apply a changed node decode budget. */
  resizeBudget(nodeBudgetMb: number): void {
    this.nodeBudgetMb = positiveOrUndefined(nodeBudgetMb)
  }

  /**
   * Apply an operator-changed ceiling.
   *
   * Lowering it never kills a running session — a decode worker torn down
   * mid-motion loses the event it was started for. It only stops the next
   * admission, so the count drains to the new ceiling as sessions end.
   */
  resize(limit: number): void {
    this.limit = Math.max(1, limit)
  }

  /**
   * Take a slot, or refuse.
   *
   * A refusal is a WARN and carries `tags.deviceId`, because the only useful
   * form of this question is per-camera ("why did 102 not run when 101 did?").
   * A branch that drops work silently reads as "it never happened".
   */
  admit(deviceId: number, label: string): LiveWorkerLease | null {
    const ceiling = this.ceiling
    if (this.live >= ceiling) {
      const firstRefusal = !this.refusedDevices.has(deviceId)
      this.refusedDevices.add(deviceId)
      const log = firstRefusal ? this.logger.warn : this.logger.debug
      log.call(
        this.logger,
        'session-decode: REFUSED — node live decode-worker ceiling reached, will retry',
        {
          tags: { deviceId },
          meta: {
            label,
            live: this.live,
            ceiling,
            // The RAM is the reason. A bare count cannot be argued with when an
            // operator asks why 102 was refused while 101 ran.
            ...(this.committedMb === undefined
              ? {}
              : {
                  committedMb: this.committedMb,
                  budgetMb: this.nodeBudgetMb,
                  workerFootprintMb: this.workerFootprintMb,
                }),
          },
        },
      )
      return null
    }
    this.live += 1
    // Admitted: the camera left the refused state; its next refusal is news.
    this.refusedDevices.delete(deviceId)
    this.logger.debug('session-decode: live decode-worker slot taken', {
      tags: { deviceId },
      meta: { label, live: this.live, ceiling: this.ceiling },
    })
    let released = false
    return {
      release: (): void => {
        // Idempotent: teardown can run twice (detach racing a pump error), and
        // a double release would inflate the budget until nothing is refused.
        if (released) return
        released = true
        this.live -= 1
        this.wakeNext()
      },
    }
  }
}

/** A knob that is absent, zero or nonsense derives nothing rather than a bound nobody chose. */
function positiveOrUndefined(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  return Number.isFinite(value) && value > 0 ? value : undefined
}
