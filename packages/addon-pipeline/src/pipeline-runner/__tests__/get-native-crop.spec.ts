import { NativeCropResultSchema } from '@camstack/types'
import { describe, it, expect } from 'vitest'
import {
  resolveNativeCropHitKind,
  resolveNativeCropSource,
  toPublicNativeCropTier,
} from '../native-crop-tier.js'

// Task S1: getNativeCrop must NOT serve the ≤640 RAM RetainedFrameStore for an
// ROI (subject-crop) request when the native lease missed — that is a quality
// masquerade (a ≤640 crop dressed up as native). A native miss on an ROI must
// report the miss (`'miss'`) so the caller retries. A full-frame request keeps
// the RAM fallback (blank-guard + 640-snapshot resolve legitimately need it).
//
// The tier decision lives in the pure `resolveNativeCropSource` helper so it can
// be exercised without constructing the whole runner (private native-lease /
// retained-frame fields would otherwise force a cast). `getNativeCrop` is wired
// through this helper.
describe('resolveNativeCropSource', () => {
  it('resolves to the native surface whenever the native lease HIT', () => {
    expect(resolveNativeCropSource(false, true)).toBe('native') // ROI hit
    expect(resolveNativeCropSource(true, true)).toBe('native') // full-frame hit
  })

  it('returns "miss" for an ROI when the native lease missed (no ≤640 RAM masquerade)', () => {
    expect(resolveNativeCropSource(false, false)).toBe('miss')
  })

  it('falls back to the RAM store only for a full-frame native miss', () => {
    expect(resolveNativeCropSource(true, false)).toBe('ram-fullframe')
  })
})

// `getNativeCrop` tags each SERVED result with the tier the pure helper resolved,
// so a quality-sensitive consumer (native keyFrame) can reject the ≤640 RAM
// fallback. Exercised through the wire schema (`NativeCropResultSchema`) — the
// runner attaches exactly the `tier` value `resolveNativeCropSource` returns for
// the served branch. `tier` is OPTIONAL so a pre-tier runner (version skew) omits
// it and the result still validates (consumers treat absent as `native`).
describe('getNativeCrop result tier (wire schema)', () => {
  it('tags a native hit with tier "native"', () => {
    const tier = resolveNativeCropSource(false, true) // ROI hit → native
    const result = NativeCropResultSchema.parse({
      bytes: new Uint8Array([1, 2, 3]),
      width: 1920,
      height: 1080,
      tier,
    })
    expect(result.tier).toBe('native')
  })

  it('tags a full-frame RAM fallback with tier "ram-fullframe"', () => {
    const tier = resolveNativeCropSource(true, false) // full-frame miss → RAM
    const result = NativeCropResultSchema.parse({
      bytes: new Uint8Array([9]),
      width: 640,
      height: 360,
      tier,
    })
    expect(result.tier).toBe('ram-fullframe')
  })

  it('validates a result with no tier (pre-tier runner, version skew)', () => {
    const result = NativeCropResultSchema.parse({
      bytes: new Uint8Array([9]),
      width: 640,
      height: 360,
    })
    expect(result.tier).toBeUndefined()
  })

  // Cross-node compressed path (Bug 1 fix): the owning runner returns `jpeg`
  // (base64) instead of raw `bytes` so the payload fits Moleculer's maxPacketSize
  // and no raw pixels cross a process boundary. Both fields are optional/additive.
  it('validates a compressed cross-node result (jpeg present, bytes absent)', () => {
    const result = NativeCropResultSchema.parse({
      jpeg: Buffer.from([0xff, 0xd8, 0xff]).toString('base64'),
      width: 3840,
      height: 2160,
      tier: 'native',
    })
    expect(result.jpeg).toBeDefined()
    expect(result.bytes).toBeUndefined()
    expect(result.tier).toBe('native')
  })

  it('distinguishes native lease hits from tile hits without changing the public cap tier', () => {
    expect(resolveNativeCropHitKind('lease')).toBe('native')
    expect(resolveNativeCropHitKind('tile')).toBe('tile')
    expect(resolveNativeCropHitKind(undefined)).toBe('native')
    expect(toPublicNativeCropTier('native')).toBe('native')
    expect(toPublicNativeCropTier('tile')).toBe('native')
    expect(toPublicNativeCropTier('ram-fullframe')).toBe('ram-fullframe')
    expect(toPublicNativeCropTier('miss')).toBeUndefined()
  })

  it('still validates the raw same-node result (bytes present, jpeg absent)', () => {
    const result = NativeCropResultSchema.parse({
      bytes: new Uint8Array([1, 2, 3]),
      width: 100,
      height: 120,
      tier: 'native',
    })
    expect(result.bytes).toBeDefined()
    expect(result.jpeg).toBeUndefined()
  })
})
