import { describe, expect, it } from 'vitest'
import { SCRUB_LEAD_MAX_MS, scrubLeadDecision } from '../scrub-lead'

describe('scrubLeadDecision — a lead has a ceiling', () => {
  it('reproduces the operator’s measured drag: 14 minutes of lead becomes none', () => {
    // 2026-08-26, device 101: readMsP50 246, and a day-wide timeline at
    // 83 px/s is ~8 964 ms of timeline per ms of wall clock.
    const d = scrubLeadDecision(8_964, 246)
    expect(d.saturated).toBe(true)
    expect(d.leadMs).toBe(0)
  })

  it('keeps the lead on a drag slow enough for it to land', () => {
    // The ceiling must not disable the feature it bounds — this is where the
    // measured −55% / −71% staleness came from.
    const d = scrubLeadDecision(40, 246)
    expect(d.saturated).toBe(false)
    expect(d.leadMs).toBe(9_840)
  })

  it('leads backwards too — the direction is the sign, not a special case', () => {
    expect(scrubLeadDecision(-40, 246).leadMs).toBe(-9_840)
  })

  it('saturates on either side of the ceiling, symmetrically', () => {
    const justUnder = SCRUB_LEAD_MAX_MS / 246
    expect(scrubLeadDecision(justUnder, 246).saturated).toBe(false)
    expect(scrubLeadDecision(-(justUnder * 2), 246).saturated).toBe(true)
  })

  it('an UNKNOWN velocity is not saturation — the first ticks keep speculating', () => {
    // Getting this backwards would switch speculation off at the start of every
    // drag, which is exactly when it is worth most.
    expect(scrubLeadDecision(null, 246)).toEqual({ leadMs: 0, saturated: false })
    expect(scrubLeadDecision(8_964, null)).toEqual({ leadMs: 0, saturated: false })
  })
})
