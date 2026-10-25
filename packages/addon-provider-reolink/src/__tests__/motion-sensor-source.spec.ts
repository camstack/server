/**
 * MD vs PIR: nodelink-js decodes it on the raw motion notification and drops
 * it from the simple event; the tracker carries it across.
 */
import type { ReolinkSimpleEvent } from '@apocaliss92/nodelink-js'
import { describe, expect, it } from 'vitest'
import {
  createMotionSensorTracker,
  MOTION_SENSOR_MATCH_WINDOW_MS,
  motionSensorOnSimpleEvent,
} from '../motion-sensor-source.js'

describe('createMotionSensorTracker', () => {
  it('hands the raw notification’s sensor to the next push on that channel, once', () => {
    let now = 1_000
    const tracker = createMotionSensorTracker(() => now)
    tracker.observe({
      type: 'motion',
      channel: 1,
      motion: { channel: 1, state: true, source: 'md' },
    })
    tracker.observe({
      type: 'motion',
      channel: 2,
      motion: { channel: 2, state: true, source: 'pir' },
    })
    now += 5
    expect(tracker.take(2)).toBe('pir')
    expect(tracker.take(1)).toBe('md')
    expect(tracker.take(1)).toBeNull()
  })

  it('refuses an entry too old to belong to the push being handled', () => {
    let now = 1_000
    const tracker = createMotionSensorTracker(() => now)
    tracker.observe({
      type: 'motion',
      channel: 0,
      motion: { channel: 0, state: true, source: 'pir' },
    })
    now += MOTION_SENSOR_MATCH_WINDOW_MS + 1
    expect(tracker.take(0)).toBeNull()
  })

  it('records nothing for a notification without a sensor, or that is not motion', () => {
    const tracker = createMotionSensorTracker(() => 0)
    tracker.observe({ type: 'motion', channel: 0, motion: { channel: 0, state: true } })
    tracker.observe({ type: 'visitor', channel: 0 })
    expect(tracker.take(0)).toBeNull()
  })
})

describe('motionSensorOnSimpleEvent', () => {
  it('is null for the simple event the library emits today', () => {
    const event: ReolinkSimpleEvent = {
      type: 'motion',
      channel: 0,
      timestamp: 1,
      source: 'baichuan',
    }
    expect(motionSensorOnSimpleEvent(event)).toBeNull()
  })

  it('reads motion.source when a library version forwards it', () => {
    const event = { type: 'motion', channel: 0, timestamp: 1, motion: { source: 'pir' } } as const
    expect(motionSensorOnSimpleEvent(event)).toBe('pir')
  })
})
