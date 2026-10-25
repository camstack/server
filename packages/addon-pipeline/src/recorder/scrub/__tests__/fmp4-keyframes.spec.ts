import { describe, it, expect } from 'vitest'
import { normalizeHevcCodecString } from '../fmp4-keyframes.js'

describe('normalizeHevcCodecString', () => {
  it('rewrites hev1 → hvc1 and passes others through', () => {
    expect(normalizeHevcCodecString('hev1.1.6.L120.b0')).toBe('hvc1.1.6.L120.b0')
    expect(normalizeHevcCodecString('avc1.64001f')).toBe('avc1.64001f')
  })
})
