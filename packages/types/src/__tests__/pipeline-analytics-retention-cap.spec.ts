/**
 * Track-centric retention cascade — cap surface (design §7).
 *
 * Asserts the three retention entry points are declared on the
 * pipeline-analytics cap:
 *  - `pruneTracksBefore({deviceId, cutoffMs})` → track-cascade counts.
 *  - `wipeAllAnalytics({deviceId})` → same counts shape (cutoff = now).
 *  - `pruneEventsBefore` remains (deprecated shim — Phase-B3 recorder caller).
 */
import { describe, it, expect } from 'vitest'
import { pipelineAnalyticsCapability } from '../capabilities/pipeline-analytics.cap.js'

const TRACK_CASCADE_COUNT_KEYS = [
  'tracks',
  'events',
  'media',
  'faces',
  'plates',
  'embeddings',
] as const

describe('pipeline-analytics retention cap surface (§7)', () => {
  it('declares pruneTracksBefore with {deviceId, cutoffMs} input and cascade counts output', () => {
    const m = pipelineAnalyticsCapability.methods.pruneTracksBefore
    expect(m).toBeDefined()
    expect(m.kind).toBe('mutation')
    expect(m.auth).toBe('admin')

    const parsedInput = m.input.parse({ deviceId: 1, cutoffMs: 123 })
    expect(parsedInput).toEqual({ deviceId: 1, cutoffMs: 123 })

    const outShape = m.output.parse({
      tracks: 1,
      events: 2,
      media: 3,
      faces: 4,
      plates: 5,
      embeddings: 6,
    })
    for (const key of TRACK_CASCADE_COUNT_KEYS) {
      expect(outShape).toHaveProperty(key)
    }
  })

  it('declares wipeAllAnalytics with {deviceId} input and cascade counts output', () => {
    const m = pipelineAnalyticsCapability.methods.wipeAllAnalytics
    expect(m).toBeDefined()
    expect(m.kind).toBe('mutation')
    expect(m.auth).toBe('admin')

    const parsedInput = m.input.parse({ deviceId: 42 })
    expect(parsedInput).toEqual({ deviceId: 42 })

    const outShape = m.output.parse({
      tracks: 0,
      events: 0,
      media: 0,
      faces: 0,
      plates: 0,
      embeddings: 0,
    })
    for (const key of TRACK_CASCADE_COUNT_KEYS) {
      expect(outShape).toHaveProperty(key)
    }
  })

  it('keeps pruneEventsBefore (deprecated shim) with its per-kind counts output', () => {
    const m = pipelineAnalyticsCapability.methods.pruneEventsBefore
    expect(m).toBeDefined()
    const out = m.output.parse({ motion: 1, object: 2, audio: 3 })
    expect(out).toEqual({ motion: 1, object: 2, audio: 3 })
  })
})
