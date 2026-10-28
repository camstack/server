import { IrCodecError } from './ir-error.js'
import { IrTimingsSchema, type IrTimings } from './ir-timings.js'

/** One Pronto frequency-word unit, in microseconds, per unit of the word. */
const PRONTO_CLOCK_US = 0.241246
const LEARNED_FORM = 0x0000

export interface ProntoDecoded {
  timings: IrTimings
  carrierHz: number
}

/**
 * Decode a learned (0000 form) Pronto hex string. The intro burst is followed by
 * the repeat burst once; a different form is refused with `pronto-unsupported-form`.
 */
export function decodePronto(code: string): ProntoDecoded {
  const words = code
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
  if (words.length < 4) {
    throw new IrCodecError(
      'pronto-malformed',
      `Pronto code needs at least 4 words, got ${words.length}`,
    )
  }
  const values = words.map((w) => (/^[0-9a-fA-F]{1,4}$/.test(w) ? parseInt(w, 16) : Number.NaN))
  if (values.some((v) => Number.isNaN(v))) {
    throw new IrCodecError('pronto-malformed', 'Pronto code must be 4-digit hexadecimal words')
  }
  const [form, freqWord, introCount, repeatCount] = values
  if (
    form === undefined ||
    freqWord === undefined ||
    introCount === undefined ||
    repeatCount === undefined
  ) {
    throw new IrCodecError('pronto-malformed', 'Pronto header incomplete')
  }
  if (form !== LEARNED_FORM) {
    throw new IrCodecError(
      'pronto-unsupported-form',
      `Pronto form ${words[0] ?? ''} is not supported, only the learned 0000 form`,
    )
  }
  if (freqWord === 0) {
    throw new IrCodecError('pronto-malformed', 'Pronto frequency word is zero')
  }
  const pairs = introCount + repeatCount
  if (pairs === 0 || values.length !== 4 + pairs * 2) {
    throw new IrCodecError(
      'pronto-malformed',
      `Pronto declares ${pairs} burst pairs but carries ${(values.length - 4) / 2} word pairs`,
    )
  }
  const unitUs = freqWord * PRONTO_CLOCK_US
  const timings = values.slice(4).map((count, index) => {
    const us = Math.max(1, Math.round(count * unitUs))
    return index % 2 === 0 ? us : -us
  })
  const checked = IrTimingsSchema.safeParse(timings)
  if (!checked.success) {
    throw new IrCodecError(
      'invalid-timings',
      `Pronto decoded to invalid timings: ${checked.error.message}`,
    )
  }
  return { timings: checked.data, carrierHz: Math.round(1_000_000 / unitUs) }
}
