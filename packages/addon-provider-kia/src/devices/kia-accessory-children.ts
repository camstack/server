import {
  DeviceRole,
  DeviceType,
  type AccessoryChildSpec,
  type DeviceContext,
  type IDevice,
} from '@camstack/types'
import { KiaClimateDevice, KiaLockDevice } from './kia-vehicle-accessory-device.js'

export interface KiaAccessoryParent {
  readonly name: string
  readonly deviceId: number
  readonly kiaVehicleId: string
  readonly brokerId: string
  readonly model: string | undefined
  readonly integrationId: string | undefined
}

export const KIA_LOCK_SUFFIX = 'lock'
export const KIA_CLIMATE_SUFFIX = 'climate'

/** The lock and climate accessories of a car (D1079). */
export function kiaAccessoryChildren(parent: KiaAccessoryParent): readonly AccessoryChildSpec[] {
  const config: Record<string, unknown> = {
    kiaVehicleId: parent.kiaVehicleId,
    brokerId: parent.brokerId,
    system: 'kia',
    ...(parent.model !== undefined ? { model: parent.model } : {}),
    ...(parent.integrationId !== undefined ? { integrationId: parent.integrationId } : {}),
  }
  const link = {
    linkDeviceId: parent.deviceId,
    ...(parent.integrationId !== undefined ? { integrationId: parent.integrationId } : {}),
  }
  return [
    {
      stableIdSuffix: KIA_LOCK_SUFFIX,
      meta: {
        type: DeviceType.Lock,
        role: DeviceRole.LockVehicle,
        name: `${parent.name} lock`,
        ...link,
      },
      config,
      factory: (ctx: DeviceContext): IDevice => new KiaLockDevice(ctx),
    },
    {
      stableIdSuffix: KIA_CLIMATE_SUFFIX,
      meta: {
        type: DeviceType.Climate,
        role: DeviceRole.ClimateVehicle,
        name: `${parent.name} climate`,
        ...link,
      },
      config,
      factory: (ctx: DeviceContext): IDevice => new KiaClimateDevice(ctx),
    },
  ]
}
