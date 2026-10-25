/**
 * The motion-bearing alarm ingress is logged by BURST STATE, not per tick:
 * a start line, at most one summary per interval with counts, and an end line.
 */
import type { IScopedLogger, LogExtras } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  ALARM_INGRESS_MESSAGE,
  type AlarmIngressEvent,
  createAlarmIngressLog,
} from '../hikvision-alarm-ingress-log.js'

function makeLogger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

const vmd = (at: number, camStreamId = 'native:main'): AlarmIngressEvent => ({
  type: 'vmd',
  state: 'active',
  aiClass: null,
  camStreamId,
  at,
})

/** Every info line's meta, after asserting the message and the device tag. */
const metas = (logger: IScopedLogger): Record<string, unknown>[] =>
  vi.mocked(logger.info).mock.calls.map(([message, extras]: [string, LogExtras?]) => {
    expect(message).toBe(ALARM_INGRESS_MESSAGE)
    expect(extras?.tags).toEqual({ deviceId: 102 })
    const meta = extras?.meta
    return typeof meta === 'object' && meta !== null ? { ...meta } : {}
  })

describe('createAlarmIngressLog', () => {
  it('logs a burst as start, one summary per interval, and end — not once per tick', () => {
    const logger = makeLogger()
    const log = createAlarmIngressLog({ logger, deviceId: 102, intervalMs: 60_000 })

    // 150 s of VMD at 1 Hz.
    for (let t = 0; t < 150; t++) log.received(vmd(1_000_000 + t * 1_000))
    log.ended('native:main', 1_000_000 + 152_000)

    const lines = metas(logger)
    expect(lines.map((m) => m.edge)).toEqual(['start', 'ongoing', 'ongoing', 'end'])
    expect(lines[0]).toMatchObject({ type: 'vmd', state: 'active', camStreamId: 'native:main' })
    expect(lines[1]).toMatchObject({ counts: { vmd: 60 }, windowMs: 60_000 })
    expect(lines[2]).toMatchObject({ counts: { vmd: 60 }, windowMs: 60_000 })
    expect(lines[3]).toMatchObject({
      counts: { vmd: 29 },
      ticks: 150,
      types: ['vmd'],
      durationMs: 152_000,
    })
  })

  it('reports a new event type joining a burst at once, with its AI class', () => {
    const logger = makeLogger()
    const log = createAlarmIngressLog({ logger, deviceId: 102 })

    log.received(vmd(1_000))
    log.received(vmd(2_000))
    log.received({
      type: 'linedetection',
      state: 'active',
      aiClass: 'human',
      camStreamId: 'native:main',
      at: 2_500,
    })
    log.received(vmd(3_000))

    const lines = metas(logger)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatchObject({
      edge: 'start',
      type: 'linedetection',
      aiClass: 'human',
      burstAgeMs: 1_500,
    })
  })

  it('keeps one burst per camStream, and a new burst after an end starts again', () => {
    const logger = makeLogger()
    const log = createAlarmIngressLog({ logger, deviceId: 102 })

    log.received(vmd(1_000, 'native:main'))
    log.received(vmd(1_000, 'native:ch2'))
    log.ended('native:main', 5_000)
    log.received(vmd(9_000, 'native:main'))

    expect(metas(logger).map((m) => `${String(m.edge)}@${String(m.camStreamId)}`)).toEqual([
      'start@native:main',
      'start@native:ch2',
      'end@native:main',
      'start@native:main',
    ])
  })

  it('says nothing for an end without a burst', () => {
    const logger = makeLogger()
    createAlarmIngressLog({ logger, deviceId: 102 }).ended('native:main', 1_000)
    expect(logger.info).not.toHaveBeenCalled()
  })
})
