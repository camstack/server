import type { IScopedLogger, LogExtras } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  type HikvisionAlarmEvent,
  type HikvisionIsapiClient,
  isHikvisionMotionAlarmType,
  subscribeAlarms,
} from '../hikvision-isapi-client.js'

/**
 * Regression tests for the alarm-stream subscription lifecycle.
 *
 * Root cause of the "Hikvision cameras stopped producing motion events for
 * days" incident: a CLEAN stream-end (the camera closes the multipart
 * `alertStream` connection — firmware keep-alive recycle, event-subsystem
 * restart, or an idle NAT hop dropping the socket between the hub and a camera
 * on another subnet) used to fall through `subscribeAlarms` silently. `onError`
 * never fired, so the device class kept its `alarmController` non-null and
 * never resubscribed — motion died permanently until the provider restarted.
 *
 * The contract now: every terminal outcome that is NOT a deliberate
 * `controller.abort()` reports through `onError` exactly once, so the caller's
 * reconnect logic always fires. A per-stream idle watchdog additionally
 * rescues a half-open TCP connection that would otherwise block `read()`
 * forever.
 */

const BOUNDARY = 'MIME_boundary'

/** Build a multipart/mixed Response whose body streams `chunks` (in order),
 *  then optionally stays open forever (`keepOpen`) to simulate a live or
 *  half-open connection. Returns the Response plus a `close()` to end it. */
function makeAlarmResponse(
  chunks: readonly string[],
  keepOpen: boolean,
): { res: Response; close: () => void } {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
      for (const c of chunks) controller.enqueue(enc.encode(c))
      if (!keepOpen) controller.close()
    },
  })
  const res = new Response(stream, {
    status: 200,
    headers: { 'content-type': `multipart/mixed; boundary=${BOUNDARY}` },
  })
  return {
    res,
    close: () => {
      try {
        controllerRef?.close()
      } catch {
        /* already closed */
      }
    },
  }
}

function vmdXml(): string {
  return (
    '<EventNotificationAlert><eventType>VMD</eventType>' +
    '<eventState>active</eventState><channelID>1</channelID></EventNotificationAlert>'
  )
}

function vmdPart(contentType = 'application/xml'): string {
  const header = contentType.length > 0 ? `Content-Type: ${contentType}\r\n` : ''
  return `--${BOUNDARY}\r\n${header}\r\n${vmdXml()}\r\n`
}

/** Minimal client whose only exercised method is `request`. */
function fakeClient(res: Response): HikvisionIsapiClient {
  const stub = { request: vi.fn(async () => res) }
  return stub as unknown as HikvisionIsapiClient
}

describe('subscribeAlarms lifecycle', () => {
  it('surfaces a clean stream-end through onError so the caller reconnects', async () => {
    // A parsed block is only emitted once it is fully delimited by a leading
    // AND trailing boundary within the buffer, so frame the event part on both
    // sides in one chunk.
    const { res } = makeAlarmResponse([`${vmdPart()}--${BOUNDARY}\r\n`], /* keepOpen */ false)
    const events: HikvisionAlarmEvent[] = []
    const onError = vi.fn()
    const onConnected = vi.fn()

    subscribeAlarms(fakeClient(res), {
      onConnected,
      onEvent: (e) => events.push(e),
      onError,
    })

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(onConnected).toHaveBeenCalledTimes(1)
    expect(events.map((e) => e.type)).toEqual(['vmd'])
    expect(String(onError.mock.calls[0]![0])).toContain('alarm stream ended')
  })

  it('does NOT call onError on a deliberate abort (teardown)', async () => {
    const { res } = makeAlarmResponse([vmdPart()], /* keepOpen */ true)
    const onError = vi.fn()
    const onConnected = vi.fn()

    const controller = subscribeAlarms(fakeClient(res), {
      onConnected,
      onEvent: () => {},
      onError,
    })

    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1))
    controller.abort()
    // Give the aborted read a few macrotasks to reject and unwind.
    await new Promise((r) => setTimeout(r, 20))
    expect(onError).not.toHaveBeenCalled()
  })

  it('idle watchdog cancels a silent (half-open) stream and reports disconnect', async () => {
    // keepOpen with no further bytes → read() would block forever without the
    // watchdog. A tiny idle timeout must cancel the reader and surface a
    // recoverable disconnect via onError.
    const { res } = makeAlarmResponse([], /* keepOpen */ true)
    const onError = vi.fn()

    subscribeAlarms(
      fakeClient(res),
      { onConnected: () => {}, onEvent: () => {}, onError },
      { idleTimeoutMs: 25 },
    )

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1), { timeout: 1_000 })
    expect(String(onError.mock.calls[0]![0])).toContain('alarm stream ended')
  })

  it('reports a non-200 subscribe as an error (reconnect path)', async () => {
    const res = new Response(null, { status: 503 })
    const onError = vi.fn()

    subscribeAlarms(fakeClient(res), { onConnected: () => {}, onEvent: () => {}, onError })

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(String(onError.mock.calls[0]![0])).toContain('503')
  })

  // Some ColorVu/G6 firmwares omit Content-Type or send text/plain —
  // those parts used to be dropped silently.
  it('parses a VMD part even when Content-Type is missing', async () => {
    const { res } = makeAlarmResponse([`${vmdPart('')}--${BOUNDARY}\r\n`], /* keepOpen */ false)
    const events: HikvisionAlarmEvent[] = []
    subscribeAlarms(fakeClient(res), {
      onConnected: () => {},
      onEvent: (e) => events.push(e),
      onError: () => {},
    })
    await vi.waitFor(() => expect(events.map((e) => e.type)).toEqual(['vmd']))
  })

  it('parses a VMD part with Content-Type text/plain', async () => {
    const { res } = makeAlarmResponse(
      [`${vmdPart('text/plain')}--${BOUNDARY}\r\n`],
      /* keepOpen */ false,
    )
    const events: HikvisionAlarmEvent[] = []
    subscribeAlarms(fakeClient(res), {
      onConnected: () => {},
      onEvent: (e) => events.push(e),
      onError: () => {},
    })
    await vi.waitFor(() => expect(events.map((e) => e.type)).toEqual(['vmd']))
  })
})

/**
 * Wire-framing regressions.
 *
 * Five Hikvision cameras (firmware `C-R-*`: I91DN/I91DD V5.7.1, I91EV V5.8.10)
 * have never delivered a single motion event to CamStack while the SAME
 * cameras produce hardware motion on the SAME `/ISAPI/Event/notification/
 * alertStream` endpoint in another NVR stack. The distinguishing behaviour of
 * the working implementation is that it does not trust the boundary token
 * DECLARED in `Content-Type` — older Hikvision firmware announces one token
 * and then frames every part with a different constant.
 *
 * Independently, the splitter dropped the fragment that precedes each
 * boundary as an RFC 1521 preamble on EVERY split, not just the first — so on
 * a stream that delivers one part per TCP read (the normal case) the completed
 * part was discarded every single time.
 */

/** Multipart response whose DECLARED boundary and WIRE boundary can differ. */
function makeFramedResponse(
  chunks: readonly string[],
  declaredBoundary: string,
): { res: Response; close: () => void } {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
      for (const c of chunks) controller.enqueue(enc.encode(c))
    },
  })
  const res = new Response(stream, {
    status: 200,
    headers: { 'content-type': `multipart/mixed; boundary=${declaredBoundary}` },
  })
  return {
    res,
    close: () => {
      try {
        controllerRef?.close()
      } catch {
        /* already closed */
      }
    },
  }
}

/** One complete part framed with `wireBoundary`, carrying a real Content-Length. */
function framedPart(wireBoundary: string, channelId: number): string {
  const xml =
    '<EventNotificationAlert><eventType>VMD</eventType>' +
    `<eventState>active</eventState><channelID>${channelId}</channelID></EventNotificationAlert>`
  return (
    `--${wireBoundary}\r\n` +
    'Content-Type: application/xml; charset="UTF-8"\r\n' +
    `Content-Length: ${xml.length}\r\n\r\n${xml}\r\n`
  )
}

/** Same part, but with the Content-Length header omitted. */
function framedPartNoLength(wireBoundary: string, channelId: number): string {
  const xml =
    '<EventNotificationAlert><eventType>VMD</eventType>' +
    `<eventState>active</eventState><channelID>${channelId}</channelID></EventNotificationAlert>`
  return `--${wireBoundary}\r\nContent-Type: application/xml\r\n\r\n${xml}\r\n`
}

describe('alarm stream multipart framing', () => {
  it('parses parts framed with the literal `--boundary` a declared token never matches', async () => {
    // Declared: MIME_boundary. On the wire: --boundary. Zero declared-token
    // matches means every byte used to accumulate in the buffer forever with
    // no event, no error and no log line.
    const { res } = makeFramedResponse(
      [framedPart('boundary', 1), framedPart('boundary', 2)],
      BOUNDARY,
    )
    const events: HikvisionAlarmEvent[] = []
    subscribeAlarms(fakeClient(res), {
      onConnected: () => {},
      onEvent: (e) => events.push(e),
      onError: () => {},
    })
    await vi.waitFor(() => expect(events.map((e) => e.type)).toEqual(['vmd', 'vmd']))
  })

  it('adopts an arbitrary third wire token, not just the literal `--boundary`', async () => {
    const { res } = makeFramedResponse(
      [framedPart('hikvision-alert-2024', 7), framedPart('hikvision-alert-2024', 8)],
      BOUNDARY,
    )
    const events: HikvisionAlarmEvent[] = []
    subscribeAlarms(fakeClient(res), {
      onConnected: () => {},
      onEvent: (e) => events.push(e),
      onError: () => {},
    })
    await vi.waitFor(() => expect(events.map((e) => e.channelId)).toEqual(['7', '8']))
  })

  it('emits every part when the stream delivers ONE part per read', async () => {
    // The realistic framing: each read() carries a single complete part that
    // begins with the boundary. The completed fragment preceding the NEXT
    // boundary is a part, not a preamble.
    const { res } = makeFramedResponse(
      [1, 2, 3, 4, 5].map((n) => framedPart(BOUNDARY, n)),
      BOUNDARY,
    )
    const events: HikvisionAlarmEvent[] = []
    subscribeAlarms(fakeClient(res), {
      onConnected: () => {},
      onEvent: (e) => events.push(e),
      onError: () => {},
    })
    await vi.waitFor(() =>
      expect(events.map((e) => e.channelId)).toEqual(['1', '2', '3', '4', '5']),
    )
  })

  it('emits parts that carry NO Content-Length and arrive one per read', async () => {
    // Firmware that omits Content-Length can only be framed by boundaries, so
    // this isolates the preamble bug from the Content-Length fast path: the
    // fragment preceding each boundary is a COMPLETE part, not a preamble.
    // The 5th has no trailing boundary yet, so 4 are due.
    const { res } = makeFramedResponse(
      [1, 2, 3, 4, 5].map((n) => framedPartNoLength(BOUNDARY, n)),
      BOUNDARY,
    )
    const events: HikvisionAlarmEvent[] = []
    subscribeAlarms(fakeClient(res), {
      onConnected: () => {},
      onEvent: (e) => events.push(e),
      onError: () => {},
    })
    await vi.waitFor(() => expect(events.map((e) => e.channelId)).toEqual(['1', '2', '3', '4']))
  })

  it('emits a part as soon as Content-Length bytes arrive — not one event late', async () => {
    // Stream stays OPEN and no further boundary is ever sent. A parser that
    // waits for the next boundary delivers nothing at all here.
    const { res } = makeFramedResponse([framedPart(BOUNDARY, 42)], BOUNDARY)
    const events: HikvisionAlarmEvent[] = []
    subscribeAlarms(fakeClient(res), {
      onConnected: () => {},
      onEvent: (e) => events.push(e),
      onError: () => {},
    })
    await vi.waitFor(() => expect(events.map((e) => e.channelId)).toEqual(['42']))
  })
})

/**
 * Diagnostics + memory bound.
 *
 * The C-R silence was invisible for months because NOTHING logged: zero
 * boundary matches simply appended to a buffer that grew forever while the
 * idle watchdog stayed satisfied (bytes WERE arriving). Every drop path now
 * has a voice, and the buffer has a ceiling.
 */

interface CapturedLog {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras: LogExtras | undefined
}

interface LogCapture {
  readonly logger: IScopedLogger
  readonly entries: readonly CapturedLog[]
}

function recordingLogger(): LogCapture {
  const entries: CapturedLog[] = []
  const logger: IScopedLogger = {
    debug: (message, extras) => entries.push({ level: 'debug', message, extras }),
    info: (message, extras) => entries.push({ level: 'info', message, extras }),
    warn: (message, extras) => entries.push({ level: 'warn', message, extras }),
    error: (message, extras) => entries.push({ level: 'error', message, extras }),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, entries }
}

function kindsOf(entries: readonly CapturedLog[]): readonly string[] {
  return entries.map((e) => String(e.extras?.meta?.['kind'] ?? ''))
}

function entriesOfKind(entries: readonly CapturedLog[], kind: string): readonly CapturedLog[] {
  return entries.filter((e) => e.extras?.meta?.['kind'] === kind)
}

describe('alarm stream diagnostics and buffer bound', () => {
  it('caps the unparsed buffer instead of growing forever', async () => {
    // 40 KiB of bytes that contain no boundary at all, in 1 KiB chunks.
    const junk = `${'A'.repeat(1_023)}\n`
    const { res } = makeFramedResponse(new Array(40).fill(junk), BOUNDARY)
    const { logger, entries } = recordingLogger()
    subscribeAlarms(
      fakeClient(res),
      { onConnected: () => {}, onEvent: () => {}, onError: () => {} },
      {
        logger,
        deviceId: 1436,
        maxBufferBytes: 4_096,
        retainBytes: 1_024,
        unparsedWarnBytes: 2_048,
        // 0 => never rate-limited, so every overflow is observable.
        diagnosticIntervalMs: 0,
      },
    )
    await vi.waitFor(() =>
      expect(entriesOfKind(entries, 'buffer-overflow').length).toBeGreaterThan(2),
    )
    for (const e of entriesOfKind(entries, 'buffer-overflow')) {
      // Never more than the cap plus the single chunk that tripped it.
      expect(Number(e.extras?.meta?.['bufferedBytes'])).toBeLessThanOrEqual(4_096 + junk.length)
      expect(e.extras?.tags?.deviceId).toBe(1436)
    }
  })

  it('warns ONCE for a broken stream rather than once per chunk', async () => {
    const junk = `${'A'.repeat(1_023)}\n`
    const { res } = makeFramedResponse(new Array(40).fill(junk), BOUNDARY)
    const { logger, entries } = recordingLogger()
    subscribeAlarms(
      fakeClient(res),
      { onConnected: () => {}, onEvent: () => {}, onError: () => {} },
      {
        logger,
        deviceId: 1436,
        maxBufferBytes: 4_096,
        retainBytes: 1_024,
        unparsedWarnBytes: 2_048,
        diagnosticIntervalMs: 60_000,
      },
    )
    await vi.waitFor(() => expect(entriesOfKind(entries, 'buffer-overflow').length).toBe(1))
    await new Promise((r) => setTimeout(r, 50))
    expect(entriesOfKind(entries, 'buffer-overflow').length).toBe(1)
    // …and the stream that never matched a boundary says so, once.
    expect(entriesOfKind(entries, 'boundary-never-matched').length).toBe(1)
    const first = entriesOfKind(entries, 'boundary-never-matched')[0]!
    expect(first.extras?.meta?.['declaredBoundary']).toBe(BOUNDARY)
    expect(first.extras?.tags?.deviceId).toBe(1436)
  })

  it('names the adopted boundary so the hypothesis is confirmable from the log', async () => {
    const { res } = makeFramedResponse([framedPart('boundary', 1)], BOUNDARY)
    const { logger, entries } = recordingLogger()
    subscribeAlarms(
      fakeClient(res),
      { onConnected: () => {}, onEvent: () => {}, onError: () => {} },
      { logger, deviceId: 3831 },
    )
    await vi.waitFor(() => expect(entriesOfKind(entries, 'boundary-adopted').length).toBe(1))
    const e = entriesOfKind(entries, 'boundary-adopted')[0]!
    expect(e.level).toBe('warn')
    expect(e.extras?.tags?.deviceId).toBe(3831)
    expect(e.extras?.meta?.['declaredBoundary']).toBe(BOUNDARY)
    expect(e.extras?.meta?.['observedBoundary']).toBe('boundary')
    expect(e.extras?.meta?.['firstDashLine']).toBe('--boundary')
  })

  it('logs a part dropped for not being alert XML', async () => {
    const body = '<html><body>go away</body></html>'
    const part =
      `--${BOUNDARY}\r\nContent-Type: text/html\r\n` +
      `Content-Length: ${body.length}\r\n\r\n${body}\r\n`
    const { res } = makeFramedResponse([part], BOUNDARY)
    const { logger, entries } = recordingLogger()
    subscribeAlarms(
      fakeClient(res),
      { onConnected: () => {}, onEvent: () => {}, onError: () => {} },
      { logger, deviceId: 1439 },
    )
    await vi.waitFor(() => expect(kindsOf(entries)).toContain('part-not-alert-xml'))
  })

  it('logs an alert part dropped for having no <eventType>', async () => {
    const body = '<EventNotificationAlert><ipAddress>10.0.0.9</ipAddress></EventNotificationAlert>'
    const part =
      `--${BOUNDARY}\r\nContent-Type: application/xml\r\n` +
      `Content-Length: ${body.length}\r\n\r\n${body}\r\n`
    const { res } = makeFramedResponse([part], BOUNDARY)
    const { logger, entries } = recordingLogger()
    subscribeAlarms(
      fakeClient(res),
      { onConnected: () => {}, onEvent: () => {}, onError: () => {} },
      { logger, deviceId: 1441 },
    )
    await vi.waitFor(() => expect(kindsOf(entries)).toContain('alert-xml-without-event-type'))
  })

  it('logs a block with no header separator that is not alert XML', async () => {
    const { res } = makeFramedResponse(
      [`--${BOUNDARY}\r\nnot-a-part\r\n--${BOUNDARY}\r\n`],
      BOUNDARY,
    )
    const { logger, entries } = recordingLogger()
    subscribeAlarms(
      fakeClient(res),
      { onConnected: () => {}, onEvent: () => {}, onError: () => {} },
      { logger, deviceId: 3833 },
    )
    await vi.waitFor(() => expect(kindsOf(entries)).toContain('part-unparseable'))
  })
})

describe('isHikvisionMotionAlarmType', () => {
  it('treats VMD, line/field, and region events as motion', () => {
    for (const type of [
      'vmd',
      'linedetection',
      'fielddetection',
      'regionentrance',
      'regionexit', // some firmwares; others emit regionexiting
    ]) {
      expect(isHikvisionMotionAlarmType(type)).toBe(true)
    }
    expect(isHikvisionMotionAlarmType('videoloss')).toBe(false)
  })
})
