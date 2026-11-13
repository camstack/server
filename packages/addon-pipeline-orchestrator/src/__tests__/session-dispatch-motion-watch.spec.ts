/**
 * A detection session attach replaces the standing analyzer watch on the
 * same runner (`attachCamera` detaches the device first). The bookkeeping
 * has to follow that: after the session closes, the watch is attached
 * again with `motionSources: ['analyzer']`. Leaving the old map entry in
 * place makes every later `ensureMotionWatch` a no-op.
 */
import { CAMERA_TRIGGER } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_SESSION_OPEN_MS } from '../session-dispatch-controller.js'
import { makeHarness, NODE } from './session-dispatch-harness.js'

const DEVICE = 104
const RESTORED = 'motion watch restored after detection session'

describe('session close restores the analyzer motion watch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reattaches motionSources analyzer after the session that replaced the watch closes', async () => {
    const h = makeHarness({ sources: ['analyzer'] })
    await h.controller.ensureMotionWatch(DEVICE, h.detectionConfig())
    expect(h.attached[0]?.motionSources).toEqual(['analyzer'])
    expect(h.controller.isMotionWatchAttachment(DEVICE, NODE)).toBe(true)

    await h.controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)
    expect(h.attached.at(-1)?.motionSources).toEqual([])
    expect(h.controller.isMotionWatchAttachment(DEVICE, NODE)).toBe(false)

    await h.controller.handleSessionMotion(DEVICE, false, undefined, 'analyzer', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS)

    expect(h.attached.at(-1)?.motionSources).toEqual(['analyzer'])
    expect(h.controller.isMotionWatchAttachment(DEVICE, NODE)).toBe(true)
    const line = h.lines.find((l) => l.message === RESTORED)
    expect(line?.tags).toMatchObject({ deviceId: DEVICE })
  })
})
