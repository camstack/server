import { IrCodecError } from './ir-error.js'
import { fastlzCompress, fastlzDecompress } from './fastlz.js'
import { IrTimingsSchema, type IrTimings } from './ir-timings.js'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const MAX_DURATION_US = 0xffff

function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const word = (a << 16) | (b << 8) | c
    out += ALPHABET[(word >> 18) & 63]
    out += ALPHABET[(word >> 12) & 63]
    out += i + 1 < bytes.length ? ALPHABET[(word >> 6) & 63] : '='
    out += i + 2 < bytes.length ? ALPHABET[word & 63] : '='
  }
  return out
}

function fromBase64(text: string): Uint8Array {
  const clean = text.trim().replace(/=+$/, '')
  if (clean.length === 0 || clean.length % 4 === 1) {
    throw new IrCodecError('tuya-malformed', 'not a base64 string')
  }
  const out: number[] = []
  let bits = 0
  let acc = 0
  for (const ch of clean) {
    const value = ALPHABET.indexOf(ch)
    if (value < 0) throw new IrCodecError('tuya-malformed', 'not a base64 string')
    acc = (acc << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 255)
    }
  }
  return Uint8Array.from(out)
}

/** Signed pulse train to a Tuya IR code: base64(FastLZ(uint16 LE durations)). */
export function encodeTuya(timings: IrTimings): string {
  const bytes = new Uint8Array(timings.length * 2)
  timings.forEach((value, index) => {
    const duration = Math.abs(value)
    if (duration === 0 || duration > MAX_DURATION_US) {
      throw new IrCodecError('invalid-timings', `timing ${index} does not fit 16 bits`)
    }
    bytes[index * 2] = duration & 255
    bytes[index * 2 + 1] = duration >> 8
  })
  return toBase64(fastlzCompress(bytes))
}

/** A Tuya IR code to a signed pulse train (mark first). Throws `IrCodecError`. */
export function decodeTuya(code: string): IrTimings {
  const bytes = fastlzDecompress(fromBase64(code))
  if (bytes.length === 0 || bytes.length % 2 !== 0) {
    throw new IrCodecError('tuya-malformed', 'payload is not a list of 16-bit durations')
  }
  const timings: number[] = []
  for (let i = 0; i < bytes.length; i += 2) {
    const duration = (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8)
    timings.push((i / 2) % 2 === 0 ? duration : -duration)
  }
  const checked = IrTimingsSchema.safeParse(timings)
  if (!checked.success) throw new IrCodecError('tuya-malformed', checked.error.message)
  return checked.data
}
