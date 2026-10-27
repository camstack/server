import { BaseDevice, DeviceType, type DeviceContext, type DeviceFeature } from '@camstack/types'
import { mqttHaDeviceSchema } from './mqtt-ha-device-config.js'

/**
 * The root of a multi-actuator device (a multi-gang switch). It carries no
 * function of its own: every gang is a child device, and readings belong to
 * the children because device history does not record containers.
 */
export class MqttHaContainerDevice extends BaseDevice<typeof mqttHaDeviceSchema> {
  readonly features: readonly DeviceFeature[] = []

  constructor(ctx: DeviceContext) {
    super(ctx, mqttHaDeviceSchema, { type: DeviceType.Container })
    this.online = true
  }
}
