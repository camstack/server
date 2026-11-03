import { DeviceType } from '@camstack/types'

/**
 * Hero widgets a type's own hero card already draws, so the page does not
 * stack them under it again: a sensor's hero IS its reading, the same one
 * the `power-meter` hero line would repeat (D1004).
 */
const HERO_DRAWN_WIDGETS: Partial<Record<DeviceType, readonly string[]>> = {
  [DeviceType.Sensor]: ['host/power-meter-line'],
}

export function heroDrawnWidgets(deviceType: string | undefined): readonly string[] {
  const known = Object.values(DeviceType).find((type) => type === deviceType)
  return known === undefined ? [] : (HERO_DRAWN_WIDGETS[known] ?? [])
}
