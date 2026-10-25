import type { SystemEvent } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  createSharedBusState,
  deliverShared,
  isHighFrequencyCategory,
} from '../moleculer/event-bus-core.js'

function makeEvent(category: string, seq: number): SystemEvent {
  return {
    id: `evt-${seq}`,
    timestamp: new Date(seq),
    source: { type: 'core', id: 'test' },
    category,
    data: { seq },
  }
}

describe('event-bus-core deliverShared — one-shot vs retaining bus', () => {
  it('retainRecent:false (default) retains NOTHING but still fans out to every subscriber', () => {
    // Child runners + agents create their bus with the default (false):
    // events are one-shot / fire-and-forget — no recent[] registry.
    const state = createSharedBusState()
    expect(state.retainRecent).toBe(false)

    const received: SystemEvent[] = []
    const entry = {
      filter: 'device.state-changed',
      categoryPattern: 'device.state-changed',
      handler: (e: SystemEvent) => received.push(e),
    }
    state.handlers.set('device.state-changed', new Set([entry]))

    for (let i = 0; i < 5000; i++) {
      deliverShared(state, makeEvent('device.state-changed', i))
    }

    // Zero retention — the recent[] registry never grows on a non-hub bus.
    expect(state.recent.length).toBe(0)
    // …but every event was still delivered to the live subscriber.
    expect(received.length).toBe(5000)
  })

  it('retainRecent:true bounds recent[] to the most-recent 1000 non-denied events', () => {
    // Only the hub main process opts into retention (it serves getRecent).
    const state = createSharedBusState(true)
    expect(state.retainRecent).toBe(true)

    for (let i = 0; i < 5000; i++) {
      deliverShared(state, makeEvent('device.state-changed', i))
    }

    // The buffer must be capped — NOT grow unbounded to 5000.
    expect(state.recent.length).toBe(1000)

    // It must retain the MOST-RECENT 1000 (seq 4000..4999), oldest-first
    // (append order preserved), so the last element is the newest.
    const newest = state.recent.at(-1)
    expect(state.recent[0]?.id).toBe('evt-4000')
    expect(newest?.id).toBe('evt-4999')
    expect(newest?.data).toEqual({ seq: 4999 })
  })

  it('retainRecent:true still does NOT retain denied high-frequency categories', () => {
    const state = createSharedBusState(true)
    for (let i = 0; i < 100; i++) {
      deliverShared(state, makeEvent('motion.on-motion-changed', i))
    }
    expect(state.recent.length).toBe(0)
  })

  it('denies the hot pipeline-analytics + motion categories', () => {
    for (const cat of [
      'pipeline-analytics.frame-tracked',
      'pipeline-analytics.detection-event',
      'pipeline-analytics.track-started',
      'pipeline-analytics.track-ended',
      'motion.on-motion-changed',
      // A camera's RAW onboard motion push (D673): Hikvision re-emits it at ~1 Hz,
      // so it is the same noise the effective event is, and must not fill the rings.
      'provider.motion',
    ]) {
      expect(isHighFrequencyCategory(cat)).toBe(true)
    }
  })

  it('retainRecent:true does not retain provider.motion', () => {
    const state = createSharedBusState(true)
    for (let i = 0; i < 100; i++) {
      deliverShared(state, makeEvent('provider.motion', i))
    }
    expect(state.recent.length).toBe(0)
  })

  it('retainRecent:true still delivers denied events to live subscribers (fan-out is not gated by the deny-list)', () => {
    const state = createSharedBusState(true)
    const received: SystemEvent[] = []
    const entry = {
      filter: 'motion.on-motion-changed',
      categoryPattern: 'motion.on-motion-changed',
      handler: (e: SystemEvent) => received.push(e),
    }
    state.handlers.set('motion.on-motion-changed', new Set([entry]))
    deliverShared(state, makeEvent('motion.on-motion-changed', 1))
    expect(received.length).toBe(1)
    // …but it was not retained in the ring.
    expect(state.recent.length).toBe(0)
  })
})
