import type {
  ConsumableItem,
  consumablesCapability,
  InferRuntimeState,
  PetFeederStatus,
} from '@camstack/types'

/**
 * The feeder's `consumables` slice. Both items come from the feeder's OWN
 * sensors, never from a manual mark: the tank from `state.food` (and the
 * hoppers of a dual-hopper model), the desiccant from `state.desiccantLeftDays`.
 *
 * Low / normal transitions are not emitted here: the notification centre judges
 * every `supply` item's `status` of this slice, the way it does for a Dreame
 * tank, and raises the consumable-low / consumable-normal system events.
 */

export const FEEDER_CONSUMABLES_CAP = 'consumables'
export const FEEDER_TANK_KEY = 'foodTank'
export const FEEDER_DESICCANT_KEY = 'desiccant'

export type FeederConsumablesSlice = InferRuntimeState<typeof consumablesCapability>

/** Store seam — `BaseDevice.runtimeState`, or a fake. */
export interface FeederConsumablesStore {
  getCapState<T extends Record<string, unknown>>(capName: string): Readonly<T> | undefined
  setCapState(capName: string, value: Record<string, unknown>): void
}

/** The tank: its level is a coarse sensor code, so only its verdict is shown. */
function tankItem(status: PetFeederStatus): ConsumableItem {
  const verdict = status.foodLevel === null ? null : status.lowFood ? 'empty' : 'ok'
  return {
    key: FEEDER_TANK_KEY,
    label: 'Food in the tank',
    level: null,
    status: verdict,
    kind: 'supply',
    form: 'tank',
    lastResetAt: null,
    resettable: false,
  }
}

/** The desiccant: days left (already seconds in the slice); zero means replace it. */
function desiccantItem(remainingSeconds: number): ConsumableItem {
  return {
    key: FEEDER_DESICCANT_KEY,
    label: 'Desiccant',
    level: null,
    status: remainingSeconds <= 0 ? 'replace' : 'ok',
    kind: 'wear',
    form: 'part',
    lastResetAt: null,
    resettable: true,
    remaining: { value: Math.max(0, remainingSeconds), kind: 'duration' },
  }
}

/**
 * The consumables a feeder REPORTS. Presence-driven: nothing is invented for a
 * reading the model does not give, and a slice that has not been polled yet
 * (`lastFetchedAt` 0) yields no items — "the read said nothing" is not "none".
 */
export function buildFeederConsumableItems(status: PetFeederStatus): ConsumableItem[] {
  if (status.lastFetchedAt === 0) return []
  const items: ConsumableItem[] = []
  if (status.foodLevel !== null) items.push(tankItem(status))
  if (status.desiccantLeftDays !== null) items.push(desiccantItem(status.desiccantLeftDays))
  return items
}

function sameItem(a: ConsumableItem, b: ConsumableItem): boolean {
  return (
    a.key === b.key &&
    a.status === b.status &&
    a.level === b.level &&
    a.resettable === b.resettable &&
    a.remaining?.value === b.remaining?.value
  )
}

/**
 * The slice to write, or `null` for "write nothing": an empty list never
 * replaces a restored one, and an unchanged list only moves `lastFetchedAt`.
 */
export function nextFeederConsumablesSlice(
  prev: FeederConsumablesSlice | undefined,
  items: readonly ConsumableItem[],
  now: number,
): FeederConsumablesSlice | null {
  if (items.length === 0) return null
  const unchanged =
    prev !== undefined &&
    prev.items.length === items.length &&
    prev.items.every((item, i) => {
      const other = items[i]
      return other !== undefined && sameItem(item, other)
    })
  if (unchanged) return { ...prev, items: [...prev.items], lastFetchedAt: now }
  return { items: [...items], lastChangedAt: now, lastFetchedAt: now }
}

/** Derive the items from a freshly mapped status and write the slice if it moved. */
export function writeFeederConsumables(
  store: FeederConsumablesStore,
  status: PetFeederStatus,
  now: number,
): void {
  const prev = store.getCapState<FeederConsumablesSlice>(FEEDER_CONSUMABLES_CAP)
  const next = nextFeederConsumablesSlice(prev, buildFeederConsumableItems(status), now)
  if (next !== null) store.setCapState(FEEDER_CONSUMABLES_CAP, next)
}
