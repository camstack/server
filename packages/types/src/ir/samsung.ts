import { IrCodecError } from './ir-error.js'
import type { IrTimings } from './ir-timings.js'

/**
 * The Samsung infrared frame (the "Samsung32" a television takes): a 4.5 ms
 * header burst and gap, then the bits MSB-first, each a 560 µs mark followed
 * by a 1690 µs (one) or 560 µs (zero) space, closed by a 560 µs mark. The
 * constants are the ones an ESPHome `remote_transmitter.transmit_samsung`
 * uses, so a frame encoded here is the train that board would emit from the
 * same `data` / `nbits`.
 */
export const SAMSUNG_CARRIER_HZ = 38000
export const SAMSUNG_MAX_BITS = 32

const HEADER_US = 4500
const BIT_MARK_US = 560
const ONE_SPACE_US = 1690
const ZERO_SPACE_US = 560
const FOOTER_SPACE_US = 560

export interface SamsungFrame {
  /** The code as the board stores it, e.g. `0xE0E040BF` for power. */
  readonly data: number
  /** How many bits of `data` are sent, MSB first (32 for a television). */
  readonly nbits: number
}

function mustBeInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new IrCodecError('samsung-invalid', `${what} must be a non-negative integer`)
  }
}

/** Encode one Samsung frame as a pulse train. Throws `IrCodecError` (`samsung-invalid`). */
export function encodeSamsung(frame: SamsungFrame): IrTimings {
  mustBeInteger(frame.nbits, 'nbits')
  mustBeInteger(frame.data, 'data')
  if (frame.nbits < 1 || frame.nbits > SAMSUNG_MAX_BITS) {
    throw new IrCodecError('samsung-invalid', `nbits must be 1..${SAMSUNG_MAX_BITS}`)
  }
  if (frame.data >= 2 ** frame.nbits) {
    throw new IrCodecError('samsung-invalid', `data does not fit in ${frame.nbits} bits`)
  }
  const bits = Array.from({ length: frame.nbits }, (_, index) => {
    const shift = frame.nbits - 1 - index
    return Math.floor(frame.data / 2 ** shift) % 2 === 1
  })
  const body = bits.flatMap((one) => [BIT_MARK_US, -(one ? ONE_SPACE_US : ZERO_SPACE_US)])
  return [HEADER_US, -HEADER_US, ...body, BIT_MARK_US, -FOOTER_SPACE_US]
}
