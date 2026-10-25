/**
 * SESSION DISPATCH HONOURS `motionSources`.
 *
 * Any `MotionOnMotionChanged` used to open (or rearm, or close) a session on
 * an on-motion camera, whatever its `source`: the runner's analyzer
 * side-channel emits `source: 'analyzer'` transitions on onboard-only
 * cameras, and each one reached the dispatcher. The camera's own list is the
 * gate — checked before the lock and again on the config re-read inside it —
 * and every drop is said, sampled per (camera, trigger) with the count.
 */
import { CAMERA_TRIGGER } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SOURCE_GATE_LOG_SAMPLE_EVERY } from '../session-dispatch-controller.js'
import { makeHarness } from './session-dispatch-harness.js'

const CAMERA = 103
const DROP = 'session motion dropped — the camera does not list this source'

describe('session dispatch honours motionSources', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each([
    true,
    false,
  ])('drops detected=%s from a source the camera does not list', async (detected) => {
    const h = makeHarness({ sources: ['onboard'] })
    await h.controller.handleSessionMotion(CAMERA, detected, undefined, 'analyzer', CAMERA_TRIGGER)
    expect(h.attached).toHaveLength(0)
    const line = h.lines.find((l) => l.message === DROP)
    expect(line?.tags).toMatchObject({ deviceId: CAMERA })
    expect(line?.meta).toMatchObject({
      trigger: 'analyzer',
      detected,
      where: 'pre-lock',
      dropCount: 1,
    })
  })

  it('dispatches from a listed source', async () => {
    const h = makeHarness({ sources: ['onboard'] })
    await h.controller.handleSessionMotion(CAMERA, true, undefined, 'onboard', CAMERA_TRIGGER)
    expect(h.attached).toHaveLength(1)
  })

  it('re-checks the source inside the lock against the re-read config', async () => {
    const h = makeHarness({ sources: ['onboard'] })
    const release = h.holdAttach()
    const first = h.controller.handleSessionMotion(
      CAMERA,
      true,
      undefined,
      'onboard',
      CAMERA_TRIGGER,
    )
    await vi.advanceTimersByTimeAsync(0)
    // Passes the pre-lock gate, then queues behind the first dispatch's lock.
    const second = h.controller.handleSessionMotion(
      CAMERA,
      true,
      undefined,
      'onboard',
      CAMERA_TRIGGER,
    )
    h.setSources(['analyzer'])
    release()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all([first, second])
    expect(h.lines.some((l) => l.message === DROP && l.meta['where'] === 'in-lock')).toBe(true)
    expect(
      h.lines.some((l) => l.message === 'session motion: already active, fallback rearmed'),
    ).toBe(false)
  })

  it('samples repeated drops and carries the count', async () => {
    const h = makeHarness({ sources: ['onboard'] })
    for (let i = 0; i < SOURCE_GATE_LOG_SAMPLE_EVERY; i++) {
      await h.controller.handleSessionMotion(CAMERA, true, undefined, 'analyzer', CAMERA_TRIGGER)
    }
    const drops = h.lines.filter((l) => l.message === DROP)
    expect(drops.map((l) => l.meta['dropCount'])).toEqual([1, SOURCE_GATE_LOG_SAMPLE_EVERY])
  })
})
