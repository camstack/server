import type { AccessoryChildSpec } from '@camstack/types'

export interface KiaAccessoryParent {
  readonly name: string
  readonly deviceId: number
  readonly kiaVehicleId: string
  readonly brokerId: string
  readonly model: string | undefined
  readonly integrationId: string | undefined
}

/** The lock and climate accessories of a car (D1079). Added with the commands. */
export function kiaAccessoryChildren(_parent: KiaAccessoryParent): readonly AccessoryChildSpec[] {
  return []
}
