import { describe, it, expect } from 'vitest'
import { processEvent } from '../ha-events.js'
import type { HaCompactUpdate, HaEntityState } from '../ha-types.js'
import type { HaEntityStateMap } from '../ha-events.js'

describe('processEvent — HA subscribe_entities reducer', () => {
  it('returns an empty map for an empty update applied to empty state', () => {
    const result = processEvent({}, {})
    expect(result).toEqual({})
  })

  describe('additions (updates.a)', () => {
    it('adds a new entity with string context shorthand', () => {
      const update: HaCompactUpdate = {
        a: {
          'light.kitchen': {
            s: 'on',
            a: { brightness: 200, friendly_name: 'Kitchen' },
            c: 'abc',
            lc: 1700000000,
          },
        },
      }
      const result = processEvent({}, update)
      expect(result['light.kitchen']).toEqual({
        entity_id: 'light.kitchen',
        state: 'on',
        attributes: { brightness: 200, friendly_name: 'Kitchen' },
        context: { id: 'abc', parent_id: null, user_id: null },
        last_changed: new Date(1700000000 * 1000).toISOString(),
        last_updated: new Date(1700000000 * 1000).toISOString(),
      })
    })

    it('adds a new entity with full context envelope', () => {
      const update: HaCompactUpdate = {
        a: {
          'switch.fan': {
            s: 'off',
            c: { id: 'ctx', parent_id: 'p', user_id: 'u' },
            lc: 1700000000,
            lu: 1700000005,
          },
        },
      }
      const result = processEvent({}, update)
      expect(result['switch.fan']?.context).toEqual({ id: 'ctx', parent_id: 'p', user_id: 'u' })
      expect(result['switch.fan']?.last_changed).toBe(new Date(1700000000 * 1000).toISOString())
      expect(result['switch.fan']?.last_updated).toBe(new Date(1700000005 * 1000).toISOString())
    })

    it('handles a missing `a` attributes object via empty default', () => {
      const update: HaCompactUpdate = {
        a: { 'binary_sensor.door': { s: 'on', c: 'x', lc: 1 } },
      }
      const result = processEvent({}, update)
      expect(result['binary_sensor.door']?.attributes).toEqual({})
    })

    it('does not mutate the input state map', () => {
      const baseline: HaEntityStateMap = {}
      processEvent(baseline, {
        a: { 'light.x': { s: 'on', c: 'y', lc: 1 } },
      })
      expect(baseline).toEqual({})
    })
  })

  describe('removals (updates.r)', () => {
    it('removes the listed entities and leaves the others intact', () => {
      const existing: HaEntityStateMap = {
        'light.a': sampleState('light.a', 'on'),
        'light.b': sampleState('light.b', 'off'),
        'light.c': sampleState('light.c', 'on'),
      }
      const result = processEvent(existing, { r: ['light.a', 'light.c'] })
      expect(Object.keys(result)).toEqual(['light.b'])
    })

    it('does not mutate the input map', () => {
      const existing: HaEntityStateMap = { 'light.a': sampleState('light.a', 'on') }
      processEvent(existing, { r: ['light.a'] })
      expect(Object.keys(existing)).toEqual(['light.a'])
    })
  })

  describe('changes (updates.c)', () => {
    it('updates state via toAdd.s', () => {
      const existing: HaEntityStateMap = { 'light.x': sampleState('light.x', 'on') }
      const result = processEvent(existing, {
        c: { 'light.x': { '+': { s: 'off' } } },
      })
      expect(result['light.x']?.state).toBe('off')
    })

    it('merges new attributes into the existing map', () => {
      const existing: HaEntityStateMap = {
        'light.x': {
          ...sampleState('light.x', 'on'),
          attributes: { brightness: 100, color: 'red' },
        },
      }
      const result = processEvent(existing, {
        c: { 'light.x': { '+': { a: { brightness: 200 } } } },
      })
      expect(result['light.x']?.attributes).toEqual({ brightness: 200, color: 'red' })
    })

    it('removes attribute keys via toRemove.a', () => {
      const existing: HaEntityStateMap = {
        'light.x': {
          ...sampleState('light.x', 'on'),
          attributes: { brightness: 100, color: 'red', temp: 350 },
        },
      }
      const result = processEvent(existing, {
        c: { 'light.x': { '-': { a: ['color', 'temp'] } } },
      })
      expect(result['light.x']?.attributes).toEqual({ brightness: 100 })
    })

    it('updates last_changed AND last_updated when toAdd.lc is present', () => {
      const existing: HaEntityStateMap = { 'light.x': sampleState('light.x', 'on') }
      const result = processEvent(existing, {
        c: { 'light.x': { '+': { lc: 1800000000 } } },
      })
      expect(result['light.x']?.last_changed).toBe(new Date(1800000000 * 1000).toISOString())
      expect(result['light.x']?.last_updated).toBe(new Date(1800000000 * 1000).toISOString())
    })

    it('updates only last_updated when toAdd.lu is present without lc', () => {
      const existing: HaEntityStateMap = { 'light.x': sampleState('light.x', 'on') }
      const result = processEvent(existing, {
        c: { 'light.x': { '+': { lu: 1800000000 } } },
      })
      expect(result['light.x']?.last_changed).toBe(existing['light.x']!.last_changed)
      expect(result['light.x']?.last_updated).toBe(new Date(1800000000 * 1000).toISOString())
    })

    it('ignores changes for unknown entities (no-op)', () => {
      const existing: HaEntityStateMap = { 'light.x': sampleState('light.x', 'on') }
      const result = processEvent(existing, {
        c: { 'light.ghost': { '+': { s: 'off' } } },
      })
      expect(result).toEqual(existing)
    })

    it('produces a new attribute object reference when attributes change', () => {
      const existing: HaEntityStateMap = {
        'light.x': { ...sampleState('light.x', 'on'), attributes: { brightness: 100 } },
      }
      const result = processEvent(existing, {
        c: { 'light.x': { '+': { a: { brightness: 200 } } } },
      })
      expect(result['light.x']?.attributes).not.toBe(existing['light.x']!.attributes)
    })

    it('reuses the previous attribute reference when no attribute change occurred', () => {
      const existing: HaEntityStateMap = {
        'light.x': { ...sampleState('light.x', 'on'), attributes: { brightness: 100 } },
      }
      const result = processEvent(existing, {
        c: { 'light.x': { '+': { s: 'off' } } },
      })
      expect(result['light.x']?.attributes).toBe(existing['light.x']!.attributes)
    })

    it('merges context shorthand id without losing parent_id / user_id', () => {
      const existing: HaEntityStateMap = {
        'light.x': {
          ...sampleState('light.x', 'on'),
          context: { id: 'old', parent_id: 'p', user_id: 'u' },
        },
      }
      const result = processEvent(existing, {
        c: { 'light.x': { '+': { c: 'new-ctx' } } },
      })
      expect(result['light.x']?.context).toEqual({ id: 'new-ctx', parent_id: 'p', user_id: 'u' })
    })
  })

  describe('composite updates (add + remove + change in one event)', () => {
    it('applies additions, removals, and changes in a single pass', () => {
      const existing: HaEntityStateMap = {
        'light.kept': sampleState('light.kept', 'on'),
        'light.gone': sampleState('light.gone', 'off'),
      }
      const update: HaCompactUpdate = {
        a: { 'light.new': { s: 'on', c: 'x', lc: 1700000100 } },
        r: ['light.gone'],
        c: { 'light.kept': { '+': { s: 'off' } } },
      }
      const result = processEvent(existing, update)
      expect(Object.keys(result).toSorted()).toEqual(['light.kept', 'light.new'])
      expect(result['light.kept']?.state).toBe('off')
      expect(result['light.new']?.state).toBe('on')
    })
  })
})

function sampleState(entityId: string, state: string): HaEntityState {
  return {
    entity_id: entityId,
    state,
    attributes: {},
    context: { id: 'ctx', parent_id: null, user_id: null },
    last_changed: '2026-05-31T10:00:00.000Z',
    last_updated: '2026-05-31T10:00:00.000Z',
  }
}
