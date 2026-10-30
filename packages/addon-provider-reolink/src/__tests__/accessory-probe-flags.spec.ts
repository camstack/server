import { describe, expect, it } from 'vitest'
import {
  hasEverProbed,
  type ReolinkAccessoryProbeFlags,
  resolveAccessoryProbeFlags,
} from '../accessory-probe-flags'

const LIVE_FLAGS: ReolinkAccessoryProbeFlags = {
  hasSiren: true,
  hasFloodlight: true,
  hasPirSensor: true,
}

describe('hasEverProbed', () => {
  it('true when the live slice has probed this session', () => {
    expect(hasEverProbed(true, undefined)).toBe(true)
  })

  it('true when deviceCache carries a prior probe stamp (slice empty)', () => {
    expect(hasEverProbed(false, { probedAt: 1777886473521 })).toBe(true)
  })

  it('false when neither source carries a completed probe', () => {
    expect(hasEverProbed(false, undefined)).toBe(false)
    expect(hasEverProbed(false, {})).toBe(false)
  })
})

describe('resolveAccessoryProbeFlags', () => {
  it('prefers the live slice flags when the slice has probed', () => {
    const cache = { probedAt: 1, hasSiren: false, hasFloodlight: false, hasPirSensor: false }
    expect(resolveAccessoryProbeFlags(true, LIVE_FLAGS, cache)).toEqual(LIVE_FLAGS)
  })

  it('falls back to deviceCache flags when the slice has not probed', () => {
    // Reproduces the real-world bug: a slow-probing doorbell restores
    // with an empty slice but a fully-populated deviceCache. Without the
    // fallback this returned {}, so getAccessoryChildren() spawned
    // nothing and the accessories never got device-ops.
    const cache = {
      probedAt: 1777886473521,
      hasSiren: true,
      hasFloodlight: false,
      hasPirSensor: true,
    }
    expect(resolveAccessoryProbeFlags(false, {}, cache)).toEqual({
      hasSiren: true,
      hasFloodlight: false,
      hasPirSensor: true,
    })
  })

  it('returns an empty bag when slice has not probed AND no deviceCache stamp', () => {
    expect(resolveAccessoryProbeFlags(false, {}, undefined)).toEqual({})
    expect(resolveAccessoryProbeFlags(false, {}, { hasSiren: true })).toEqual({})
  })

  it('ignores non-boolean deviceCache flag values in the fallback', () => {
    const cache = { probedAt: 1, hasSiren: 'yes', hasPirSensor: 1, hasFloodlight: true }
    expect(resolveAccessoryProbeFlags(false, {}, cache)).toEqual({ hasFloodlight: true })
  })
})
