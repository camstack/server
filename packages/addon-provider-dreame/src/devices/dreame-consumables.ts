/**
 * The `consumables` slice as both Dreame devices write it, and the one
 * refresher that re-reads it.
 *
 * - A slice is written only when something changed: an item (lastChangedAt), or
 *   a refresh that LANDED (lastFetchedAt, which the cap declares volatile).
 * - An empty list is never written. "The read said nothing" is not "this device
 *   has no consumables" — and the slice is `restored` across restarts (D642),
 *   so an empty write would erase the last real observation.
 * - A refresh never overlaps itself, and a failed one changes nothing (D49): the
 *   last good values stay, and the failure is logged with the device tag.
 */

import {
  type ConsumableItem,
  consumablesCapability,
  errMsg,
  type InferRuntimeState,
  type IScopedLogger,
} from '@dominevo/types'
import { isDue } from './dreame-state-refresh.js'

export const CONSUMABLES_CAP_NAME = 'consumables'

export type ConsumablesSlice = InferRuntimeState<typeof consumablesCapability>

export const CONSUMABLES_COLD_START: ConsumablesSlice = {
  items: [],
  lastChangedAt: 0,
  lastFetchedAt: 0,
}

/** The slice store — `BaseDevice.runtimeState`, or a fake. */
export interface ConsumablesSliceStore {
  getCapState<T extends Record<string, unknown>>(capName: string): Readonly<T> | undefined
  setCapState(capName: string, value: Record<string, unknown>): void
}

function itemEqual(a: ConsumableItem, b: ConsumableItem): boolean {
  return (
    a.key === b.key &&
    a.label === b.label &&
    a.level === b.level &&
    a.status === b.status &&
    a.lastResetAt === b.lastResetAt &&
    a.resettable === b.resettable &&
    a.kind === b.kind &&
    a.remaining?.value === b.remaining?.value &&
    a.remaining?.kind === b.remaining?.kind
  )
}

function itemsEqual(a: readonly ConsumableItem[], b: readonly ConsumableItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, i) => {
      const other = b[i]
      return other !== undefined && itemEqual(item, other)
    })
  )
}

/**
 * The slice to write, or `null` for "write nothing".
 *
 * `landed` = these items come from a refresh that just answered (not from a
 * replay of the cache on a push), so `lastFetchedAt` may move.
 */
export function nextConsumablesSlice(
  prev: ConsumablesSlice | undefined,
  items: readonly ConsumableItem[],
  now: number,
  landed: boolean,
): ConsumablesSlice | null {
  if (items.length === 0) return null
  if (prev !== undefined && itemsEqual(prev.items, items)) {
    return landed ? { ...prev, items: [...prev.items], lastFetchedAt: now } : null
  }
  return {
    items: [...items],
    lastChangedAt: now,
    lastFetchedAt: landed ? now : (prev?.lastFetchedAt ?? 0),
  }
}

/** Write {@link nextConsumablesSlice}'s answer, if it has one. */
export function writeConsumables(
  store: ConsumablesSliceStore,
  items: readonly ConsumableItem[],
  now: number,
  landed: boolean,
): void {
  const prev = store.getCapState<ConsumablesSlice>(CONSUMABLES_CAP_NAME)
  const next = nextConsumablesSlice(prev, items, now, landed)
  if (next !== null) store.setCapState(CONSUMABLES_CAP_NAME, next)
}

/** Seed the cold start ONLY when nothing was restored — never wipe the last reading. */
export function seedConsumablesColdStart(store: ConsumablesSliceStore): void {
  if (store.getCapState<ConsumablesSlice>(CONSUMABLES_CAP_NAME) === undefined) {
    store.setCapState(CONSUMABLES_CAP_NAME, CONSUMABLES_COLD_START)
  }
}

/** One consumable a device reports, as far as a reset cares. */
export interface ResettableConsumable<K extends string> {
  readonly key: K
  readonly resettable: boolean
}

/**
 * Narrow a cap-supplied reset key to one THIS device reports and can reset.
 * A real key of another model (e.g. `mop-pad` on a robot without one) would
 * otherwise send a reset action to a service the robot lacks.
 */
export function resolveResettableKey<K extends string>(
  key: string,
  present: readonly ResettableConsumable<K>[],
): K {
  const hit = present.find((c) => c.key === key)
  if (hit === undefined) {
    throw new Error(`this device does not report "${key}"`)
  }
  if (!hit.resettable) {
    throw new Error(`"${key}" has no reset action on this device`)
  }
  return hit.key
}

/** Why a refresh ran — logged, so a missing refresh can be told from a failed one. */
export type ConsumablesRefreshReason =
  | 'activate'
  | 'interval'
  | 'docked'
  | 'charging'
  | 'reset'
  | 'reset-follow-up'

export interface ConsumablesRefresherDeps {
  readonly deviceId: number
  readonly logger: IScopedLogger
  /** Log prefix, e.g. `dreame vacuum`. */
  readonly subject: string
  /**
   * Read the device and write the slice. Throws when nothing was learned.
   * `live()` turns false on `stop()`: re-check it before every write, and after
   * every wait, so a read that outlives its device changes nothing.
   */
  readonly read: (reason: ConsumablesRefreshReason, live: () => boolean) => Promise<void>
  /** Periodic cadence; omit for none. */
  readonly intervalMs?: number
  /** Delay of {@link DreameConsumablesRefresher.scheduleFollowUp}. */
  readonly followUpMs?: number
}

const DEFAULT_FOLLOW_UP_MS = 60_000

export class DreameConsumablesRefresher {
  readonly #deps: ConsumablesRefresherDeps
  #lastReadAt = 0
  #followUp: ReturnType<typeof setTimeout> | null = null
  #running: Promise<boolean> | null = null
  /** At most ONE run waits behind the one in flight. */
  #queued: ConsumablesRefreshReason | null = null
  #stopped = false

  constructor(deps: ConsumablesRefresherDeps) {
    this.#deps = deps
  }

  /** False once stopped — the device is gone, nothing may be written for it. */
  readonly live = (): boolean => !this.#stopped

  /** Mark the refresher live (the caller triggers the first read itself). */
  start(): void {
    this.#stopped = false
  }

  stop(): void {
    this.#stopped = true
    if (this.#followUp !== null) clearTimeout(this.#followUp)
    this.#followUp = null
    this.#queued = null
  }

  /**
   * The core's state refresh calls this on ITS schedule (D1062): re-read only
   * when the last read is older than `intervalMs`, so a slow source is not read
   * at the pace of a fast one.
   */
  triggerIfDue(now: number): Promise<boolean> {
    const { intervalMs } = this.#deps
    if (intervalMs === undefined || !isDue(this.#lastReadAt, intervalMs, now)) {
      return Promise.resolve(false)
    }
    return this.trigger('interval')
  }

  /**
   * Re-read now. Resolves `true` when the read landed. A trigger while one is in
   * flight does not start a second read: it queues one more run after it
   * (coalesced) and shares its promise.
   */
  trigger(reason: ConsumablesRefreshReason): Promise<boolean> {
    if (this.#stopped) return Promise.resolve(false)
    if (this.#running !== null) {
      this.#queued = reason
      return this.#running
    }
    const run = this.#drain(reason).finally(() => {
      this.#running = null
    })
    this.#running = run
    return run
  }

  /** One re-read after `followUpMs`; a second call replaces the first. */
  scheduleFollowUp(reason: ConsumablesRefreshReason): void {
    if (this.#stopped) return
    if (this.#followUp !== null) clearTimeout(this.#followUp)
    this.#followUp = setTimeout(() => {
      // not-a-state-poll: one delayed re-read after a reset, armed by that command
      this.#followUp = null
      if (!this.#stopped) void this.trigger(reason)
    }, this.#deps.followUpMs ?? DEFAULT_FOLLOW_UP_MS)
  }

  async #drain(first: ConsumablesRefreshReason): Promise<boolean> {
    let landed = await this.#once(first)
    while (this.#queued !== null && !this.#stopped) {
      const next = this.#queued
      this.#queued = null
      landed = await this.#once(next)
    }
    return landed
  }

  async #once(reason: ConsumablesRefreshReason): Promise<boolean> {
    const { deviceId, logger, subject, read } = this.#deps
    try {
      await read(reason, this.live)
      this.#lastReadAt = Date.now()
      // A read that outlived its device learned nothing worth a line.
      if (this.#stopped) return false
      logger.debug(`${subject}: consumables refreshed`, {
        tags: { deviceId },
        meta: { reason },
      })
      return true
    } catch (err) {
      if (this.#stopped) return false
      logger.warn(`${subject}: consumables refresh failed — keeping the last values`, {
        tags: { deviceId },
        meta: { reason, error: errMsg(err) },
      })
      return false
    }
  }
}
