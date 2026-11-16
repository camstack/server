import { describe, expect, it } from 'vitest'
import { classifyDeleteRefusal } from '../location-delete-refusal'

describe('classifyDeleteRefusal', () => {
  it('recognises the occupancy refusal, also when the transport wraps the message', () => {
    expect(
      classifyDeleteRefusal(
        new Error(
          'Storage location "recordings:old" still holds data — drain it first (storage migration / relocate), or pass force',
        ),
      ),
    ).toBe('holds-data')
  })
  it('recognises the unverifiable refusal', () => {
    expect(
      classifyDeleteRefusal(
        new Error('Storage location "x" could not be checked for remaining data (unreachable)'),
      ),
    ).toBe('unverifiable')
  })
  it('does not treat any other error as overridable', () => {
    expect(classifyDeleteRefusal(new Error('network down'))).toBeNull()
    expect(classifyDeleteRefusal('boom')).toBeNull()
  })
})
