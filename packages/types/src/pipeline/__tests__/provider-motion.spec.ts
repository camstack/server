import { describe, expect, it } from 'vitest'
import { EventCategory } from '../../enums/event-category.js'
import { ProviderMotionDataSchema, providerMotionEvent } from '../provider-motion.js'

describe('providerMotionEvent (D673)', () => {
  it('is a ProviderMotion event carrying the motion shape, never a trigger', () => {
    const event = providerMotionEvent(
      { type: 'device', id: 103, addonId: 'provider-reolink', deviceId: 103 },
      { deviceId: 103, detected: true, timestamp: 1_790_000_000_000, source: 'onboard' },
    )
    expect(event.category).toBe(EventCategory.ProviderMotion)
    expect(event.data).toEqual({
      deviceId: 103,
      detected: true,
      timestamp: 1_790_000_000_000,
      source: 'onboard',
    })
  })
  it('the parse drops a triggeredBy a provider might send', () => {
    const parsed = ProviderMotionDataSchema.parse({
      deviceId: 103,
      detected: true,
      timestamp: 1,
      source: 'onboard',
      triggeredBy: { kind: 'sensor', deviceId: 3299 },
    })
    expect('triggeredBy' in parsed).toBe(false)
  })
})
