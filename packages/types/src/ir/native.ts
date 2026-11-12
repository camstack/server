import { z } from 'zod'
import type { IrTimings } from './ir-timings.js'
import { IR_DECOMPRESSED_MAX } from './fastlz.js'
import { decodeTuya, encodeTuya } from './tuya.js'

/** Device-native IR code formats a transmitter can replay verbatim. */
export const IrNativeFormatSchema = z.enum(['tuya'])
export type IrNativeFormat = z.infer<typeof IrNativeFormatSchema>

/**
 * Longest native code accepted: base64 of the worst-case compressed stream
 * (every decoded byte as a literal, plus one control byte per 32), with margin.
 */
export const IR_NATIVE_CODE_MAX_CHARS =
  Math.ceil((IR_DECOMPRESSED_MAX + Math.ceil(IR_DECOMPRESSED_MAX / 32)) / 3) * 4 + 256

export const IrNativeCodeSchema = z.object({
  format: IrNativeFormatSchema,
  code: z.string().min(1).max(IR_NATIVE_CODE_MAX_CHARS),
})
export type IrNativeCode = z.infer<typeof IrNativeCodeSchema>

export interface IrNativeCodec {
  encode(timings: IrTimings): string
  decode(code: string): IrTimings
}

export const IR_NATIVE_CODECS: Record<IrNativeFormat, IrNativeCodec> = {
  tuya: { encode: encodeTuya, decode: decodeTuya },
}
