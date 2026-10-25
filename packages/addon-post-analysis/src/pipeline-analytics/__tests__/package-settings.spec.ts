import { describe, it, expect } from 'vitest'
import {
  PackageDropSettingsSchema,
  PACKAGE_DROP_DEFAULTS,
  resolvePackageDropSettings,
} from '../package-settings.js'

/**
 * Package-drop per-device settings — reset==unset guarantee (a cleared /
 * bad field falls back to its default, never throws) and the operator
 * defaults (ON, 3 confirmation frames, dwell 0, classFilter ['package']).
 */
describe('resolvePackageDropSettings', () => {
  it('empty store ⇒ operator defaults (ON, 3 frames, 0s dwell, pickup on, package class)', () => {
    const s = resolvePackageDropSettings({})
    expect(s).toEqual(PACKAGE_DROP_DEFAULTS)
    // ON since 2026-07-30: the `package`-stage ZONE RULE is what enables the
    // feature. As an opt-in this was a second source of truth that silently
    // defeated a fully-configured camera — see package-drop-enabled-default.spec.ts.
    expect(s.packageDropEnabled).toBe(true)
    expect(s.packageDropMinFrames).toBe(3)
    expect(s.packageDropDwellSec).toBe(0)
    expect(s.packageDropPickupEnabled).toBe(true)
    expect(s.packageDropClassFilter).toEqual(['package'])
    expect(s.packageDropMinBboxAreaFrac).toBe(0.004)
  })

  it('applies a per-device override', () => {
    const s = resolvePackageDropSettings({
      packageDropEnabled: true,
      packageDropMinFrames: 5,
      packageDropDwellSec: 45,
    })
    expect(s.packageDropEnabled).toBe(true)
    expect(s.packageDropMinFrames).toBe(5)
    expect(s.packageDropDwellSec).toBe(45)
  })

  it('a bad field falls back to its default (never throws) — reset==unset', () => {
    const s = resolvePackageDropSettings({
      packageDropEnabled: 'nope',
      packageDropDwellSec: -1_000_000,
      packageDropClassFilter: 'not-an-array',
    })
    expect(s.packageDropEnabled).toBe(PACKAGE_DROP_DEFAULTS.packageDropEnabled)
    expect(s.packageDropDwellSec).toBe(PACKAGE_DROP_DEFAULTS.packageDropDwellSec)
    expect(s.packageDropClassFilter).toEqual(['package'])
  })

  it('schema defaults match the exported defaults object', () => {
    expect(PackageDropSettingsSchema.parse({})).toEqual(PACKAGE_DROP_DEFAULTS)
  })
})
