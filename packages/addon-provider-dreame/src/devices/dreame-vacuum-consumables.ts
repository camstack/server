/**
 * The vacuum's `consumables` slice: when it is re-read, and what a reset does.
 *
 * The life %s and their time-left twins are settings the robot rarely re-pushes
 * over MQTT, and the library does not poll them. So they are re-read from the
 * cloud SHADOW (no robot wake) on activate, every {@link CONSUMABLES_REFRESH_MS},
 * and on the edge INTO `docked` — the moment a run has just used them up. The
 * same read reseeds the station tank-status props (dirty water, dust bag, …),
 * which otherwise arrive only as pushes.
 *
 * The tank-status props are re-read on their own, much more often
 * ({@link TANK_REREAD_MS}, live first and the shadow as fallback, those few props
 * only) and at once on every lifecycle state transition: a refilled clean-water
 * tank otherwise read "low" for hours.
 *
 * A reset goes through the library, which re-reads the item it reset (live,
 * else shadow) before it resolves; the slice is rebuilt from that. A shadow
 * answer may still be the pre-reset value, so it earns ONE follow-up refresh.
 *
 * The TANKS ride the same slice (D915): every push hands over the tank items
 * the device decoded, appended after the wear items. Either half may be
 * unknown for a while after a restart — the shadow has not answered, or a
 * refresh lands before the first push brought the tanks — and the slice is
 * `restored`, so an unknown half keeps the restored rows instead of erasing
 * them.
 */

/** A tank item (`supply` / `waste`) as opposed to a wear item. */
function isTankItem(item: ConsumableItem): boolean {
  return consumableKindOf(item) !== 'wear'
}

import type { ConsumableResetResult, VacuumDevice as DreameVacuum } from '@apocaliss92/nodedreame'
import {
  type ConsumableItem,
  consumableKindOf,
  errMsg,
  type IScopedLogger,
  type VacuumState,
} from '@camstack/types'
import { buildVacuumConsumableItems, VACUUM_TANK_PROPS } from '../dreame-vacuum-decode.js'
import {
  CONSUMABLES_CAP_NAME,
  type ConsumablesRefreshReason,
  type ConsumablesSlice,
  type ConsumablesSliceStore,
  DreameConsumablesRefresher,
  resolveResettableKey,
  writeConsumables,
} from './dreame-consumables.js'

/** Hourly: a consumable moves by hours of cleaning, and the dock edge covers a run. */
export const CONSUMABLES_REFRESH_MS = 60 * 60_000
/**
 * How often the few tank-status props are re-read on their own. The robot rarely
 * pushes a refill, and the hourly consumables read left a "low" tank showing for
 * hours; six props every few minutes is cheap next to that.
 */
export const TANK_REREAD_MS = 3 * 60_000
/** A burst of station state hops (washing, drying, docked) re-reads the tanks once. */
export const TANK_TRANSITION_MIN_GAP_MS = 20_000
/** Time for the robot to report a reset to the cloud before the shadow is re-read. */
export const RESET_FOLLOW_UP_MS = 90_000

/** What this controller needs of the library's vacuum. */
export type VacuumConsumablesHandle = Pick<
  DreameVacuum,
  | 'supportedConsumables'
  | 'refreshConsumables'
  | 'resetConsumable'
  | 'refreshCachedProperties'
  | 'refreshProperties'
>

export interface VacuumConsumablesDeps {
  readonly deviceId: number
  readonly logger: IScopedLogger
  readonly store: ConsumablesSliceStore
  readonly resolveVacuum: () => VacuumConsumablesHandle | null
  readonly now?: () => number
}

const SUBJECT = 'dreame vacuum'

/** The states a run ends from. `drying` is already on the dock. */
const DOCK_EDGE_FROM: ReadonlySet<VacuumState> = new Set<VacuumState>([
  'cleaning',
  'returning',
  'paused',
])

export class DreameVacuumConsumables {
  readonly #deps: VacuumConsumablesDeps
  readonly #refresher: DreameConsumablesRefresher
  /** Last pushed lifecycle state; `null` until the first push after boot. */
  #prevState: VacuumState | null = null
  /** Last pushed tank items; `null` until the first push after boot. */
  #tanks: readonly ConsumableItem[] | null = null
  #tankTimer: ReturnType<typeof setInterval> | null = null
  #tankRead: Promise<void> | null = null
  #lastTankReadAt = 0

  constructor(deps: VacuumConsumablesDeps) {
    this.#deps = deps
    this.#refresher = new DreameConsumablesRefresher({
      deviceId: deps.deviceId,
      logger: deps.logger,
      subject: SUBJECT,
      read: (reason, live) => this.#read(reason, live),
      intervalMs: CONSUMABLES_REFRESH_MS,
      followUpMs: RESET_FOLLOW_UP_MS,
    })
  }

  start(): void {
    this.#refresher.start()
    void this.#refresher.trigger('activate')
    if (this.#tankTimer === null) {
      this.#tankTimer = setInterval(() => void this.#rereadTanks('interval'), TANK_REREAD_MS)
    }
  }

  stop(): void {
    this.#refresher.stop()
    if (this.#tankTimer !== null) clearInterval(this.#tankTimer)
    this.#tankTimer = null
  }

  /**
   * Every `stateChanged` push: replay the cache and the pushed tanks into the
   * slice (written only if an item changed) and refresh on the edge into
   * `docked`. The first push after boot is not an edge — activation already
   * reads — and neither is a hop between station routines (`drying` →
   * `docked`): only the end of a RUN is.
   */
  onPush(state: VacuumState, tanks: readonly ConsumableItem[]): void {
    this.#tanks = tanks
    this.#apply(false)
    const enteredDock =
      this.#prevState !== null && DOCK_EDGE_FROM.has(this.#prevState) && state === 'docked'
    const transitioned = this.#prevState !== null && this.#prevState !== state
    this.#prevState = state
    if (enteredDock) void this.#refresher.trigger('docked')
    if (transitioned) void this.#rereadTanks('state-transition')
  }

  /**
   * Re-read ONLY the tank-status props: live first (the robot answers while it is
   * on the dock), the cloud shadow when it does not. The answer reaches the slice
   * through the library's change events, i.e. {@link onPush}. Transition-driven
   * reads inside {@link TANK_TRANSITION_MIN_GAP_MS} of the last one are skipped,
   * and a read already in flight is shared, not doubled.
   */
  async #rereadTanks(reason: 'interval' | 'state-transition'): Promise<void> {
    const { deviceId, logger, resolveVacuum } = this.#deps
    if (!this.#refresher.live()) return
    if (this.#tankRead !== null) {
      logger.debug(`${SUBJECT}: tank-status re-read already running — shared`, {
        tags: { deviceId },
        meta: { reason },
      })
      return
    }
    if (
      reason === 'state-transition' &&
      Date.now() - this.#lastTankReadAt < TANK_TRANSITION_MIN_GAP_MS
    ) {
      logger.debug(`${SUBJECT}: tank-status re-read skipped — one just ran`, {
        tags: { deviceId },
        meta: { reason },
      })
      return
    }
    const vacuum = resolveVacuum()
    if (vacuum === null) {
      logger.debug(`${SUBJECT}: tank-status re-read skipped — no vacuum handle`, {
        tags: { deviceId },
        meta: { reason },
      })
      return
    }
    const props = Object.values(VACUUM_TANK_PROPS).map((p) => ({ ...p }))
    this.#lastTankReadAt = Date.now()
    this.#tankRead = (async () => {
      try {
        await vacuum.refreshProperties(props)
      } catch (liveErr) {
        logger.debug(`${SUBJECT}: tank-status live read failed — trying the cloud shadow`, {
          tags: { deviceId },
          meta: { reason, error: errMsg(liveErr) },
        })
        try {
          await vacuum.refreshCachedProperties(props)
        } catch (err) {
          if (!this.#refresher.live()) return
          logger.warn(`${SUBJECT}: tank-status re-read failed — keeping the last values`, {
            tags: { deviceId },
            meta: { reason, error: errMsg(err) },
          })
        }
      }
    })().finally(() => {
      this.#tankRead = null
    })
    await this.#tankRead
  }

  async reset(key: string): Promise<void> {
    const { deviceId, logger, resolveVacuum } = this.#deps
    const vacuum = resolveVacuum()
    if (vacuum === null) {
      throw new Error(`${SUBJECT}: handle unavailable (device=${deviceId})`)
    }
    const known = resolveResettableKey(key, vacuum.supportedConsumables)
    const result = await vacuum.resetConsumable(known)
    // A device removed meanwhile: #apply writes nothing, scheduleFollowUp arms nothing.
    // The library has already reseeded the cache from its re-read.
    this.#apply(result.refreshedFrom !== null)
    logger.info(`${SUBJECT}: consumable reset`, {
      tags: { deviceId },
      meta: resetMeta(result),
    })
    if (result.refreshedFrom === 'device') return
    if (result.refreshedFrom === null) {
      logger.warn(`${SUBJECT}: consumable reset, but its values could not be re-read`, {
        tags: { deviceId },
        meta: resetMeta(result),
      })
    }
    this.#refresher.scheduleFollowUp('reset-follow-up')
  }

  async #read(reason: ConsumablesRefreshReason, live: () => boolean): Promise<void> {
    const { deviceId, logger, resolveVacuum } = this.#deps
    const vacuum = resolveVacuum()
    if (vacuum === null) throw new Error('vacuum handle unavailable')
    await vacuum.refreshConsumables()
    if (!live()) return
    if (vacuum.supportedConsumables.length === 0) {
      throw new Error('the shadow reported no consumable')
    }
    this.#apply(true)
    // Tanks ride the same cadence; a failure there costs the tanks, not the consumables.
    try {
      await vacuum.refreshCachedProperties(Object.values(VACUUM_TANK_PROPS).map((p) => ({ ...p })))
    } catch (err) {
      if (!live()) return
      logger.warn(`${SUBJECT}: tank-status refresh failed — keeping the last values`, {
        tags: { deviceId },
        meta: { reason, error: errMsg(err) },
      })
    }
  }

  #apply(landed: boolean): void {
    if (!this.#refresher.live()) return
    const { store, resolveVacuum, now } = this.#deps
    const vacuum = resolveVacuum()
    if (vacuum === null) return
    const prev = store.getCapState<ConsumablesSlice>(CONSUMABLES_CAP_NAME)?.items ?? []
    const read = buildVacuumConsumableItems(vacuum.supportedConsumables)
    // The shadow has not answered yet: keep the restored wear items.
    const wear = read.length > 0 ? read : prev.filter((item) => !isTankItem(item))
    // No push has brought the tanks yet: keep the restored ones.
    const tanks = this.#tanks ?? prev.filter(isTankItem)
    writeConsumables(store, [...wear, ...tanks], (now ?? Date.now)(), landed)
  }
}

function resetMeta(result: ConsumableResetResult): Record<string, unknown> {
  return {
    key: result.key,
    refreshedFrom: result.refreshedFrom,
    leftPct: result.leftPct,
    timeLeft: result.timeLeft,
    ...(result.refreshError !== null ? { refreshError: result.refreshError.message } : {}),
  }
}
