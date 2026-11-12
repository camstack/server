import { describe, expect, it } from 'vitest'
import { groupWithinSecOf } from '../group-within.js'

describe('groupWithinSecOf', () => {
  it('waits 5s for a system rule that never set the field', () => {
    expect(groupWithinSecOf({ delivery: 'system-event' })).toBe(5)
  })

  it('sends a detection rule at once when the field is absent', () => {
    expect(groupWithinSecOf({ delivery: 'immediate' })).toBe(0)
    expect(groupWithinSecOf({ delivery: 'track-end' })).toBe(0)
    expect(groupWithinSecOf({ delivery: 'device-event' })).toBe(0)
  })

  it('honours an explicit 0 on a system rule and an explicit window on a detection', () => {
    expect(groupWithinSecOf({ delivery: 'system-event', groupWithinSec: 0 })).toBe(0)
    expect(groupWithinSecOf({ delivery: 'immediate', groupWithinSec: 12 })).toBe(12)
  })
})
