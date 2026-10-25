/**
 * The new HomeKit camera service is offered per camera, and ON by default.
 *
 * ## Why per camera, and why on
 *
 * Apple's `camera-multi-tier-rtp-stream-management` (0x8031) is where HEVC and
 * 4K live. The classic service this addon has always spoken carries H.264 and
 * nothing else — which is why the one H.265 camera on this hub is transcoded
 * from 4K HEVC down to 720p H.264 just to be shown, and the H.264 ones are
 * passed through untouched.
 *
 * Measured, 2026-09-16: a controller READS the new service's characteristics
 * and then opens its session on the classic one two seconds later. It engages;
 * it declines because we tell it `streaming-enabled: false` and declare a
 * fraction of what it needs. The fallback is the controller's own, and it is
 * safe — which is what makes a default of ON reasonable while the negotiation
 * is still being built.
 *
 * Per camera rather than global because the cost and the prize are per camera:
 * an H.265 sensor has everything to gain and an H.264 one has nothing to gain,
 * and an operator with a camera that behaves oddly needs somewhere to turn it
 * off that is not "for the whole house".
 *
 * ABSENT means ON, like every other switch here whose field postdates the
 * entries it governs (`resolveHksvRecording` is the same shape). A camera
 * exposed before this field existed must not silently lose it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { resolveMultiTierService } from '../hap-export.addon.js'

describe('resolveMultiTierService — default OFF', () => {
  /**
   * Flipped 2026-09-17. It was ON, on the measurement that a controller reads
   * the new service and falls back harmlessly. Then every camera stopped
   * working in Home with it live — and a structural change made to EVERY
   * camera accessory is the first suspect for a failure that affects every
   * camera, whatever else was also wrong at the time.
   */
  it('is OFF for a camera whose settings predate the field', () => {
    expect(resolveMultiTierService(null)).toBe(false)
    expect(resolveMultiTierService(undefined)).toBe(false)
    expect(resolveMultiTierService({ streamPreference: 'auto' })).toBe(false)
  })

  it('is on when explicitly on', () => {
    expect(resolveMultiTierService({ streamPreference: 'auto', multiTierService: true })).toBe(true)
  })

  it('is ON only when the operator said so', () => {
    // The one value that turns it on is `true`. Anything else — a missing key,
    // a junk value from a hand-edited blob — reads as the default, which is
    // what "absent means off" has to mean to be worth stating.
    expect(resolveMultiTierService({ streamPreference: 'auto', multiTierService: false })).toBe(
      false,
    )
  })
})

describe('the multi-tier service name is one HAP accepts', () => {
  /**
   * HAP-NodeJS validates the `Name` characteristic and WARNS that an invalid
   * one "may prevent the accessory from being added in the Home App or cause
   * unresponsiveness". While the service was an off-by-default experiment the
   * warning was noise; now it is declared on every exposed camera, so the name
   * is part of the release. The experiment's name — `CamStack multi-tier
   * (probe)` — was rejected for its parentheses.
   */
  it('starts and ends with alphanumerics and carries no brackets', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../multi-tier/multi-tier-service.ts'),
      'utf8',
    )
    const names = [...source.matchAll(/new Service\(\s*'([^']+)'/g)].map((m) => m[1] ?? '')
    // Three services, and a bad name on any of them is a warning on every
    // exposed camera — the file declares them together so the test checks
    // them together.
    expect(names.length).toBeGreaterThanOrEqual(3)
    for (const name of names) {
      expect(name, name).toMatch(/^[A-Za-z0-9][A-Za-z0-9 '.,-]*[A-Za-z0-9]$/)
    }
  })
})
