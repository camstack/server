/**
 * Unified event-kind taxonomy dictionary.
 *
 * Covers:
 *  - dictionary round-trip: every kind has color + iconId + labelKey
 *  - macro/sub structure (parentKind ⇒ level; macro ⇒ null parent)
 *  - reverse COCO → sub derivation (vehicle → car/truck/bus/…)
 *  - EVENT_KIND_BY_CAP derives from the taxonomy (single source, no dup)
 */
import { describe, expect, it } from 'vitest'
import {
  EVENT_TAXONOMY,
  colorForKind,
  getTaxonomyEntry,
  subKindsOf,
} from '../catalogs/event-taxonomy.js'
import { COCO_TO_MACRO } from '../catalogs/coco-classmap.js'
import { EVENT_KIND_BY_CAP } from '../capabilities/sensor-event-kinds.js'

describe('EVENT_TAXONOMY', () => {
  it('every kind carries color + iconId + labelKey + label', () => {
    for (const entry of Object.values(EVENT_TAXONOMY)) {
      expect(entry.color, entry.kind).toMatch(/^#|^rgb/)
      expect(entry.iconId.length, entry.kind).toBeGreaterThan(0)
      expect(entry.labelKey, entry.kind).toContain('eventKind.')
      expect(entry.label.length, entry.kind).toBeGreaterThan(0)
    }
  })

  it('level is consistent with parentKind', () => {
    for (const entry of Object.values(EVENT_TAXONOMY)) {
      if (entry.parentKind === null) expect(entry.level, entry.kind).toBe('macro')
      else expect(entry.level, entry.kind).toBe('sub')
    }
  })

  it('every sub points at a macro that exists and is level=macro', () => {
    for (const entry of Object.values(EVENT_TAXONOMY)) {
      if (entry.parentKind === null) continue
      const parent = EVENT_TAXONOMY[entry.parentKind]
      expect(parent, `${entry.kind} → ${entry.parentKind}`).toBeDefined()
      expect(parent?.level).toBe('macro')
    }
  })

  it('derives vehicle/animal subs from the reverse of COCO_TO_MACRO', () => {
    const vehicleSubs = new Set(subKindsOf('vehicle').map((e) => e.kind))
    expect(vehicleSubs.has('car')).toBe(true)
    expect(vehicleSubs.has('truck')).toBe(true)
    expect(vehicleSubs.has('bus')).toBe(true)
    // Every COCO class mapped to vehicle/animal appears as a sub.
    for (const [cocoClass, macro] of Object.entries(COCO_TO_MACRO.mapping)) {
      if (macro !== 'vehicle' && macro !== 'animal') continue
      expect(EVENT_TAXONOMY[cocoClass]?.parentKind, cocoClass).toBe(macro)
    }
    // person is a leaf macro (no subs in v1).
    expect(subKindsOf('person')).toHaveLength(0)
  })

  it('namespaces audio subs so they never collide with detection subs', () => {
    // detection 'dog' (animal) and audio dog exist as distinct kinds.
    expect(EVENT_TAXONOMY.dog?.parentKind).toBe('animal')
    expect(EVENT_TAXONOMY['audio-dog']?.parentKind).toBe('audio')
  })

  it('colorForKind falls back to the default for unknown kinds', () => {
    expect(colorForKind('vehicle')).toBe(EVENT_TAXONOMY.vehicle?.color)
    expect(colorForKind('nope-not-a-kind')).toMatch(/^#/)
  })

  it('getTaxonomyEntry returns undefined for an unknown kind', () => {
    expect(getTaxonomyEntry('nope')).toBeUndefined()
  })
})

describe('EVENT_KIND_BY_CAP', () => {
  it('covers every sensor + control cap and derives from the taxonomy', () => {
    // A passive sensor.
    expect(EVENT_KIND_BY_CAP.contact).toMatchObject({
      kind: 'contact',
      category: 'sensor',
      parentKind: 'sensor',
      level: 'sub',
      icon: 'door',
    })
    // motion cap maps to the motion-sensor kind (not the camera built-in).
    expect(EVENT_KIND_BY_CAP.motion?.kind).toBe('motion-sensor')
    // Controls.
    expect(EVENT_KIND_BY_CAP['lock-control']).toMatchObject({
      kind: 'lock',
      category: 'control',
      parentKind: 'control',
    })
    expect(EVENT_KIND_BY_CAP.switch?.category).toBe('control')
    expect(EVENT_KIND_BY_CAP.button?.category).toBe('control')
    expect(EVENT_KIND_BY_CAP.doorbell?.kind).toBe('doorbell')
  })

  it('color/iconId/labelKey equal the taxonomy entry (single source)', () => {
    for (const desc of Object.values(EVENT_KIND_BY_CAP)) {
      const t = EVENT_TAXONOMY[desc.kind]
      expect(t).toBeDefined()
      expect(desc.color).toBe(t?.color)
      expect(desc.iconId).toBe(t?.iconId)
      expect(desc.labelKey).toBe(t?.labelKey)
    }
  })
})
