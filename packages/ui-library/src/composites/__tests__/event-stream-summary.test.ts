/**
 * The events tab's pure helpers. `ProviderMotion` carries the motion payload
 * (`detected`, D673) — a read of any other field renders every raw push as a stop.
 * It is also the camera's raw ~1 Hz push, so the default "All" view leaves it out
 * (the bridge's `MotionOnMotionChanged` is the one an operator scans).
 */
import { EventCategory } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { DEFAULT_EVENT_CATEGORIES, summarizeEvent } from '../event-stream'

describe('event stream helpers', () => {
  it('renders a ProviderMotion push from `detected`', () => {
    expect(summarizeEvent(EventCategory.ProviderMotion, { detected: true })).toBe('motion start')
    expect(summarizeEvent(EventCategory.ProviderMotion, { detected: false })).toBe('motion stop')
  })

  it('renders a session attach by its real trigger and a detach as the end of the session', () => {
    const cat = EventCategory.DetectionPhaseTransition
    expect(
      summarizeEvent(cat, {
        from: 'watching',
        to: 'active',
        cause: 'attach',
        source: 'onboard',
        triggeredBy: { kind: 'camera' },
      }),
    ).toBe('Detection session started by onboard motion — phase active')
    expect(
      summarizeEvent(cat, {
        to: 'active',
        cause: 'attach',
        source: 'onboard',
        triggeredBy: { kind: 'sensor', deviceId: 3299 },
        sensorName: 'PIR front door',
      }),
    ).toBe('Detection session started by PIR front door motion — phase active')
    expect(
      summarizeEvent(cat, {
        to: 'active',
        cause: 'attach',
        source: 'onboard',
        triggeredBy: { kind: 'sensor', deviceId: 3299 },
      }),
    ).toBe('Detection session started by sensor #3299 motion — phase active')
    // No trigger sent (occupancy burst, older orchestrator): never a guessed source.
    expect(summarizeEvent(cat, { from: 'watching', to: 'active', cause: 'attach' })).toBe(
      'Detection session started — phase active',
    )
    expect(summarizeEvent(cat, { from: 'active', to: 'watching', cause: 'detach' })).toBe(
      'Detection session ended — phase watching',
    )
    expect(
      summarizeEvent(cat, {
        from: 'watching',
        to: 'active',
        cause: 'motion',
        source: 'onboard',
        cooldownMs: 30_000,
      }),
    ).toBe('Motion detected — phase active (onboard, 30s cooldown)')
  })

  it('keeps the raw ProviderMotion push out of the default view', () => {
    expect(DEFAULT_EVENT_CATEGORIES).not.toContain(EventCategory.ProviderMotion)
    expect(DEFAULT_EVENT_CATEGORIES).toContain(EventCategory.MotionOnMotionChanged)
  })
})
