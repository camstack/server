import {
  type AccessoryChildSpec,
  BaseDevice,
  type DeviceContext,
  DeviceType,
  type IDevice,
} from '@camstack/types'
import { veluxWindowSchema } from '../config.js'
import { veluxGateways } from '../velux-node-resolver.js'
import { VeluxCoverDevice } from './velux-cover-device.js'
import { VeluxRainSensorDevice } from './velux-rain-sensor-device.js'

/**
 * A VELUX roof window with an integrated rain sensor: one
 * {@link DeviceType.Container} that groups the window's cover and its rain
 * sensor, both following the same gateway node. A single-function product
 * (shutter, blind, awning, window without rain) is a plain cover instead.
 */
export class VeluxWindowDevice extends BaseDevice<typeof veluxWindowSchema> {
  readonly features = [] as const

  constructor(ctx: DeviceContext) {
    const cfg = veluxWindowSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, veluxWindowSchema, { type: DeviceType.Container })
    this.online = veluxGateways.getManager(cfg.integrationId)?.status === 'connected'
    void this.updateSourceInfo({ id: cfg.nativeId, system: 'velux' })
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    const cfg = this.config.values
    const node = {
      nodeId: cfg.nodeId,
      serial: cfg.serial,
      integrationId: cfg.integrationId,
      system: 'velux' as const,
    }
    const link = { linkDeviceId: this.id, integrationId: cfg.integrationId }
    return [
      {
        stableIdSuffix: 'cover',
        meta: { type: DeviceType.Cover, name: this.name, ...link },
        config: { ...node, coverClass: cfg.coverClass },
        factory: (childCtx: DeviceContext): IDevice => new VeluxCoverDevice(childCtx),
      },
      {
        stableIdSuffix: 'rain',
        meta: { type: DeviceType.Sensor, name: `${this.name} rain`, ...link },
        config: node,
        factory: (childCtx: DeviceContext): IDevice => new VeluxRainSensorDevice(childCtx),
      },
    ] satisfies readonly AccessoryChildSpec[]
  }
}
