import { z } from 'zod'
import { IrCodecError } from './ir-error.js'
import {
  IrTimingsSchema,
  TransmitSettingsSchema,
  type IrTimings,
  type TransmitSettings,
} from './ir-timings.js'
import { decodePronto } from './pronto.js'

/** What a remote command stores: a raw pulse train, or a learned Pronto code. */
export const IrPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('raw'),
    timings: z.array(z.number().int()),
    settings: TransmitSettingsSchema.optional(),
  }),
  z.object({ kind: z.literal('pronto'), code: z.string() }),
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
  const checked = IrTimingsSchema.safeParse(payload.timings)
  if (!checked.success) {
    throw new IrCodecError('invalid-timings', checked.error.message)
  }
  return { timings: checked.data, settings: payload.settings ?? {} }
}
