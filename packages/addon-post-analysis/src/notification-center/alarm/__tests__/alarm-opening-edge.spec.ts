import { describe, expect, it } from 'vitest'
import { sensorEdgeOf } from '../alarm-opening-edge.js'

describe('sensorEdgeOf', () => {
  it.each([
    ['contact', { entryOpen: true, lastChangedAt: 1 }, 'opening'],
    ['contact', { entryOpen: false, lastChangedAt: 1 }, 'closing'],
    ['lock', { state: 'unlocking' }, 'opening'],
    ['lock', { state: 'unlocked' }, 'opening'],
    ['lock', { state: 'locking' }, 'closing'],
    ['lock', { state: 'locked' }, 'closing'],
    ['lock', { state: 'jammed' }, 'neither'],
    ['cover', { state: 'opening', position: 20 }, 'opening'],
    ['cover', { state: 'open', position: 100 }, 'opening'],
    ['cover', { state: 'closing', position: 60 }, 'closing'],
    ['cover', { state: 'closed', position: 0 }, 'closing'],
    ['cover', { state: 'stopped', position: 40 }, 'neither'],
  ])('%s %j → %s', (kind, value, edge) => {
    expect(sensorEdgeOf(kind, value)).toBe(edge)
  })

  it('a kind with no opening meaning has no edge', () => {
    expect(sensorEdgeOf('motion-sensor', { detected: false })).toBeUndefined()
    expect(sensorEdgeOf('doorbell', { lastPressAt: 1 })).toBeUndefined()
    // The CAP name is not the event kind: `lock-control` rows carry kind `lock`.
    expect(sensorEdgeOf('lock-control', { state: 'locked' })).toBeUndefined()
  })

  it('an unreadable slice has no edge — never guessed', () => {
    expect(sensorEdgeOf('contact', null)).toBeUndefined()
    expect(sensorEdgeOf('contact', { entryOpen: 'yes' })).toBeUndefined()
    expect(sensorEdgeOf('cover', { state: 'weird' })).toBeUndefined()
    expect(sensorEdgeOf('lock', {})).toBeUndefined()
  })
})
