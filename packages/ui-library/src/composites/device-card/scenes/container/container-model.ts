import { BATTERY_LOW_PERCENT } from '../../shell/model'

/**
 * What is known of one child's battery: its level, `none` (the read answered
 * and the device keeps no level), or `unknown` (not read yet, the read failed,
 * or the child is past the read bound).
 */
export type ChildBattery = number | 'none' | 'unknown'

/** What the card needs of one child device. */
export interface ContainerCardChild {
  readonly online: boolean
  readonly battery: ChildBattery
}

export interface ContainerCounts {
  readonly total: number
  readonly online: number
  readonly offline: number
  /** `null` while any child's level is unknown: a count of what was read would pass for the whole. */
  readonly lowBattery: number | null
}

/** The children split into online / offline / low battery; low battery is unknown (null) while any level is. */
export function containerCountsOf(children: readonly ContainerCardChild[]): ContainerCounts {
  const online = children.filter((c) => c.online).length
  return {
    total: children.length,
    online,
    offline: children.length - online,
    lowBattery: children.some((c) => c.battery === 'unknown')
      ? null
      : children.filter((c) => typeof c.battery === 'number' && c.battery < BATTERY_LOW_PERCENT)
          .length,
  }
}
