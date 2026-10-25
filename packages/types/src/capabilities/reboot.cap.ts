import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * reboot — device-scoped capability for "soft" device reboots (firmware
 * reboot via vendor protocol; cameras, NVRs, doorbells). Surfaces a
 * single mutation so the UI can offer a confirm-and-reboot button for
 * any device whose driver advertises `DeviceFeature.Rebootable`.
 *
 * Implementation contract: the driver SHOULD return only after the
 * remote acknowledges the request (camera will go offline shortly
 * after). Wrappers in the addon should NOT block on the device coming
 * back online — operators read the device-online indicator for that.
 *
 * Errors propagate verbatim: a 401 from the camera surfaces as a tRPC
 * error to the UI, which renders it next to the button.
 */
export const rebootCapability = {
  name: 'reboot',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera, DeviceType.Sensor, DeviceType.Switch],
  methods: {
    reboot: method(
      z.object({ deviceId: z.number().int().nonnegative() }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IRebootProvider = InferProvider<typeof rebootCapability>
