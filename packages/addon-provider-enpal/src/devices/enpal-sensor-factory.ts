import type { DeviceContext, IDevice } from '@camstack/types'
import { EnpalSensorDevice } from './enpal-sensor-device.js'

/** Constructor closure the kernel calls for every Sensor child of an equipment Container. */
export function enpalSensorFactory(ctx: DeviceContext): IDevice {
  return new EnpalSensorDevice(ctx)
}
