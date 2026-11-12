import { z } from 'zod'
import { IrCodecError } from './ir-error.js'
import {
  IrTimingsSchema,
  TransmitSettingsSchema,
  type IrTimings,
  type TransmitSettings,
} from './ir-timings.js'
import { decodePronto } from './pronto.js'
import { IR_NATIVE_CODECS, IrNativeFormatSchema } from './native.js'

/** What a remote command stores: a raw pulse train, a learned Pronto code, or a device-native code. */
export const IrPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('raw'),
    timings: z.array(z.number().int()),
    settings: TransmitSettingsSchema.optional(),
  }),
  z.object({ kind: z.literal('pronto'), code: z.string() }),
  z.object({ kind: z.literal('native'), format: IrNativeFormatSchema, code: z.string() }),
])
export type IrPayload = z.infer<typeof IrPayloadSchema>

export interface ResolvedTransmission {
  timings: IrTimings
  settings: TransmitSettings
}

/** Resolve a payload to what `ir-transmitter.send` takes. Throws `IrCodecError`. */
export function toTimings(payload: IrPayload): ResolvedTransmission {
  if (payload.kind === 'pronto') {
    const decoded = decodePronto(payload.code)
    return { timings: decoded.timings, settings: { carrierHz: decoded.carrierHz } }
  }
  if (payload.kind === 'native') {
    return { timings: IR_NATIVE_CODECS[payload.format].decode(payload.code), settings: {} }
  }
  const checked = IrTimingsSchema.safeParse(payload.timings)
  if (!checked.success) {
    throw new IrCodecError('invalid-timings', checked.error.message)
  }
  return { timings: checked.data, settings: payload.settings ?? {} }
}
