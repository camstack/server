/**
 * Package detection is enabled by CONFIGURING A ZONE, not by a second switch.
 *
 * `packageDropEnabled` shipped as an opt-in defaulting to false. That made it a
 * parallel source of truth: an operator could draw the zone, attach an enabled
 * `package`-stage zone rule to it, write a notification rule against
 * `delivery: 'package-event'` — and get nothing, silently, because a boolean
 * elsewhere was still false.
 *
 * That is exactly what device 101 looked like on 2026-07-30:
 *   zones            → Uscio, Aiuola
 *   zoneRules.package → { name: 'Pacchetti', zoneIds: [Uscio],
 *                         classFilter: ['package'], enabled: true }
 *   NC rule          → 'Consegna pacco (front door)', delivery: 'package-event'
 *   packageDropEnabled → false (no override stored; declared default)
 *
 * Three layers of intent, defeated by the flag none of them mentions.
 *
 * The zone rule is now the enabling configuration. The flag survives only as an
 * explicit per-camera OFF: `detector.onAppeared` still returns early when a
 * device has no enabled `package`-stage rule, so defaulting to true costs a
 * class check and one cached lookup on cameras nobody configured.
 */

import { describe, expect, it } from 'vitest'
import { PACKAGE_DROP_DEFAULTS, resolvePackageDropSettings } from '../package-settings.js'

describe('package-drop enablement', () => {
  it('is on by default — the zone rule is what gates it', () => {
    expect(PACKAGE_DROP_DEFAULTS.packageDropEnabled).toBe(true)
  })

  it('applies the default when a device stored no override at all', () => {
    expect(resolvePackageDropSettings({}).packageDropEnabled).toBe(true)
  })

  it('still honours an explicit per-camera OFF', () => {
    expect(resolvePackageDropSettings({ packageDropEnabled: false }).packageDropEnabled).toBe(false)
  })

  it('leaves the measured thresholds alone — only enablement changed', () => {
    const s = resolvePackageDropSettings({})
    expect(s.packageDropMinFrames).toBe(3)
    expect(s.packageDropDwellSec).toBe(0)
    expect(s.packageDropMinBboxAreaFrac).toBe(0.004)
    expect(s.packageDropClassFilter).toEqual(['package'])
  })

  it('an invalid stored value falls back to the default rather than disabling', () => {
    // A corrupt store must not silently switch the feature off — that is the
    // same silence this change exists to remove.
    expect(
      resolvePackageDropSettings({
        packageDropEnabled: 'yes' as unknown as boolean,
      }).packageDropEnabled,
    ).toBe(true)
  })
})
