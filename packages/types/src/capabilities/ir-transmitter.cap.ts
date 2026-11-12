import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { IrTimingsSchema, TransmitSettingsSchema } from '../ir/ir-timings.js'
import { IrNativeCodeSchema, IrNativeFormatSchema } from '../ir/native.js'

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
  /** The transmitter can learn a code (`learn`). */
  learn: z.boolean().default(false),
  /** Native code formats the transmitter replays verbatim (`send.native`). */
  formats: z.array(IrNativeFormatSchema).default([]),
})
export type IrTransmitterInfo = z.infer<typeof IrTransmitterInfoSchema>

export const IR_LEARN_TIMEOUT_DEFAULT_MS = 20_000
export const IR_LEARN_TIMEOUT_MAX_MS = 60_000

export const IrLearnResultSchema = z.object({
  /** The code in the device's own format, when it reports one. */
  native: IrNativeCodeSchema.nullable(),
  timings: IrTimingsSchema,
  carrierHz: z.number().int().positive().nullable(),
})
export type IrLearnResult = z.infer<typeof IrLearnResultSchema>

/**
 * ir-transmitter — emit a pulse train (infrared or RF) with settings. One cap
 * for both media: everything medium-specific is a per-call setting, validated
 * against what the transmitter declares in `getInfo`.
 *
 * `send` refuses with a typed user error: `ir-transmitter.offline` (the
 * transmitter cannot be reached) and `ir-transmitter.too-long` (more pulses
 * than the transmitter's `maxTimings`). A setting the transmitter cannot apply
 * is NOT a refusal: the train is sent and the key comes back in
 * `ignoredSettings`. `send` takes exactly one of `timings` or `native` (a code
 * in a format listed in `getInfo.formats`).
 *
 * `learn` waits for the user to point a remote at the transmitter and refuses
 * with `ir-transmitter.learn-unsupported`, `ir-transmitter.learn-timeout` or
 * `ir-transmitter.learn-undecodable`.
 */
export const irTransmitterCapability = {
  name: 'ir-transmitter',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Generic],
  methods: {
    send: method(
      z
        .object({
          deviceId: z.number().int().nonnegative(),
          timings: IrTimingsSchema.optional(),
          native: IrNativeCodeSchema.optional(),
          settings: TransmitSettingsSchema.optional(),
        })
        .refine((input) => (input.timings === undefined) !== (input.native === undefined), {
          message: 'send takes exactly one of timings or native',
        }),
      IrSendResultSchema,
      { kind: 'mutation', auth: 'protected' },
    ),
    learn: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(IR_LEARN_TIMEOUT_MAX_MS)
          .default(IR_LEARN_TIMEOUT_DEFAULT_MS),
      }),
      IrLearnResultSchema,
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
