/**
 * D673 — a Hikvision VMD push is the camera's RAW motion: it rides
 * `ProviderMotion`, never `MotionOnMotionChanged`. The orchestrator's
 * camera-sensors bridge is the one emitter of the effective motion, so a
 * Confirm or Replace sensor can suppress the camera's own. Both sites: the
 * per-tick `detected: true` heartbeat and the inactivity-timer clear.
 */
import { EventCategory, type IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAlarmIngressLog } from '../hikvision-alarm-ingress-log.js'
import { HikvisionCamera } from '../hikvision-camera.js'
import type { HikvisionAlarmEvent } from '../hikvision-isapi-client.js'

interface Emitted {
  readonly category: string
  readonly data: Record<string, unknown>
}

function makeSubject(): {
  readonly subject: object
  readonly emitted: Emitted[]
  readonly info: ReturnType<typeof vi.mocked<IScopedLogger['info']>>
} {
  const emitted: Emitted[] = []
  const logger: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
  const subject = {
    id: 101,
    eventSource: { type: 'device', id: 101, addonId: 'provider-hikvision', deviceId: 101 },
    lastMotionAt: new Map<string, number>(),
    motionInactiveTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    state: {},
    setCapSlice: vi.fn(),
    // The real ingress log, on the subject's logger: the wiring is what is tested.
    motionIngress: createAlarmIngressLog({ logger, deviceId: 101 }),
    ctx: {
      logger,
      eventBus: {
        emit: (e: Emitted) => {
          emitted.push(e)
        },
      },
    },
  }
  return { subject, emitted, info: vi.mocked(logger.info) }
}

describe('HikvisionCamera.handleMotionEvent', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits the heartbeat and the clear as ProviderMotion, onboard, with no MotionOnMotionChanged', () => {
    const { subject, emitted } = makeSubject()
    const ev: HikvisionAlarmEvent = {
      observedAt: 1_000,
      type: 'VMD',
      state: 'active',
      channelId: '1',
      aiClass: null,
      description: null,
      score: null,
      raw: '',
    }

    HikvisionCamera.prototype['handleMotionEvent'].call(subject, ev, 'native:main')
    vi.advanceTimersByTime(3_001)

    expect(emitted.map((e) => e.category)).toEqual([
      EventCategory.ProviderMotion,
      EventCategory.ProviderMotion,
    ])
    expect(emitted[0]?.data).toMatchObject({
      deviceId: 101,
      detected: true,
      source: 'onboard',
      timestamp: 1_000,
    })
    expect(emitted[1]?.data).toMatchObject({
      deviceId: 101,
      detected: false,
      source: 'onboard',
      timestamp: 4_000,
    })
    expect(emitted.some((e) => e.category === EventCategory.MotionOnMotionChanged)).toBe(false)
  })

  it('logs the burst ingress at info, tagged with the device: start on the tick, end on the clear', () => {
    const { subject, info } = makeSubject()
    const tick = (at: number): HikvisionAlarmEvent => ({
      observedAt: at,
      type: 'vmd',
      state: 'active',
      channelId: '1',
      aiClass: null,
      description: null,
      score: null,
      raw: '',
    })

    const handle = HikvisionCamera.prototype['handleMotionEvent']
    handle.call(subject, tick(1_000), 'native:main')
    vi.advanceTimersByTime(1_000)
    handle.call(subject, tick(2_000), 'native:main')
    vi.advanceTimersByTime(1_000)
    handle.call(subject, tick(3_000), 'native:main')
    // Three ticks: still ONE line.
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0]?.[1]).toMatchObject({
      tags: { deviceId: 101 },
      meta: { edge: 'start', type: 'vmd', camStreamId: 'native:main' },
    })

    vi.advanceTimersByTime(3_001)
    expect(info).toHaveBeenCalledTimes(2)
    expect(info.mock.calls[1]?.[1]).toMatchObject({
      tags: { deviceId: 101 },
      meta: { edge: 'end', ticks: 3, counts: { vmd: 2 } },
    })
  })
})
