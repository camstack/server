import { z } from 'zod'
import {
  BaseDevice,
  DeviceType,
  type AccessoryChildSpec,
  type DeviceContext,
  type IDevice,
} from '@camstack/types'
import { shcClimateEntityName } from '../shc-discovery.js'
import { shcStableIdSuffixFromDeviceId } from '../shc-stable-id-suffix.js'
import { shcDeviceSchema } from './shc-device-base.js'
import { ShcRoomClimateDevice } from './shc-room-climate-device.js'
import { ShcTrvDevice } from './shc-trv-device.js'

const shcClimateRoomChildSchema = z.object({
  shcDeviceId: z.string().min(1),
  name: z.string(),
  role: z.enum(['climate', 'trv']),
})

export const shcClimateRoomSchema = shcDeviceSchema.extend({
  children: z.array(shcClimateRoomChildSchema).min(1),
})

export type ShcClimateRoomConfig = z.infer<typeof shcClimateRoomSchema>

/** One SHC room: climate setpoint child + linked TRV accessories. */
export class ShcClimateRoomDevice extends BaseDevice<typeof shcClimateRoomSchema> {
  readonly features = [] as const

  private readonly integrationId: string | undefined
  private readonly brokerId: string
  private readonly deviceModel: string | undefined

  constructor(ctx: DeviceContext) {
    const cfg = shcClimateRoomSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, shcClimateRoomSchema, { type: DeviceType.Container })
    this.brokerId = cfg.brokerId
    this.integrationId = cfg.integrationId
    this.deviceModel = cfg.deviceModel
    this.online = true
    void this.updateSourceInfo({ id: cfg.shcDeviceId, system: 'bosch-shc' })
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    const cfg = this.config.values
    const containerName = this.name
    return cfg.children.map((child) => {
      if (child.role === 'climate') {
        const config: Record<string, unknown> = {
          shcDeviceId: child.shcDeviceId,
          brokerId: this.brokerId,
          deviceModel: this.deviceModel,
          system: 'bosch-shc',
          ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        }
        return {
          stableIdSuffix: 'climate',
          meta: {
            type: DeviceType.Climate,
            name: shcClimateEntityName(containerName),
            linkDeviceId: this.id,
            ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
          },
          config,
          factory: (childCtx: DeviceContext): IDevice => new ShcRoomClimateDevice(childCtx),
        } satisfies AccessoryChildSpec
      }
      const config: Record<string, unknown> = {
        shcDeviceId: child.shcDeviceId,
        brokerId: this.brokerId,
        deviceModel: this.deviceModel,
        system: 'bosch-shc',
        ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
      }
      return {
        stableIdSuffix: `trv-${shcStableIdSuffixFromDeviceId(child.shcDeviceId)}`,
        meta: {
          type: DeviceType.Thermostat,
          name: child.name,
          linkDeviceId: this.id,
          ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        },
        config,
        factory: (childCtx: DeviceContext): IDevice => new ShcTrvDevice(childCtx),
      } satisfies AccessoryChildSpec
    })
  }
}
