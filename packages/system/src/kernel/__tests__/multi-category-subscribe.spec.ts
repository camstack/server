/**
 * A subscriber that asks for N categories must be REGISTERED under N keys.
 *
 * `EventFilter.category` has always accepted an array, and the whole delivery
 * path has always thrown all but the first element away: `extractCategoryPattern`
 * returned `String(cat[0])`, the subscriber map got one key, and on a UDS child
 * bus that one key is ALSO what the parent is told this child wants — so the
 * parent never forwarded the rest across the process boundary. Ten categories
 * in, one category delivered, no error and no log.
 *
 * The second property here is the one the fix could easily get wrong: a
 * subscriber registered under several keys must still receive an event ONCE.
 * `deliverShared` walks every matching pattern, so `{ category: ['device.*',
 * 'device.online'] }` reaches the same entry twice unless delivery dedups by
 * ENTRY rather than by key.
 */
import type { SystemEvent } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  createSharedBusState,
  deliverShared,
  extractCategoryPattern,
  extractCategoryPatterns,
  registerSubscriber,
} from '../moleculer/event-bus-core.js'

function makeEvent(category: string): SystemEvent {
  return {
    id: `evt-${category}`,
    timestamp: new Date(0),
    source: { type: 'core', id: 'test' },
    category,
    data: {},
  }
}

describe('extractCategoryPatterns', () => {
  it('returns every category of an array filter, not just the first', () => {
    expect(extractCategoryPatterns({ category: ['device.online', 'device.offline'] })).toEqual([
      'device.online',
      'device.offline',
    ])
  })

  it('agrees with the single-pattern reader on every non-array shape', () => {
    const filters = [
      'device.online',
      { category: 'device.online' },
      { category: 'device.*' },
      { deviceId: 7 },
      {},
    ] as const
    for (const filter of filters) {
      expect(extractCategoryPatterns(filter)).toEqual([extractCategoryPattern(filter)])
    }
  })

  it('treats an EMPTY array as the wildcard the single reader already treats it as', () => {
    expect(extractCategoryPatterns({ category: [] })).toEqual(['*'])
  })

  it('drops duplicates — one key per category, however the filter spells it', () => {
    expect(extractCategoryPatterns({ category: ['device.online', 'device.online'] })).toEqual([
      'device.online',
    ])
  })
})

describe('registerSubscriber', () => {
  it('keys one entry under EVERY category it asked for, and delivers each', () => {
    const state = createSharedBusState()
    const seen: string[] = []
    registerSubscriber(
      state,
      { category: ['device.online', 'device.offline', 'agent.offline'] },
      (event) => {
        seen.push(event.category)
      },
    )

    expect([...state.handlers.keys()].toSorted()).toEqual(
      ['agent.offline', 'device.offline', 'device.online'].toSorted(),
    )

    for (const category of ['device.online', 'device.offline', 'agent.offline']) {
      deliverShared(state, makeEvent(category))
    }
    expect(seen).toEqual(['device.online', 'device.offline', 'agent.offline'])
  })

  it('delivers ONCE when two of its patterns match the same event', () => {
    const state = createSharedBusState()
    const seen: string[] = []
    registerSubscriber(state, { category: ['device.*', 'device.online'] }, (event) => {
      seen.push(event.category)
    })

    deliverShared(state, makeEvent('device.online'))
    expect(seen).toEqual(['device.online'])
  })

  it('unsubscribing removes the entry from every key it occupied', () => {
    const state = createSharedBusState()
    const seen: string[] = []
    const unsubscribe = registerSubscriber(
      state,
      { category: ['device.online', 'device.offline'] },
      (event) => {
        seen.push(event.category)
      },
    )
    unsubscribe()

    // Emptied keys are DELETED, not left as empty sets: on a UDS child bus the
    // key set is what the parent is told to forward, so an empty set left
    // behind pins the parent to forward a category nobody wants.
    expect([...state.handlers.keys()]).toEqual([])
    deliverShared(state, makeEvent('device.online'))
    expect(seen).toEqual([])
  })

  it('leaves a sibling subscriber on a shared key alone', () => {
    const state = createSharedBusState()
    const kept: string[] = []
    registerSubscriber(state, { category: 'device.online' }, (event) => {
      kept.push(event.category)
    })
    const unsubscribe = registerSubscriber(
      state,
      { category: ['device.online', 'device.offline'] },
      () => undefined,
    )
    unsubscribe()

    expect([...state.handlers.keys()]).toEqual(['device.online'])
    deliverShared(state, makeEvent('device.online'))
    expect(kept).toEqual(['device.online'])
  })

  it('still honours the non-category dimensions of the filter on every key', () => {
    const state = createSharedBusState()
    const seen: string[] = []
    registerSubscriber(
      state,
      { category: ['device.online', 'device.offline'], deviceId: 101 },
      (event) => {
        seen.push(event.category)
      },
    )

    deliverShared(state, {
      id: 'a',
      timestamp: new Date(0),
      source: { type: 'device', id: 102, deviceId: 102 },
      category: 'device.offline',
      data: {},
    })
    deliverShared(state, {
      id: 'b',
      timestamp: new Date(0),
      source: { type: 'device', id: 101, deviceId: 101 },
      category: 'device.offline',
      data: {},
    })
    expect(seen).toEqual(['device.offline'])
  })
})
