/**
 * Device types the PointT gateway list reports. The set is the one the MIT
 * `homecom_alt` library branches on (`rac`, `k40`, `k30`, `wddw2`, `icom`,
 * `rrc2`). This file records that classification; it is not a copy of that code.
 */

export const HOMECOM_SERVED_TYPES = ['rac', 'k40', 'k30', 'wddw2', 'icom', 'rrc2'] as const

export type HomeComServedType = (typeof HOMECOM_SERVED_TYPES)[number]

/** Which resource tree a served type reads. */
export type HomeComResourceFamily = 'hydronic' | 'rac' | 'water-heater'

const FAMILIES: Record<HomeComServedType, HomeComResourceFamily> = {
  rac: 'rac',
  k40: 'hydronic',
  k30: 'hydronic',
  icom: 'hydronic',
  rrc2: 'hydronic',
  wddw2: 'water-heater',
}

export function familyOf(deviceType: string | undefined): HomeComResourceFamily | null {
  if (deviceType === undefined) return null
  if (!isServedType(deviceType)) return null
  return FAMILIES[deviceType]
}

export function isServedType(deviceType: string): deviceType is HomeComServedType {
  for (const served of HOMECOM_SERVED_TYPES) {
    if (deviceType === served) return true
  }
  return false
}

/** The account listed a type this addon has no climate or water-heater resources for. */
export class HomeComUnknownDeviceTypeError extends Error {
  readonly name = 'HomeComUnknownDeviceTypeError'
  readonly deviceType: string
  constructor(deviceType: string) {
    super(`HomeCom does not serve device type "${deviceType}".`)
    this.deviceType = deviceType
  }
}

export function unsupportedDeviceTypeMessage(deviceType: string | undefined): string | null {
  if (familyOf(deviceType) !== null) return null
  return new HomeComUnknownDeviceTypeError(deviceType ?? '(missing)').message
}
