/**
 * R1 — per-camera detection presence from the pipeline's track lifecycle, with
 * an authoritative reconcile (D8/D49): a dropped `end` can never leave a
 * sensor stuck DETECTED past one reconcile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DetectionTracker,
  detectionClassOf,
  PACKAGE_PULSE_MS,
} from '../detection-sensors/detection-tracker.js'

function harness() {
  const transitions: string[] = []
  const t = new DetectionTracker((deviceId, cls, present) => {
    transitions.push(`${deviceId}:${cls}:${present ? 'on' : 'off'}`)
  })
  return { t, transitions }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('detectionClassOf', () => {
  it('takes pipeline macros as they are and maps raw COCO labels', () => {
    expect(detectionClassOf('person')).toBe('person')
    expect(detectionClassOf('Vehicle')).toBe('vehicle')
    expect(detectionClassOf('dog')).toBe('animal')
    expect(detectionClassOf('truck')).toBe('vehicle')
    expect(detectionClassOf('face')).toBeNull()
    expect(detectionClassOf(undefined)).toBeNull()
  })
})

describe('DetectionTracker', () => {
  it('one transition per class presence, per track — not per event', () => {
    const { t, transitions } = harness()
    t.onTrackLifecycle({ deviceId: 101, trackId: 'a', phase: 'start', bestClassName: 'person' })
    t.onTrackLifecycle({ deviceId: 101, trackId: 'a', phase: 'update', bestClassName: 'person' })
    t.onTrackLifecycle({ deviceId: 101, trackId: 'b', phase: 'start', bestClassName: 'person' })
    t.onTrackLifecycle({ deviceId: 101, trackId: 'a', phase: 'end', bestClassName: 'person' })
    expect(transitions).toEqual(['101:person:on'])
    t.onTrackLifecycle({ deviceId: 101, trackId: 'b', phase: 'end', bestClassName: 'person' })
    expect(transitions).toEqual(['101:person:on', '101:person:off'])
  })

  it('classes and cameras are independent', () => {
    const { t, transitions } = harness()
    t.onTrackLifecycle({ deviceId: 1, trackId: 'a', phase: 'start', bestClassName: 'car' })
    t.onTrackLifecycle({ deviceId: 2, trackId: 'b', phase: 'start', bestClassName: 'cat' })
    expect(transitions).toEqual(['1:vehicle:on', '2:animal:on'])
  })

  it('a dropped end is healed by the reconcile read of active tracks', () => {
    const { t, transitions } = harness()
    t.onTrackLifecycle({ deviceId: 101, trackId: 'a', phase: 'start', bestClassName: 'person' })
    t.reconcile(101, [])
    expect(transitions).toEqual(['101:person:on', '101:person:off'])
    expect(t.isPresent(101, 'person')).toBe(false)
  })

  it('a dropped start is healed too', () => {
    const { t, transitions } = harness()
    t.reconcile(101, [{ trackId: 'x', className: 'vehicle' }])
    expect(transitions).toEqual(['101:vehicle:on'])
  })

  it('a package delivery is a pulse the reconcile does not erase', () => {
    const { t, transitions } = harness()
    t.onPackageDelivered(101, 'e1')
    t.reconcile(101, [])
    expect(t.isPresent(101, 'package')).toBe(true)
    vi.advanceTimersByTime(PACKAGE_PULSE_MS)
    expect(transitions).toEqual(['101:package:on', '101:package:off'])
  })

  it('reports which cameras still need reconciling', () => {
    const { t } = harness()
    t.onTrackLifecycle({ deviceId: 101, trackId: 'a', phase: 'start', bestClassName: 'person' })
    expect(t.camerasWithPresence()).toEqual([101])
    t.reconcile(101, [])
    expect(t.camerasWithPresence()).toEqual([])
  })
})
