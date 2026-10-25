/**
 * Track-lifecycle event category + typed payload — framework contract.
 *
 * Verifies (a) the new `PipelineAnalyticsTrackLifecycle` category value,
 * (b) the deprecated start/end aliases still resolve, and (c) a
 * `PipelineAnalyticsTrackLifecyclePayload` object is structurally valid
 * and assignable to the bus `EventCatalog` entry.
 */
import { describe, it, expect } from 'vitest'
import { EventCategory } from '../enums/event-category.js'
import type {
  EventCatalog,
  PipelineAnalyticsTrackLifecyclePayload,
} from '../interfaces/event-bus.js'

describe('PipelineAnalyticsTrackLifecycle event', () => {
  it('exposes the lifecycle category value', () => {
    expect(EventCategory.PipelineAnalyticsTrackLifecycle).toBe('pipeline-analytics.track-lifecycle')
  })

  it('keeps the deprecated start/end aliases', () => {
    expect(EventCategory.PipelineAnalyticsTrackStarted).toBe('pipeline-analytics.track-started')
    expect(EventCategory.PipelineAnalyticsTrackEnded).toBe('pipeline-analytics.track-ended')
  })

  it('types the payload in the EventCatalog', () => {
    const payload: EventCatalog['pipeline-analytics.track-lifecycle'] = {
      deviceId: 4,
      trackId: 't1',
      phase: 'update',
      classes: ['person'],
      bestClassName: 'person',
      bestConfidence: 0.82,
      firstSeen: 1000,
      lastSeen: 5000,
      durationMs: 4000,
      label: 'Alice',
      media: { keyFrameMediaId: 1 },
    }
    // Also assignable to the exported payload type.
    const asPayload: PipelineAnalyticsTrackLifecyclePayload = payload
    expect(asPayload.phase).toBe('update')
    expect(asPayload.classes).toEqual(['person'])
    expect(asPayload.media?.keyFrameMediaId).toBe(1)
  })
})
