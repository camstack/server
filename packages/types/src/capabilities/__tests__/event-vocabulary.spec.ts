import { describe, expect, it } from 'vitest'
import { EventEmitterStatusSchema, EventFireSchema } from '../event-emitter.cap.js'
import {
  eventTypesOfVocabulary,
  findVocabularyEntry,
  plainEventVocabulary,
  readEventVocabulary,
  type EventVocabularyEntry,
} from '../event-vocabulary.js'

const BUTTON_1 = { id: '1', label: 'Button 1' }
const BUTTON_2 = { id: '2', label: 'Button 2' }

const REMOTE: readonly EventVocabularyEntry[] = [
  { id: 'PRESS_SHORT', source: BUTTON_1, label: 'Short press', kind: 'press' },
  { id: 'PRESS_LONG', source: BUTTON_1, label: 'Long press', kind: 'long-press' },
  { id: 'PRESS_SHORT', source: BUTTON_2, label: 'Short press', kind: 'press' },
]

describe('event-emitter status, the declared vocabulary (#503)', () => {
  it('parses a status written before the vocabulary existed, as an empty one', () => {
    const bare = { eventTypes: ['PRESS_SHORT'], lastEvent: null, eventCountSinceStart: 0 }
    const parsed = EventEmitterStatusSchema.parse(bare)
    expect(parsed.vocabulary).toEqual([])
    expect(readEventVocabulary(parsed)).toEqual([{ id: 'PRESS_SHORT', label: 'PRESS_SHORT' }])
  })

  it('keeps a declared vocabulary, sources included', () => {
    const bare = { eventTypes: ['PRESS_SHORT'], lastEvent: null, eventCountSinceStart: 0 }
    const parsed = EventEmitterStatusSchema.parse({ ...bare, vocabulary: [...REMOTE] })
    expect(parsed.vocabulary).toEqual(REMOTE)
  })

  it('refuses a kind outside the shared list and an entry with no label', () => {
    const base = { eventTypes: [], lastEvent: null, eventCountSinceStart: 0 }
    const wrongKind = { ...base, vocabulary: [{ id: 'X', label: 'X', kind: 'triple-press' }] }
    const noLabel = { ...base, vocabulary: [{ id: 'X', label: '' }] }
    expect(EventEmitterStatusSchema.safeParse(wrongKind).success).toBe(false)
    expect(EventEmitterStatusSchema.safeParse(noLabel).success).toBe(false)
  })

  it('carries the source of a fire, and a fire without one still parses', () => {
    const fire = { deviceId: 7, eventType: 'PRESS_SHORT', data: null, timestamp: 1, seq: 1 }
    expect(EventFireSchema.parse({ ...fire, sourceId: '2' }).sourceId).toBe('2')
    expect(EventFireSchema.parse(fire).sourceId).toBeUndefined()
  })
})

describe('plainEventVocabulary', () => {
  it('declares one entry per native token, verbatim, labelled with the token', () => {
    expect(plainEventVocabulary(['press_short', 'Hold'])).toEqual([
      { id: 'press_short', label: 'press_short' },
      { id: 'Hold', label: 'Hold' },
    ])
  })

  it('drops a repeated and an empty token', () => {
    expect(plainEventVocabulary(['a', '', 'a']).map((entry) => entry.id)).toEqual(['a'])
  })
})

describe('eventTypesOfVocabulary', () => {
  it('lists each native token once, in declaration order, across sources', () => {
    expect(eventTypesOfVocabulary(REMOTE)).toEqual(['PRESS_SHORT', 'PRESS_LONG'])
  })
})

describe('readEventVocabulary', () => {
  it('returns the declared vocabulary', () => {
    expect(readEventVocabulary({ eventTypes: ['PRESS_SHORT'], vocabulary: [...REMOTE] })).toEqual(
      REMOTE,
    )
  })

  it('falls back to the plain tokens for a status written before the vocabulary existed', () => {
    expect(readEventVocabulary({ eventTypes: ['a', 'b'] })).toEqual([
      { id: 'a', label: 'a' },
      { id: 'b', label: 'b' },
    ])
  })

  it('falls back to the plain tokens when the declared vocabulary is empty', () => {
    expect(readEventVocabulary({ eventTypes: ['a'], vocabulary: [] })).toEqual([
      { id: 'a', label: 'a' },
    ])
  })
})

describe('findVocabularyEntry', () => {
  it('matches the token AND the source, so two buttons with one token stay apart', () => {
    expect(findVocabularyEntry(REMOTE, 'PRESS_SHORT', '2')?.source?.label).toBe('Button 2')
    expect(findVocabularyEntry(REMOTE, 'PRESS_LONG', '2')).toBeUndefined()
  })

  it('matches a sourceless entry only for a fire that names no source', () => {
    const flat = plainEventVocabulary(['tap'])
    expect(findVocabularyEntry(flat, 'tap')?.id).toBe('tap')
    expect(findVocabularyEntry(flat, 'tap', '3')).toBeUndefined()
    expect(findVocabularyEntry(REMOTE, 'PRESS_SHORT')).toBeUndefined()
  })
})
