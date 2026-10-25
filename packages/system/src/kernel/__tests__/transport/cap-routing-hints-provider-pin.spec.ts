/**
 * The routing envelope carries the DEVICE-COLLECTION PIN, or the pin is
 * decided by code that cannot see it.
 *
 * ## The failure this pins down, which happened twice
 *
 * `LocalChildRegistry` decides whether to short-circuit a child's cap call to
 * a local sibling, and that decision runs BEFORE `onUnownedCall`. It asks
 * `isAddonPinnedCall`, and it hands that predicate these HINTS — not the args.
 *
 * D594 taught `onUnownedCall` to honour `{ provider }` on `videoclips` and
 * wired the predicate to recognise it. The predicate received `{}`, because
 * the envelope lifted only `nodeId` and `addonId`. So it answered false, the
 * call was short-circuited, `resolveChildId` fell through `deviceOwner` (no
 * per-device descriptor) to `singletonCandidates[0]`, and export-hap answered
 * a Reolink clip with "was not minted by the HomeKit source" — for the third
 * consecutive fix, with the provider named in the args the whole time.
 *
 * `addonPinOf`'s own docblock had already recorded this exact shape for the
 * 2026-08-09 attempt: *"the handler was correct and unreachable, and the probe
 * that proved it was a DELIBERATELY BOGUS addonId … It came back `null`."*
 *
 * So the rule these cases enforce: **a field the envelope does not carry is a
 * field the routing decision cannot see.**
 */
import { describe, expect, it } from 'vitest'
import { liftRoutingHints } from '../../transport/cap-routing-hints.js'

describe('liftRoutingHints — the device-collection pin', () => {
  it('lifts `provider` WITH the device it applies to', () => {
    // Both, or neither is usable: `provider` alone cannot say which device's
    // sources to narrow, and a pin that cannot be resolved is not a pin.
    expect(
      liftRoutingHints({
        deviceId: 3628,
        clipId: 'native:reolink:onboard:0:abc',
        provider: 'provider-reolink',
        profile: 'low',
      }),
    ).toEqual({ deviceId: 3628, provider: 'provider-reolink' })
  })

  it('still lifts the two it always did', () => {
    expect(liftRoutingHints({ nodeId: 'hub', addonId: 'provider-homeassistant' })).toEqual({
      nodeId: 'hub',
      addonId: 'provider-homeassistant',
    })
  })

  it('carries all four together — they are independent routing facts', () => {
    expect(
      liftRoutingHints({
        nodeId: 'hub',
        addonId: 'a',
        provider: 'provider-reolink',
        deviceId: 107,
      }),
    ).toEqual({ nodeId: 'hub', addonId: 'a', provider: 'provider-reolink', deviceId: 107 })
  })

  it('omits an empty provider — absence is not a pin', () => {
    expect(liftRoutingHints({ deviceId: 3628, provider: '' })).toEqual({ deviceId: 3628 })
  })

  it('omits a non-string provider and a non-numeric deviceId rather than coercing', () => {
    expect(liftRoutingHints({ provider: 7, deviceId: '3628' })).toEqual({})
    expect(liftRoutingHints({ deviceId: Number.NaN })).toEqual({})
  })

  it('never throws on what is not an args object', () => {
    for (const bad of [null, undefined, 42, 'x', [1, 2]]) {
      expect(liftRoutingHints(bad)).toEqual({})
    }
  })

  it('lifts nothing else — the parent sees only routing facts under raw-forward', () => {
    const hints = liftRoutingHints({
      deviceId: 1,
      provider: 'p',
      clipId: 'secret',
      profile: 'high',
      maxBytes: 5,
    })
    expect(Object.keys(hints).sort()).toEqual(['deviceId', 'provider'])
  })
})
