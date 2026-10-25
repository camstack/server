import type { IScopedLogger, LogExtras } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hikvisionIgnoredAlarmReason } from '../hikvision-alarm-ignore.js'
import { createAlarmTypeTally } from '../hikvision-alarm-tally.js'
import {
  type HikvisionAlarmEvent,
  type HikvisionIsapiClient,
  peekAlertTypeState,
  subscribeAlarms,
} from '../hikvision-isapi-client.js'

/**
 * The `videoloss`/`inactive` flood, and what replaced it.
 *
 * Measured in production over 12 h: 83 200 `hikvision: unhandled alarm event`
 * lines, 116/min, of which 83 198 were byte-identical
 * `{"type":"videoloss","state":"inactive"}`. Each one cost a full seven-field
 * XML parse, an event object retaining the whole payload in `raw`, a channel-id
 * resolution scanning the published streams, a structured log record and its
 * shipping — to reach a `return`. The runner spent 52% of its CPU in GC.
 *
 * The other two lines in that same window were `io`/`active` — a real alarm
 * input on device 3839, buried under 83 198 heartbeats. That is the cost of
 * logging noise: it is not just waste, it hides the signal.
 *
 * Two things are asserted here, and the first is the one that matters:
 *
 *  1. the ignored event never becomes a `HikvisionAlarmEvent` at all — the
 *     assertion is about the work NOT DONE, not about the outcome, because the
 *     outcome (nothing happens) was always the same;
 *  2. `videoloss`/`active` — the camera actually losing its video signal — is
 *     NOT ignored. It used to share a `debug` line with the heartbeat, which
 *     made a real fault indistinguishable from 116 keep-alives a minute.
 */

const BOUNDARY = 'MIME_boundary'

function makeAlarmResponse(chunks: readonly string[]): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': `multipart/mixed; boundary=${BOUNDARY}` },
  })
}

function alertXml(type: string, state: string): string {
  return (
    `<EventNotificationAlert><eventType>${type}</eventType>` +
    `<eventState>${state}</eventState><channelID>1</channelID></EventNotificationAlert>`
  )
}

function alertPart(type: string, state: string): string {
  return `--${BOUNDARY}\r\nContent-Type: application/xml\r\n\r\n${alertXml(type, state)}\r\n`
}

function fakeClient(res: Response): HikvisionIsapiClient {
  const stub = { request: vi.fn(async () => res) }
  return stub as unknown as HikvisionIsapiClient
}

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

/** Drive a stream of alert parts to completion, collecting what got delivered. */
async function runStream(
  parts: readonly string[],
  logger: IScopedLogger,
): Promise<readonly HikvisionAlarmEvent[]> {
  const body = `${parts.join('')}--${BOUNDARY}\r\n`
  const events: HikvisionAlarmEvent[] = []
  const onError = vi.fn()
  subscribeAlarms(
    fakeClient(makeAlarmResponse([body])),
    { onConnected: () => {}, onEvent: (e) => events.push(e), onError },
    { idleTimeoutMs: 0, logger, deviceId: 3839 },
  )
  await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
  return events
}

describe('hikvisionIgnoredAlarmReason — the policy is keyed on (type, state)', () => {
  it('ignores the videoloss keep-alive and gives a reason', () => {
    const reason = hikvisionIgnoredAlarmReason('videoloss', 'inactive')
    expect(reason).not.toBeNull()
    expect(reason).toContain('keep-alive')
  })

  it('does NOT ignore videoloss/active — that is a real signal loss', () => {
    expect(hikvisionIgnoredAlarmReason('videoloss', 'active')).toBeNull()
  })

  it('does NOT ignore a videoloss that reports no state at all', () => {
    expect(hikvisionIgnoredAlarmReason('videoloss', null)).toBeNull()
  })

  it('ignores nothing else — an unmodelled type still reaches the camera', () => {
    expect(hikvisionIgnoredAlarmReason('io', 'active')).toBeNull()
    expect(hikvisionIgnoredAlarmReason('vmd', 'active')).toBeNull()
    expect(hikvisionIgnoredAlarmReason('shelteralarm', 'active')).toBeNull()
  })
})

describe('peekAlertTypeState — the cheap question, asked first', () => {
  it('normalises type and state the same way the full parser does', () => {
    expect(peekAlertTypeState(alertXml('VideoLoss', 'Inactive'))).toEqual({
      type: 'videoloss',
      state: 'inactive',
    })
  })

  it('returns null for a part with no eventType', () => {
    expect(peekAlertTypeState('<EventNotificationAlert></EventNotificationAlert>')).toBeNull()
  })
})

describe('subscribeAlarms — an ignored alarm is never built', () => {
  it('never delivers videoloss/inactive to onEvent', async () => {
    const logger = makeLogger()
    const events = await runStream([alertPart('videoloss', 'inactive')], logger)

    // The load-bearing assertion: no HikvisionAlarmEvent was ever constructed
    // for it, so nothing downstream parsed, allocated, resolved or logged.
    expect(events).toEqual([])
  })

  it('DOES deliver videoloss/active — a real signal loss is not swallowed', async () => {
    const logger = makeLogger()
    const events = await runStream([alertPart('videoloss', 'active')], logger)

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('videoloss')
    expect(events[0]!.state).toBe('active')
  })

  it('still delivers motion and unmodelled types untouched', async () => {
    const logger = makeLogger()
    const events = await runStream([alertPart('VMD', 'active'), alertPart('io', 'active')], logger)

    expect(events.map((e) => e.type)).toEqual(['vmd', 'io'])
  })

  it('reports a burst of identical heartbeats as ONE line, not one per event', async () => {
    const logger = makeLogger()
    const parts = Array.from({ length: 50 }, () => alertPart('videoloss', 'inactive'))
    const events = await runStream(parts, logger)

    expect(events).toEqual([])

    const debugFn = logger.debug as ReturnType<typeof vi.fn>
    const tallyLines = debugFn.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('ignored alarm type'),
    )
    // 50 events in, 1 line out — the other 49 are folded into the next window.
    expect(tallyLines).toHaveLength(1)
    expect(tallyLines[0]![1]).toMatchObject({
      tags: { deviceId: 3839 },
      meta: { type: 'videoloss', state: 'inactive', first: true },
    })
  })
})

describe('createAlarmTypeTally — a count, and it carries the device', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('logs the first occurrence at once, then folds repeats into a count', () => {
    const logger = makeLogger()
    const tally = createAlarmTypeTally({
      logger,
      deviceId: 102,
      message: 'ignored',
      level: 'debug',
      intervalMs: 60_000,
    })

    // First one is news — reported immediately, so a rare type never waits.
    tally.note('videoloss', 'inactive', 'because')
    const debugFn = logger.debug as ReturnType<typeof vi.fn>
    expect(debugFn).toHaveBeenCalledTimes(1)
    expect(debugFn.mock.calls[0]![1]).toMatchObject({
      tags: { deviceId: 102 },
      meta: { count: 1, first: true, reason: 'because' },
    })

    // 6999 more inside the window cost nothing.
    for (let i = 0; i < 6999; i++) tally.note('videoloss', 'inactive', 'because')
    expect(debugFn).toHaveBeenCalledTimes(1)

    // The window closes: ONE line saying how many, not 7000 saying what.
    vi.advanceTimersByTime(60_001)
    tally.note('videoloss', 'inactive', 'because')
    expect(debugFn).toHaveBeenCalledTimes(2)
    expect(debugFn.mock.calls[1]![1]).toMatchObject({
      tags: { deviceId: 102 },
      meta: { type: 'videoloss', state: 'inactive', count: 7000 },
    })
  })

  it('keeps a separate window per (type, state) so a rare event is never delayed', () => {
    const logger = makeLogger()
    const tally = createAlarmTypeTally({
      logger,
      deviceId: 3839,
      message: 'unhandled',
      level: 'info',
      intervalMs: 60_000,
    })

    tally.note('videoloss', 'inactive')
    for (let i = 0; i < 1000; i++) tally.note('videoloss', 'inactive')

    // A DIFFERENT (type, state) — the `io`/`active` that was buried in
    // production — surfaces immediately despite the flood beside it.
    tally.note('io', 'active')

    const infoFn = logger.info as ReturnType<typeof vi.fn>
    const ioLines = infoFn.mock.calls.filter((call) => {
      const extras = call[1] as LogExtras | undefined
      const meta = extras?.meta
      return typeof meta === 'object' && meta !== null && 'type' in meta && meta.type === 'io'
    })
    expect(ioLines).toHaveLength(1)
    expect(ioLines[0]![1]).toMatchObject({ tags: { deviceId: 3839 }, meta: { first: true } })
  })

  it('is silent without a logger rather than throwing', () => {
    const tally = createAlarmTypeTally({
      logger: null,
      deviceId: null,
      message: 'x',
      level: 'debug',
    })
    expect(() => tally.note('videoloss', 'inactive')).not.toThrow()
  })
})
