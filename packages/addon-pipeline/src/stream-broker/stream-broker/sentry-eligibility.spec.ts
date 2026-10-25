import { describe, expect, it } from 'vitest'
import { sentryEligible } from './sentry-eligibility.js'

describe('sentryEligible', () => {
  it('a battery camera that declares signals is in', () => {
    expect(sentryEligible({ batteryOperated: true, declaresSignals: true })).toEqual({
      eligible: true,
    })
  })

  it('a MAINS camera is out — it has nothing to save by sleeping', () => {
    expect(sentryEligible({ batteryOperated: false, declaresSignals: true })).toEqual({
      eligible: false,
      reason: 'not-battery',
    })
  })

  it('a battery camera with NO signals cap is out — nothing could wake it', () => {
    // A sentry consumer would hold a session open against a camera that can
    // never come up: a stream that is permanently a photograph.
    expect(sentryEligible({ batteryOperated: true, declaresSignals: false })).toEqual({
      eligible: false,
      reason: 'no-signals-cap',
    })
  })

  it('an UNANSWERABLE question is a NO, on either term', () => {
    // A device the registry cannot describe is not a battery camera with
    // signals; it is a device nobody could describe. Reading that as yes is how
    // a mains camera ends up in a wake-hold loop.
    expect(sentryEligible({ batteryOperated: null, declaresSignals: true })).toEqual({
      eligible: false,
      reason: 'unknown',
    })
    expect(sentryEligible({ batteryOperated: true, declaresSignals: null })).toEqual({
      eligible: false,
      reason: 'unknown',
    })
  })
})
