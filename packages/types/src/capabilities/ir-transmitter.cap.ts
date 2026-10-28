import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { IrTimingsSchema, TransmitSettingsSchema } from '../ir/ir-timings.js'

/** The setting keys a transmitter may declare as settable (`getInfo.settable`). */
export const TransmitSettingKeySchema = z.enum([
  'carrierHz',
  'dutyCyclePercent',
  'repeat',
  'repeatDelayMs',
])
export type TransmitSettingKey = z.infer<typeof TransmitSettingKeySchema>

export const IrMediumSchema = z.enum(['ir', 'rf'])
export type IrMedium = z.infer<typeof IrMediumSchema>

export const IrSendResultSchema = z.object({
  ok: z.literal(true),
  /** Settings the transmitter could not apply; the train was still sent. */
  ignoredSettings: z.array(z.string()),
})
export type IrSendResult = z.infer<typeof IrSendResultSchema>

export const IrTransmitterInfoSchema = z.object({
  media: z.array(IrMediumSchema),
  settable: z.array(TransmitSettingKeySchema),
  maxTimings: z.number().int().positive(),
})
export type IrTransmitterInfo = z.infer<typeof IrTransmitterInfoSchema>

/**
 * ir-transmitter — emit a pulse train (infrared or RF) with settings. One cap
 * for both media: everything medium-specific is a per-call setting, validated
 * against what the transmitter declares in `getInfo`.
 *
 * `send` refuses with a typed user error: `ir-transmitter.offline` (the
 * transmitter cannot be reached) and `ir-transmitter.too-long` (more pulses
 * than the transmitter's `maxTimings`). A setting the transmitter cannot apply
 * is NOT a refusal: the train is sent and the key comes back in
 * `ignoredSettings`.
 */
export const irTransmitterCapability = {
  name: 'ir-transmitter',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Generic],
  methods: {
    send: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        timings: IrTimingsSchema,
        settings: TransmitSettingsSchema.optional(),
      }),
      IrSendResultSchema,
      { kind: 'mutation', auth: 'protected' },
    ),
    getInfo: method(
      z.object({ deviceId: z.number().int().nonnegative() }),
      IrTransmitterInfoSchema,
      { kind: 'query', auth: 'protected' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IIrTransmitterProvider = InferProvider<typeof irTransmitterCapability>
