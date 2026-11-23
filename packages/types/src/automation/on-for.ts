/**
 * "On for N" — a command step that turns a device on and takes it back off
 * after a while (D1086 amendment, D1092).
 *
 * A `command` step carries `onFor: { seconds }`. The step does not wait: it
 * hands the device to {@link OnForHolds}, which lives in the block OUTSIDE any
 * run, so the run mode, a restart of the run and the end of the run do not
 * touch the timer.
 *
 * The rules:
 *  - the device is read at the event. Off: it is turned on and a hold is
 *    taken. On, with no hold: nothing is sent and nothing is taken — what was
 *    on before stays on after;
 *  - a new event while a hold runs moves its deadline (and turns the device
 *    back on if it went off meanwhile);
 *  - at the deadline the device is turned off, only because the hold is ours;
 *  - a report that the device went off ends the hold: the operator switched it;
 *  - a state that cannot be read changes nothing (D49).
 *
 * The holds are persisted through `persist` (the hub's runs ledger row of the
 * block) with their deadline — BEFORE the device is turned on, and rolled back
 * when the send fails —  and given back to {@link OnForHolds.restore} when
 * the block starts: a deadline that passed while the block was down is honoured
 * at once.
 */
import { z } from 'zod'

/** The longest a device is held on: one day. */
export const ON_FOR_MAX_SECONDS = 86_400

export const OnForSpecSchema = z.object({
  seconds: z.number().int().min(1).max(ON_FOR_MAX_SECONDS),
})
export type OnForSpec = z.infer<typeof OnForSpecSchema>

/** One device this block turned on and owes an off. */
export const OnForHoldSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  cap: z.string().min(1),
  /** When the device is turned off (ms epoch). */
  deadline: z.number(),
})
export type OnForHold = z.infer<typeof OnForHoldSchema>

/** How many devices one block holds on at once. */
export const ON_FOR_HOLDS_MAX = 64
export const OnForHoldsSchema = z.array(OnForHoldSchema).max(ON_FOR_HOLDS_MAX)

/** What "on for" needs to know about an `on` action: where its state is and how to undo it. */
export interface OnForAction {
  readonly cap: string
  /** The boolean field of the cap's state that says the device is on. */
  readonly fieldPath: string
  readonly offActionId: string
}

const ON_FOR_ACTIONS: Readonly<Record<string, OnForAction>> = {
  'switch.on': { cap: 'switch', fieldPath: 'on', offActionId: 'switch.off' },
}

/** The way back of an `on` action, or null when the action cannot be held. */
export function onForActionOf(actionId: string): OnForAction | null {
  return ON_FOR_ACTIONS[actionId] ?? null
}

function onForActionOfCap(cap: string): OnForAction | null {
  return Object.values(ON_FOR_ACTIONS).find((a) => a.cap === cap) ?? null
}

export type OnForOutcome =
  | 'turned-on'
  | 'extended'
  | 'already-on'
  | 'unknown'
  | 'not-holdable'
  | 'failed'

export interface OnForTimers<H> {
  readonly set: (fn: () => void, ms: number) => H
  readonly clear: (handle: H) => void
  readonly now: () => number
}

export interface OnForDeps<H> {
  readonly timers: OnForTimers<H>
  /** Is the device on NOW? null when the read failed. */
  readonly readOn: (deviceId: number, action: OnForAction) => Promise<boolean | null>
  readonly send: (deviceId: number, actionId: string) => Promise<void>
  /** The whole list, every time it changes. A rejection is reported through `onError`; the hold is still kept in memory. */
  readonly persist: (holds: readonly OnForHold[]) => Promise<void>
  /** A send or a persist that failed, for the log (it carries the device). */
  readonly onError?: (deviceId: number, what: string, err: unknown) => void
  /**
   * The most seconds this device may be held on (`switchRunLimitOf`), or null when
   * it cannot be told. A hold above it - asked now or already stored - is cut to it.
   */
  readonly limitSecondsOf?: (deviceId: number) => Promise<number | null>
  /** The limit of a device could not be told (fail-open): the hold stays as asked, and this says so. */
  readonly onLimitUnknown?: (deviceId: number) => void
  /** A hold cut to the device's limit: what was asked for, and what it was cut to (ms). */
  readonly onClamped?: (deviceId: number, askedMs: number, limitMs: number) => void
  /** A hold given up without its off having been sent. */
  readonly onDropped?: (hold: OnForHold, reason: string) => void
}

/** How long after a failed off the next try is made, and how many are made. */
export const ON_FOR_RETRY_MS = 60_000
export const ON_FOR_RETRY_MAX = 5

interface Entry<H> {
  hold: OnForHold
  handle: H | undefined
  /** A report said "on" since we turned it on: an "off" after that is the operator's. */
  seenOn: boolean
  retries: number
}

export class OnForHolds<H> {
  private readonly entries = new Map<number, Entry<H>>()
  private disposed = false
  private work: Promise<void> = Promise.resolve()

  constructor(private readonly deps: OnForDeps<H>) {}

  list(): readonly OnForHold[] {
    return [...this.entries.values()].map((e) => e.hold)
  }

  /** Resolves when every expiry started so far has finished. */
  idle(): Promise<void> {
    return this.work
  }

  /** The holds the ledger kept: each is armed for what is left of it. */
  restore(holds: readonly OnForHold[]): void {
    for (const hold of holds) {
      if (onForActionOfCap(hold.cap) === null) continue
      // a hold taken since the block started is newer than the stored one
      if (this.entries.has(hold.deviceId)) continue
      // a hold that survived a restart was on long enough for its report to have been seen
      const entry: Entry<H> = { hold, handle: undefined, seenOn: true, retries: 0 }
      this.entries.set(hold.deviceId, entry)
      this.arm(entry)
      this.clampStored(entry)
    }
  }

  /** A stored hold over the device's limit (saved before the limit existed) is cut to it. */
  private clampStored(entry: Entry<H>): void {
    const limitOf = this.deps.limitSecondsOf
    if (limitOf === undefined) return
    const deviceId = entry.hold.deviceId
    this.work = this.work
      .then(async () => {
        const limit = await limitOf(deviceId).catch(() => null)
        if (limit === null) this.deps.onLimitUnknown?.(deviceId)
        if (limit === null || this.disposed || this.entries.get(deviceId) !== entry) return
        const now = this.deps.timers.now()
        const left = entry.hold.deadline - now
        if (left <= limit * 1000) return
        this.deps.onClamped?.(deviceId, left, limit * 1000)
        entry.hold = { ...entry.hold, deadline: now + limit * 1000 }
        this.arm(entry)
        await this.changed(deviceId)
      })
      .catch(() => undefined)
  }

  /** `ms` cut to what the device may be held on for. */
  private async clamp(deviceId: number, ms: number): Promise<number> {
    const limitOf = this.deps.limitSecondsOf
    if (limitOf === undefined) return ms
    const limit = await limitOf(deviceId).catch(() => null)
    if (limit === null) this.deps.onLimitUnknown?.(deviceId)
    if (limit === null || ms <= limit * 1000) return ms
    this.deps.onClamped?.(deviceId, ms, limit * 1000)
    return limit * 1000
  }

  /** The step ran for `deviceId`. Events are taken one at a time, so two cannot both find it off. */
  trigger(deviceId: number, actionId: string, ms: number): Promise<OnForOutcome> {
    const run = this.work.then(() => this.take(deviceId, actionId, ms))
    this.work = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async take(deviceId: number, actionId: string, ms: number): Promise<OnForOutcome> {
    const action = onForActionOf(actionId)
    if (action === null) return 'not-holdable'
    const on = await this.deps.readOn(deviceId, action)
    if (this.disposed) return 'unknown'
    const held = await this.clamp(deviceId, ms)
    if (this.disposed) return 'unknown'
    const deadline = this.deps.timers.now() + held
    const existing = this.entries.get(deviceId)
    if (existing !== undefined) {
      const back = on === false
      if (back) {
        // the deadline only moves with a successful send: a failure keeps the old one and its timer
        try {
          await this.deps.send(deviceId, actionId)
        } catch (err: unknown) {
          this.fail(deviceId, 'could not turn the device back on', err)
          return 'failed'
        }
        if (this.disposed || this.entries.get(deviceId) !== existing) return 'unknown'
        existing.seenOn = false
      }
      existing.hold = { ...existing.hold, deadline }
      existing.retries = 0
      this.arm(existing)
      await this.changed(deviceId)
      return back ? 'turned-on' : 'extended'
    }
    if (on === null) return 'unknown'
    if (on) return 'already-on'
    // the hold is durable BEFORE the device is touched: a crash between the two must not leave it on with no hold
    const entry: Entry<H> = {
      hold: { deviceId, cap: action.cap, deadline },
      handle: undefined,
      seenOn: false,
      retries: 0,
    }
    this.entries.set(deviceId, entry)
    await this.changed(deviceId)
    try {
      await this.deps.send(deviceId, actionId)
    } catch (err: unknown) {
      this.release(entry)
      await this.changed(deviceId)
      this.fail(deviceId, 'could not turn the device on', err)
      return 'failed'
    }
    if (this.disposed || this.entries.get(deviceId) !== entry) return 'turned-on'
    this.arm(entry)
    return 'turned-on'
  }

  /** The device reported its state. */
  observe(deviceId: number, cap: string, on: boolean): void {
    const entry = this.entries.get(deviceId)
    if (entry === undefined || entry.hold.cap !== cap) return
    if (on) {
      entry.seenOn = true
      return
    }
    if (!entry.seenOn) return
    this.release(entry)
    void this.changed(deviceId)
  }

  /** Stop the timers. What was persisted stays: the next start picks it up. */
  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) this.disarm(entry)
  }

  private disarm(entry: Entry<H>): void {
    if (entry.handle !== undefined) this.deps.timers.clear(entry.handle)
    entry.handle = undefined
  }

  private arm(entry: Entry<H>, after?: number): void {
    this.disarm(entry)
    const ms = after ?? Math.max(0, entry.hold.deadline - this.deps.timers.now())
    entry.handle = this.deps.timers.set(() => {
      entry.handle = undefined
      this.work = this.work.then(() => this.expire(entry)).catch(() => undefined)
    }, ms)
  }

  private release(entry: Entry<H>): void {
    this.disarm(entry)
    if (this.entries.get(entry.hold.deviceId) === entry) this.entries.delete(entry.hold.deviceId)
  }

  private async changed(deviceId?: number): Promise<void> {
    if (this.disposed) return
    try {
      await this.deps.persist(this.list())
    } catch (err: unknown) {
      this.fail(deviceId ?? -1, 'could not store the holds', err)
    }
  }

  private fail(deviceId: number, what: string, err: unknown): void {
    this.deps.onError?.(deviceId, what, err)
  }

  private async expire(entry: Entry<H>): Promise<void> {
    if (this.disposed || this.entries.get(entry.hold.deviceId) !== entry) return
    // a new event moved the deadline while this expiry waited its turn
    if (entry.hold.deadline > this.deps.timers.now() && entry.retries === 0) {
      this.arm(entry)
      return
    }
    const action = onForActionOfCap(entry.hold.cap)
    if (action === null) {
      this.release(entry)
      void this.changed(entry.hold.deviceId)
      return
    }
    const on = await this.deps.readOn(entry.hold.deviceId, action)
    if (this.disposed || this.entries.get(entry.hold.deviceId) !== entry) return
    if (on !== false) {
      try {
        await this.deps.send(entry.hold.deviceId, action.offActionId)
      } catch {
        if (this.disposed) return
        entry.retries += 1
        if (entry.retries > ON_FOR_RETRY_MAX) {
          this.release(entry)
          void this.changed(entry.hold.deviceId)
          this.deps.onDropped?.(entry.hold, 'the device could not be turned off')
          return
        }
        this.arm(entry, ON_FOR_RETRY_MS)
        return
      }
    }
    this.release(entry)
    void this.changed(entry.hold.deviceId)
  }
}
