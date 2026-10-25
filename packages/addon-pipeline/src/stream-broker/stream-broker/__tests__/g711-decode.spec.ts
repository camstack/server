import { describe, it, expect } from 'vitest'
import { pcmToMulaw, mulawToPcm, alawToPcm } from '../g711-mulaw'

describe('mulawToPcm', () => {
  it('decodes the µ-law silence byte 0xFF to 0', () => {
    expect(mulawToPcm(new Uint8Array([0xff]))[0]).toBe(0)
  })

  it('round-trips PCM → µ-law → PCM within µ-law quantization error', () => {
    const src = new Int16Array([0, 100, -100, 1000, -1000, 8000, -8000, 20000, -20000, 32000])
    const back = mulawToPcm(pcmToMulaw(src))
    for (let i = 0; i < src.length; i++) {
      // µ-law is ~8-bit logarithmic; small values are near-exact, large values
      // quantize more coarsely. Relative tolerance keeps the check honest.
      const tol = Math.max(64, Math.abs(src[i]!) * 0.12)
      expect(Math.abs(back[i]! - src[i]!)).toBeLessThanOrEqual(tol)
    }
  })

  it('preserves sign', () => {
    const back = mulawToPcm(pcmToMulaw(new Int16Array([5000, -5000])))
    expect(back[0]!).toBeGreaterThan(0)
    expect(back[1]!).toBeLessThan(0)
  })
})

describe('alawToPcm', () => {
  it('produces a signed value near zero for the A-law silence byte 0xD5', () => {
    // 0xD5 is A-law's encoding of ~digital zero; decodes to a small magnitude.
    expect(Math.abs(alawToPcm(new Uint8Array([0xd5]))[0]!)).toBeLessThan(16)
  })
  it('preserves sign across the 0x80 bit', () => {
    // High bit set → positive branch, clear → negative branch (post-XOR 0x55).
    const hi = alawToPcm(new Uint8Array([0xd5 | 0x80]))[0]!
    const lo = alawToPcm(new Uint8Array([0x55 & 0x7f]))[0]!
    expect(hi).toBeGreaterThanOrEqual(0)
    expect(lo).toBeLessThanOrEqual(0)
  })
})
