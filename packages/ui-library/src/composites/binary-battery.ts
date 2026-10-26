/**
 * Binary battery copy lives with the badge. A binary source has no real
 * percentage: normal is the full stand-in, low is anything under the threshold.
 */

export const BINARY_BATTERY_LOW_BELOW: number = 50

export const BATTERY_BADGE_LOW_KEY = 'uiLibrary.batteryBadge.low' as const

export const BATTERY_BADGE_NORMAL_KEY = 'uiLibrary.batteryBadge.normal' as const

export function binaryBatteryIsLow(percentage: number): boolean {
  return percentage < BINARY_BATTERY_LOW_BELOW
}
