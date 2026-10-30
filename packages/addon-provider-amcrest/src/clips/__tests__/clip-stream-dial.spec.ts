/**
 * The dial listener: one shot, short-lived, loopback, and every refusal leaves
 * in a header that survives being one.
 */
import { get as httpGet } from 'node:http'
import {
  CLIP_STILL_REASON_CODE_HEADER,
  CLIP_STILL_REASON_HEADER,
  type IScopedLogger,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { type ClipStreamOutcome, clipStreamTrailersFor } from '../clip-stream.js'
import {
  CLIP_STREAM_REASON_CODE_HEADER,
  createClipStreamDial,
  streamRefusalStatus,
} from '../clip-stream-dial.js'

/** A logger fake — the documented type boundary a test double needs. */
function makeLogger(): IScopedLogger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return logger
}

interface DialHarness {
  readonly dial: ReturnType<typeof createClipStreamDial>
  readonly runs: { deviceId: number; clipKey: string }[]
}

const WHOLE: ClipStreamOutcome = {
  kind: 'served',
  verdict: { kind: 'complete', expectedSeconds: 45, deliveredSeconds: 45.1 },
}

function harness(outcome: ClipStreamOutcome = WHOLE): DialHarness {
  const runs: { deviceId: number; clipKey: string }[] = []
  const dial = createClipStreamDial({
    logger: makeLogger(),
    stream: async (target, sink) => {
      runs.push({ deviceId: target.deviceId, clipKey: target.clipKey })
      if (outcome.kind === 'served') {
        sink.begin('video/mp4')
        sink.write(Buffer.from('ftyp'))
        sink.end(clipStreamTrailersFor(outcome.verdict))
      }
      return outcome
    },
  })
  return { dial, runs }
}

async function get(url: string, method = 'GET'): Promise<Response> {
  return await fetch(url, { method })
}

interface RawAnswer {
  readonly status: number
  readonly headers: NodeJS.Dict<string | string[]>
  readonly trailers: NodeJS.Dict<string>
}

/** `fetch` drops trailers on the floor, so the one thing this route says after
 *  its body has to be read with the client that keeps them. */
async function getRaw(url: string): Promise<RawAnswer> {
  return await new Promise<RawAnswer>((resolve, reject) => {
    httpGet(url, (res) => {
      res.resume()
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, trailers: res.trailers }),
      )
      res.on('error', reject)
    }).on('error', reject)
  })
}

describe('the clip stream dial', () => {
  it('serves the first GET and refuses the second BY NAME', async () => {
    const { dial, runs } = harness()
    const ticket = await dial.mint({ deviceId: 3836, clipKey: '1-2', audio: 'opus' })
    expect(ticket.kind).toBe('ticket')
    if (ticket.kind !== 'ticket') return
    expect(ticket.url.startsWith('http://127.0.0.1:')).toBe(true)

    const first = await get(ticket.url)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('video/mp4')
    await first.arrayBuffer()

    const second = await get(ticket.url)
    expect(second.status).toBe(410)
    expect(second.headers.get(CLIP_STREAM_REASON_CODE_HEADER)).toBe('dial-used')
    expect(second.headers.get(CLIP_STILL_REASON_HEADER)).toContain('already taken')
    // The camera was reached ONCE, for the one dial that was taken.
    expect(runs).toEqual([{ deviceId: 3836, clipKey: '1-2' }])
    await dial.dispose()
  })

  it('answers a HEAD without taking the dial or touching the camera', async () => {
    const { dial, runs } = harness()
    const ticket = await dial.mint({ deviceId: 3836, clipKey: '1-2', audio: 'none' })
    if (ticket.kind !== 'ticket') return
    const head = await get(ticket.url, 'HEAD')
    expect(head.status).toBe(200)
    expect(runs).toEqual([])
    expect(dial.outstanding).toBe(1)
    await dial.dispose()
  })

  it('refuses an unknown token as unknown, never as a clip that is gone', async () => {
    const { dial } = harness()
    const ticket = await dial.mint({ deviceId: 3836, clipKey: '1-2', audio: 'none' })
    if (ticket.kind !== 'ticket') return
    const base = ticket.url.slice(0, ticket.url.lastIndexOf('/'))
    const res = await get(`${base}/not-a-token`)
    expect(res.status).toBe(404)
    expect(res.headers.get(CLIP_STREAM_REASON_CODE_HEADER)).toBe('dial-unknown')
    await dial.dispose()
  })

  /**
   * D611. This repository writes its refusals in prose and an HTTP header
   * value is Latin-1: an em dash throws INSIDE the response handler, the
   * status is never written and the socket hangs — the reason header silencing
   * the reason it exists to carry. Every value goes through
   * `clipReasonHeaderValue`, and THIS is the test that fails if one does not.
   */
  it('carries a refusal whose prose has an em dash in it', async () => {
    const { dial } = harness({
      kind: 'refused',
      code: 'camera-refused',
      detail:
        'the camera answered 404 to the replay DESCRIBE — on this firmware that covers a ' +
        'session it has no budget for, so it is not a claim that this clip is gone',
    })
    const ticket = await dial.mint({ deviceId: 3836, clipKey: '1-2', audio: 'none' })
    if (ticket.kind !== 'ticket') return
    const res = await get(ticket.url)
    expect(res.status).toBe(502)
    expect(res.headers.get(CLIP_STREAM_REASON_CODE_HEADER)).toBe('camera-refused')
    expect(res.headers.get(CLIP_STILL_REASON_HEADER)).toContain('no budget')
    await dial.dispose()
  })

  it('says "come back" for a slot this node holds, and "the camera" for the camera', () => {
    expect(streamRefusalStatus('replay-busy')).toBe(503)
    expect(streamRefusalStatus('camera-refused')).toBe(502)
    expect(streamRefusalStatus('fetch-failed')).toBe(502)
  })

  it('bounds outstanding dials rather than growing a map', async () => {
    const { dial } = harness()
    const first = await dial.mint({ deviceId: 3836, clipKey: '1-2', audio: 'none' })
    if (first.kind !== 'ticket') return
    const wide = createClipStreamDial({
      logger: makeLogger(),
      maxOutstanding: 1,
      stream: async () => WHOLE,
    })
    expect((await wide.mint({ deviceId: 1, clipKey: '1-2', audio: 'none' })).kind).toBe('ticket')
    const refused = await wide.mint({ deviceId: 1, clipKey: '3-4', audio: 'none' })
    expect(refused.kind).toBe('refused')
    if (refused.kind === 'refused') expect(refused.code).toBe('dial-exhausted')
    await wide.dispose()
    await dial.dispose()
  })
})

/**
 * D623 on the wire. The route's status line is spent on the first fragment, so
 * a serve the camera cut short has only the trailer to say so with — and a
 * trailer that never arrives is the silence D391 forbids, one hop further out.
 */
describe('what a finished stream says after its body', () => {
  it('delivers the short-serve reason as HTTP trailers, and still answers HEAD 200', async () => {
    const short: ClipStreamOutcome = {
      kind: 'served',
      verdict: {
        kind: 'short',
        expectedSeconds: 45,
        deliveredSeconds: 4.26,
        shortfallSeconds: 40.74,
      },
    }
    const { dial } = harness(short)
    const ticket = await dial.mint({ deviceId: 3836, clipKey: '1-46', audio: 'opus' })
    if (ticket.kind !== 'ticket') throw new Error('no ticket')

    // The probe a consumer makes BEFORE it dials must survive the declaration:
    // Node throws `Trailers are invalid with this transfer encoding` from
    // inside `writeHead` on a response with no body, and a handler that throws
    // there writes no status at all (D611).
    expect((await get(ticket.url, 'HEAD')).status).toBe(200)

    const again = await dial.mint({ deviceId: 3836, clipKey: '1-46', audio: 'opus' })
    if (again.kind !== 'ticket') throw new Error('no ticket')
    const { status, headers, trailers } = await getRaw(again.url)
    expect(status).toBe(200)
    expect(headers['trailer']).toContain(CLIP_STILL_REASON_CODE_HEADER)
    expect(trailers[CLIP_STILL_REASON_CODE_HEADER]).toBe('stream-short')
    expect(trailers[CLIP_STILL_REASON_HEADER]).toContain('4.3 s of 45.0 s')

    await dial.dispose()
  })

  it('adds nothing after a whole clip — an absent trailer is "nothing to add"', async () => {
    const { dial } = harness()
    const ticket = await dial.mint({ deviceId: 3836, clipKey: '1-46', audio: 'opus' })
    if (ticket.kind !== 'ticket') throw new Error('no ticket')
    const { status, trailers } = await getRaw(ticket.url)
    expect(status).toBe(200)
    expect(trailers[CLIP_STILL_REASON_CODE_HEADER]).toBeUndefined()
    await dial.dispose()
  })
})
