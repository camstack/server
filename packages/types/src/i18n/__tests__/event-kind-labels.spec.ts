import { describe, expect, it } from 'vitest'
import { AUDIO_MACRO_LABELS } from '../../catalogs/audio-classmap.js'
import { COCO_TO_MACRO } from '../../catalogs/coco-classmap.js'
import { EVENT_TAXONOMY } from '../../catalogs/event-taxonomy.js'
import {
  EVENT_KIND_LABEL_KEYS,
  EVENT_KIND_LABELS,
  eventKindLabel,
  isEventKindLabelKey,
} from '../event-kind-labels.js'

describe('EVENT_KIND_LABELS', () => {
  it('has an English AND an Italian label for every key, never empty', () => {
    for (const key of EVENT_KIND_LABEL_KEYS) {
      const entry = EVENT_KIND_LABELS[key]
      expect(entry.en.length, `${key}.en`).toBeGreaterThan(0)
      expect(entry.it.length, `${key}.it`).toBeGreaterThan(0)
    }
  })

  it('covers every EVENT_TAXONOMY kind — and no orphan keys', () => {
    const taxonomy = new Set(Object.keys(EVENT_TAXONOMY))
    const labels = new Set<string>(EVENT_KIND_LABEL_KEYS)
    for (const kind of taxonomy) {
      expect(labels.has(kind), `missing label for taxonomy kind ${kind}`).toBe(true)
    }
    for (const key of labels) {
      expect(taxonomy.has(key), `orphan label key ${key}`).toBe(true)
    }
  })

  it('English matches EVENT_TAXONOMY.label (single EN source of truth)', () => {
    for (const key of EVENT_KIND_LABEL_KEYS) {
      const entry = EVENT_TAXONOMY[key]
      expect(entry, key).toBeDefined()
      expect(EVENT_KIND_LABELS[key].en, key).toBe(entry?.label)
    }
  })

  it('covers every COCO vehicle/animal sub and every audio macro id', () => {
    for (const [cocoClass, macro] of Object.entries(COCO_TO_MACRO.mapping)) {
      if (macro !== 'vehicle' && macro !== 'animal') continue
      expect(isEventKindLabelKey(cocoClass), cocoClass).toBe(true)
    }
    for (const audio of AUDIO_MACRO_LABELS) {
      expect(isEventKindLabelKey(`audio-${audio.id}`), audio.id).toBe(true)
    }
  })
})

describe('eventKindLabel', () => {
  it('answers in the asked locale', () => {
    expect(eventKindLabel('cat', 'en')).toBe('Cat')
    expect(eventKindLabel('cat', 'it')).toBe('Gatto')
    expect(eventKindLabel('animal', 'it')).toBe('Animale')
    expect(eventKindLabel('audio-dog', 'it')).toBe('Cane')
  })

  it('normalises case before lookup', () => {
    expect(eventKindLabel('  Cat ', 'it')).toBe('Gatto')
  })

  it('falls back to the raw word for an unknown kind', () => {
    expect(eventKindLabel('forklift', 'en')).toBe('forklift')
    expect(eventKindLabel('', 'it')).toBe('')
  })

  it('never resolves Object.prototype names', () => {
    expect(eventKindLabel('toString', 'en')).toBe('toString')
    expect(isEventKindLabelKey('constructor')).toBe(false)
  })
})
