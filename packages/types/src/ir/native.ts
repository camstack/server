import { z } from 'zod'
import type { IrTimings } from './ir-timings.js'
import { decodeTuya, encodeTuya } from './tuya.js'

/** Device-native IR code formats a transmitter can replay verbatim. */
export const IrNativeFormatSchema = z.enum(['tuya'])
export type IrNativeFormat = z.infer<typeof IrNativeFormatSchema>

export const IrNativeCodeSchema = z.object({
  format: IrNativeFormatSchema,
  code: z.string().min(1),
})
export type IrNativeCode = z.infer<typeof IrNativeCodeSchema>

export interface IrNativeCodec {
  encode(timings: IrTimings): string
  decode(code: string): IrTimings
}

export const IR_NATIVE_CODECS: Record<IrNativeFormat, IrNativeCodec> = {
  tuya: { encode: encodeTuya, decode: decodeTuya },
}
