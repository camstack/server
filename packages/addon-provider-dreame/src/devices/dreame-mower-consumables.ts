/**
 * The mower's `consumables` slice (blade / brush / maintenance).
 *
 * The CMS counters are not cached MIoT props: they are read by a LIVE custom
 * action that answers only while the mower is awake — the instant it docks and
 * starts charging. A sleeping mower never answers, so there is no periodic
 * read: the triggers are activation (in case it is awake), the edge into
 * charging, and a reset.
 *
 * The slice is `restored` across restarts (D642), so the last reading is what
 * the panel shows while the mower sleeps. Nothing here may overwrite it with an
 * empty list: a failed, empty or missing answer is "nothing learned".
 */
import {
  MowerChargingStatus,
  type MowerDevice as DreameMower,
  MowerStatus,
} from '@apocaliss92/nodedreame'
import type { IScopedLogger } from '@camstack/types'
import { buildMowerConsumables, isMowerConsumableKey } from '../dreame-mower-decode.js'
import {
  type ConsumablesRefreshReason,
  type ConsumablesSliceStore,
  DreameConsumablesRefresher,
  seedConsumablesColdStart,
  writeConsumables,
} from './dreame-consumables.js'

/** Retries to ride the brief wake window when the mower transitions to charging. */
const CONSUMABLES_WAKE_RETRIES = 2
/** Spacing between wake-window retries. */
const CONSUMABLES_RETRY_DELAY_MS = 1_500

/** What this controller needs of the library's mower. */
export type MowerConsumablesHandle = Pick<DreameMower, 'getConsumables' | 'resetConsumable'>

export interface MowerConsumablesDeps {
  readonly deviceId: number
  readonly logger: IScopedLogger
  readonly store: ConsumablesSliceStore
  readonly resolveMower: () => MowerConsumablesHandle | null
  readonly now?: () => number
  readonly retries?: number
  readonly retryDelayMs?: number
}

const SUBJECT = 'dreame mower'

export class DreameMowerConsumables {
  readonly #deps: MowerConsumablesDeps
  readonly #refresher: DreameConsumablesRefresher

  constructor(deps: MowerConsumablesDeps) {
    this.#deps = deps
    this.#refresher = new DreameConsumablesRefresher({
      deviceId: deps.deviceId,
      logger: deps.logger,
      subject: SUBJECT,
      read: (_reason, live) => this.#read(live),
    })
  }

  /** Cold start only when nothing was restored. */
  seed(): void {
    seedConsumablesColdStart(this.#deps.store)
  }

  refresh(reason: ConsumablesRefreshReason): Promise<boolean> {
    return this.#refresher.trigger(reason)
  }

  stop(): void {
    this.#refresher.stop()
  }

  /** Reset one counter, then re-read it; a failed re-read is logged by the refresher. */
  async reset(key: string): Promise<void> {
    const { deviceId, resolveMower } = this.#deps
    if (!isMowerConsumableKey(key)) {
      throw new Error(`${SUBJECT}: this device does not report "${key}" (device=${deviceId})`)
    }
    const mower = resolveMower()
    if (mower === null) throw new Error(`${SUBJECT}: handle unavailable (device=${deviceId})`)
    await mower.resetConsumable(key)
    await this.#refresher.trigger('reset')
  }

  async #read(live: () => boolean): Promise<void> {
    const { resolveMower, store, now } = this.#deps
    const retries = this.#deps.retries ?? CONSUMABLES_WAKE_RETRIES
    const delayMs = this.#deps.retryDelayMs ?? CONSUMABLES_RETRY_DELAY_MS
    let lastError: unknown = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      // Stopped while asleep between tries: no more CMS calls for a gone device.
      if (!live()) return
      const mower = resolveMower()
      if (mower === null) throw new Error('mower handle unavailable')
      try {
        const readings = await mower.getConsumables()
        if (!live()) return
        const items = readings === null ? [] : buildMowerConsumables(readings)
        if (items.length === 0) {
          lastError = new Error('the CMS action returned no reading')
          continue
        }
        writeConsumables(store, items, (now ?? Date.now)(), true)
        return
      } catch (err) {
        lastError = err
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
}

/**
 * The edge INTO the awake-and-charging window — `status == Charging` OR
 * `chargingStatus == Charging`, either marks it (mirrors the donor
 * integration). The first observation after boot is not an edge: activation
 * already reads, and a mower found charging would otherwise be read twice.
 */
export class MowerChargingEdge {
  #observed = false
  #prevStatus: MowerStatus | null = null
  #prevCharging: MowerChargingStatus | null = null

  observe(status: MowerStatus | null, charging: MowerChargingStatus | null): boolean {
    const edge =
      this.#observed &&
      ((status === MowerStatus.Charging && this.#prevStatus !== MowerStatus.Charging) ||
        (charging === MowerChargingStatus.Charging &&
          this.#prevCharging !== MowerChargingStatus.Charging))
    this.#observed = true
    this.#prevStatus = status
    this.#prevCharging = charging
    return edge
  }
}
