import { describe, it, expect } from 'vitest'
import {
  RETIRED_REJECTIONS_PER_DEVICE,
  SuppressedBirthRegistry,
} from '../pipeline/suppressed-births.js'

/**
 * The confirmation gate's verdict has to OUTLIVE the frame it was made on.
 *
 * Before 2026-07-31 it did not exist at all beyond that frame: the gate ran
 * after the TrackStore upsert, so a rejected birth was already written, and the
 * tracker kept carrying the id — 27 seconds in the worst measured case — with
 * every later frame writing it back. Six full-frame phantoms on device 101 in
 * nine minutes were each suppressed by the gate AND each present in
 * `listRecentTracks`. The operator called them artefacts.
 */
describe('SuppressedBirthRegistry', () => {
  const DEV = 'hub:101'

  it('keeps rejecting an id for as long as the tracker carries it', () => {
    const r = new SuppressedBirthRegistry()
    r.reject(DEV, 'phantom')

    // Ten more frames still holding the phantom: it must stay rejected on all
    // of them. Retracting once was the version that did not work.
    for (let frame = 0; frame < 10; frame++) {
      r.retain(DEV, new Set(['phantom', 'a-real-track']))
      expect(r.isRejected(DEV, 'phantom')).toBe(true)
    }
    expect(r.isRejected(DEV, 'a-real-track')).toBe(false)
  })

  it('forgets an id once the tracker drops it', () => {
    const r = new SuppressedBirthRegistry()
    r.reject(DEV, 'phantom')
    r.retain(DEV, new Set<string>())
    expect(r.isRejected(DEV, 'phantom')).toBe(false)
    expect(r.size(DEV)).toBe(0)
  })

  it('does not grow without bound on a camera producing phantoms forever', () => {
    const r = new SuppressedBirthRegistry()
    // 500 phantoms, each present for exactly one frame — the shape of the
    // flicker-and-respawn pattern that motivated this.
    for (let i = 0; i < 500; i++) {
      const id = `phantom-${i}`
      r.reject(DEV, id)
      r.retain(DEV, new Set([id]))
      r.retain(DEV, new Set<string>())
    }
    expect(r.size(DEV)).toBe(0)
  })

  it('keeps devices independent', () => {
    const r = new SuppressedBirthRegistry()
    r.reject('hub:101', 'x')
    r.reject('hub:102', 'x')
    r.retain('hub:101', new Set<string>())
    expect(r.isRejected('hub:101', 'x')).toBe(false)
    expect(r.isRejected('hub:102', 'x')).toBe(true)
  })

  it('still suppresses the events of an id the tracker already dropped', () => {
    // A `leaving` / zone-exit event names an id ABSENT from the frame — the
    // frame it is lost, or later. Cam 101, 2026-10-21: those events fired a
    // person rule for a suppressed birth.
    const r = new SuppressedBirthRegistry()
    r.reject(DEV, 'phantom')
    r.retain(DEV, new Set<string>())
    expect(r.isRejected(DEV, 'phantom')).toBe(false)
    expect(r.suppressesEvents(DEV, 'phantom')).toBe(true)
    expect(r.suppressesEvents(DEV, 'a-real-track')).toBe(false)
  })

  it('bounds the retired memory, oldest first', () => {
    const r = new SuppressedBirthRegistry()
    const total = RETIRED_REJECTIONS_PER_DEVICE + 10
    for (let i = 0; i < total; i++) {
      r.reject(DEV, `phantom-${i}`)
      r.retain(DEV, new Set<string>())
    }
    expect(r.suppressesEvents(DEV, 'phantom-0')).toBe(false)
    expect(r.suppressesEvents(DEV, `phantom-${total - 1}`)).toBe(true)
    expect(r.suppressesEvents(DEV, `phantom-${total - RETIRED_REJECTIONS_PER_DEVICE}`)).toBe(true)
    r.clearDevice(DEV)
    expect(r.suppressesEvents(DEV, `phantom-${total - 1}`)).toBe(false)
  })
})
