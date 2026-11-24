import { BATTERY_LOW_PERCENT } from '../../shell/model'

/** What the card needs of one child device; `battery` is null when unknown. */
export interface ContainerCardChild {
  readonly online: boolean
  readonly battery: number | null
}

export interface ContainerCounts {
  readonly total: number
  readonly online: number
  readonly offline: number
  readonly lowBattery: number
}

/** The children split into online / offline / low battery. An unknown level is never low. */
export function containerCountsOf(children: readonly ContainerCardChild[]): ContainerCounts {
  const online = children.filter((c) => c.online).length
  return {
    total: children.length,
    online,
    offline: children.length - online,
    lowBattery: children.filter((c) => c.battery !== null && c.battery < BATTERY_LOW_PERCENT)
      .length,
  }
}
