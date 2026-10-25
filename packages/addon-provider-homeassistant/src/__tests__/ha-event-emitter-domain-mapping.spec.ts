import { describe, it, expect } from 'vitest'
import { DeviceType } from '@camstack/types'
import { mapHaEntityToCamStack } from '../ha-domain-mapping.js'

describe('ha-domain-mapping — event.* (Phase EE-2)', () => {
  it('event.* → DeviceType.EventEmitter, capabilities: [event-emitter]', () => {
    const m = mapHaEntityToCamStack({
      domain: 'event',
      deviceClass: 'button',
      attributes: {
        event_types: ['press_short', 'press_long', 'press_long_start', 'press_long_release'],
        event_type: 'press_short',
      },
    })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.EventEmitter)
    expect(m?.role).toBeNull()
    expect(m?.capabilities).toEqual(['event-emitter'])
  })

  it('event.* with no attributes still maps (vocabulary flows live)', () => {
    const m = mapHaEntityToCamStack({ domain: 'event', deviceClass: null, attributes: {} })
    expect(m?.deviceType).toBe(DeviceType.EventEmitter)
    expect(m?.capabilities).toEqual(['event-emitter'])
  })
})
