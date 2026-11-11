/**
 * The `device-fired` row's model: the device's vocabulary read as buttons and
 * events, what a pick writes on the row, and what the row still names that the
 * device no longer declares.
 */
import type { DeviceFiredLeaf } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  firedEvents,
  firedSources,
  firedVocabularyOf,
  staleFiredPicks,
  withFiredDevice,
  withFiredEvent,
  withFiredSource,
} from '../fired-model'

const button = (n: string) => ({ id: n, label: `Button ${n}` })
const VOCABULARY = [
  { id: 'PRESS_SHORT', source: button('1'), label: 'Short press', kind: 'press' as const },
  { id: 'PRESS_LONG', source: button('1'), label: 'Long press', kind: 'long-press' as const },
  { id: 'PRESS_SHORT', source: button('2'), label: 'Short press', kind: 'press' as const },
  { id: 'TILT', label: 'Tilted' },
]
const LEAF: DeviceFiredLeaf = { kind: 'device-fired', id: 't1', deviceId: 40 }

describe('firedVocabularyOf', () => {
  const status = { eventTypes: ['a'], vocabulary: [], lastEvent: null, eventCountSinceStart: 0 }

  it('is pending until the read answers, and unknown when it failed or is unreadable', () => {
    expect(firedVocabularyOf({ status: 'pending', data: undefined }).kind).toBe('pending')
    expect(firedVocabularyOf({ status: 'error', data: undefined }).kind).toBe('unknown')
    expect(firedVocabularyOf({ status: 'success', data: { nope: 1 } }).kind).toBe('unknown')
    expect(firedVocabularyOf({ status: 'success', data: undefined }).kind).toBe('unknown')
  })

  it('a status with no vocabulary still offers its plain tokens', () => {
    const state = firedVocabularyOf({ status: 'success', data: status })
    expect(state.kind === 'known' && state.vocabulary.map((e) => e.id)).toEqual(['a'])
  })
})

describe('firedSources / firedEvents', () => {
  it('lists each button once, in the order the device declares them', () => {
    expect(firedSources(VOCABULARY)).toEqual([button('1'), button('2')])
  })

  it('offers the events of the picked button, or every event once when none is picked', () => {
    expect(firedEvents(VOCABULARY, '2').map((e) => e.id)).toEqual(['PRESS_SHORT'])
    expect(firedEvents(VOCABULARY, undefined).map((e) => e.id)).toEqual([
      'PRESS_SHORT',
      'PRESS_LONG',
      'TILT',
    ])
  })
})

describe('what a pick writes', () => {
  it('a new device clears the button and the event, and keeps the row id', () => {
    const picked: DeviceFiredLeaf = { ...LEAF, sourceIds: ['1'], eventIds: ['PRESS_LONG'] }
    expect(withFiredDevice(picked, 41)).toEqual({ kind: 'device-fired', id: 't1', deviceId: 41 })
  })

  it('a button is one source; "any" removes the list', () => {
    expect(withFiredSource(LEAF, '2', VOCABULARY).sourceIds).toEqual(['2'])
    expect(
      'sourceIds' in withFiredSource({ ...LEAF, sourceIds: ['2'] }, undefined, VOCABULARY),
    ).toBe(false)
  })

  it('changing the button drops an event that button does not declare, and keeps one it does', () => {
    const long: DeviceFiredLeaf = { ...LEAF, sourceIds: ['1'], eventIds: ['PRESS_LONG'] }
    expect('eventIds' in withFiredSource(long, '2', VOCABULARY)).toBe(false)
    const short: DeviceFiredLeaf = { ...LEAF, sourceIds: ['1'], eventIds: ['PRESS_SHORT'] }
    expect(withFiredSource(short, '2', VOCABULARY).eventIds).toEqual(['PRESS_SHORT'])
  })

  it('an event is one token; "any" removes the list; kinds and match written elsewhere survive', () => {
    const byHand: DeviceFiredLeaf = {
      ...LEAF,
      kinds: ['long-press'],
      match: [{ path: 'a', equals: 1 }],
    }
    const next = withFiredEvent(byHand, 'PRESS_LONG')
    expect(next).toMatchObject({ eventIds: ['PRESS_LONG'], kinds: ['long-press'] })
    expect(next.match).toEqual([{ path: 'a', equals: 1 }])
    expect('eventIds' in withFiredEvent(next, undefined)).toBe(false)
  })
})

describe('staleFiredPicks', () => {
  it('names a button or an event the device no longer declares, and nothing when all are there', () => {
    const leaf: DeviceFiredLeaf = { ...LEAF, sourceIds: ['1', '9'], eventIds: ['GONE', 'TILT'] }
    expect(staleFiredPicks(leaf, VOCABULARY)).toEqual({ sourceIds: ['9'], eventIds: ['GONE'] })
    expect(staleFiredPicks({ ...LEAF, sourceIds: ['1'] }, VOCABULARY)).toEqual({
      sourceIds: [],
      eventIds: [],
    })
  })
})
