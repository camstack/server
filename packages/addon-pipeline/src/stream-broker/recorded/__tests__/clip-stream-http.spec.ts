/**
 * The `node:http` half of the clip-stream opener, against a real listener.
 *
 * The case that matters here is the one the hub hit on 2026-09-23: a provider
 * that has QUEUED the request and will not send a status line for thirty
 * seconds, and a broker that has already abandoned it. Until the opener took
 * a signal there was no lever at all — `connection.destroy()` exists only
 * once the response headers have arrived — so the socket stayed open for the
 * full `CLIP_STREAM_HEADERS_TIMEOUT_MS` and the provider's strictly-serial
 * per-host lane could not shed a single entry.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CLIP_STILL_REASON_CODE_HEADER,
  CLIP_STILL_REASON_HEADER,
  CLIP_STREAM_TRANSPORT_HEADER,
} from '@camstack/types'
import { createHttpClipStreamOpener } from '../clip-stream-http'
import type { ClipIncompleteReport, ClipStreamHandlers } from '../clip-stream-feeder'

const NO_OP_HANDLERS: ClipStreamHandlers = {
  onData: () => undefined,
  onEnd: () => undefined,
  onError: () => undefined,
}

interface Listener {
  readonly server: Server
  readonly url: string
}

async function listen(
  onRequest: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Listener> {
  const server = createServer(onRequest)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${String(address.port)}/tok` }
}

describe('createHttpClipStreamOpener', () => {
  let listener: Listener | null = null

  beforeEach(() => {
    listener = null
  })
  afterEach(async () => {
    const held = listener
    if (held !== null) await new Promise<void>((resolve) => held.server.close(() => resolve()))
  })

  it('aborting the signal CLOSES the socket at the provider before any status line', async () => {
    let closed = false
    const closedAt = new Promise<void>((resolve) => {
      void listen((req) => {
        // A queued request: no status line, ever. The only way this socket
        // goes is the caller hanging up.
        req.on('close', () => {
          closed = true
          resolve()
        })
      }).then((l) => {
        listener = l
        const controller = new AbortController()
        const opener = createHttpClipStreamOpener({ headersTimeoutMs: 60_000 })
        const opened = opener(l.url, NO_OP_HANDLERS, controller.signal)
        setTimeout(() => controller.abort(new Error('clip-stream-abandoned')), 50)
        void opened.then((value) => {
          expect(value).toMatchObject({ kind: 'refused', code: 'abandoned' })
        })
      })
    })
    await closedAt
    expect(closed).toBe(true)
  })

  it('a signal already aborted never dials at all', async () => {
    let requests = 0
    listener = await listen((_req, res) => {
      requests += 1
      res.writeHead(200, { [CLIP_STREAM_TRANSPORT_HEADER]: 'forward-only' })
      res.end()
    })
    const controller = new AbortController()
    controller.abort(new Error('clip-stream-abandoned'))
    const opener = createHttpClipStreamOpener()
    const opened = await opener(listener.url, NO_OP_HANDLERS, controller.signal)
    expect(opened).toMatchObject({ kind: 'refused', code: 'abandoned' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(requests).toBe(0)
  })

  it('an ordinary forward-only stream still opens and delivers', async () => {
    listener = await listen((_req, res) => {
      res.writeHead(200, { [CLIP_STREAM_TRANSPORT_HEADER]: 'forward-only' })
      res.end(Buffer.from([1, 2, 3]))
    })
    const chunks: number[] = []
    const ended = new Promise<void>((resolve) => {
      void createHttpClipStreamOpener()(
        listener?.url ?? '',
        {
          onData: (chunk) => chunks.push(...chunk),
          onEnd: () => resolve(),
          onError: () => resolve(),
        },
        new AbortController().signal,
      ).then((opened) => {
        expect(opened.kind).toBe('open')
      })
    })
    await ended
    expect(chunks).toEqual([1, 2, 3])
  })
})

/**
 * D623: the provider's last word arrives AFTER the body, because a stream's
 * status line is spent on its first fragment. A hop that drops it turns a clip
 * the camera truncated back into a silent success.
 */
describe('the trailers a finished clip stream carries', () => {
  let listener: Listener | null = null
  afterEach(async () => {
    const held = listener
    listener = null
    if (held !== null) await new Promise<void>((resolve) => held.server.close(() => resolve()))
  })

  async function endedWith(
    write: (res: ServerResponse) => void,
  ): Promise<ClipIncompleteReport | null | 'never'> {
    let seen: ClipIncompleteReport | null | 'never' = 'never'
    const ended = new Promise<void>((resolve) => {
      void listen((_req, res) => {
        res.writeHead(200, {
          'content-type': 'video/mp4',
          [CLIP_STREAM_TRANSPORT_HEADER]: 'forward-only',
          trailer: `${CLIP_STILL_REASON_CODE_HEADER}, ${CLIP_STILL_REASON_HEADER}`,
        })
        res.write(Buffer.from('ftyp'))
        write(res)
        res.end()
      }).then((l) => {
        listener = l
        void createHttpClipStreamOpener()(
          l.url,
          {
            onData: () => undefined,
            onEnd: (report) => {
              seen = report
              resolve()
            },
            onError: () => undefined,
          },
          new AbortController().signal,
        )
      })
    })
    await ended
    return seen
  }

  it('reads a short serve out of the trailer, code and sentence', async () => {
    expect(
      await endedWith((res) =>
        res.addTrailers({
          [CLIP_STILL_REASON_CODE_HEADER]: 'stream-short',
          [CLIP_STILL_REASON_HEADER]: 'the camera ended this replay early: 4.3 s of 45.0 s',
        }),
      ),
    ).toEqual({
      code: 'stream-short',
      reason: 'the camera ended this replay early: 4.3 s of 45.0 s',
    })
  })

  it('reads an empty serve as its own code, never as a 100 % shortfall', async () => {
    expect(
      await endedWith((res) =>
        res.addTrailers({ [CLIP_STILL_REASON_CODE_HEADER]: 'stream-empty' }),
      ),
      // A code whose sentence a proxy dropped still branches: the code stands
      // in for the prose rather than the report being thrown away.
    ).toEqual({ code: 'stream-empty', reason: 'stream-empty' })
  })

  it('reports null when a whole stream added nothing, and ignores a code it cannot act on', async () => {
    expect(await endedWith(() => undefined)).toBeNull()
    expect(
      await endedWith((res) =>
        res.addTrailers({ [CLIP_STILL_REASON_CODE_HEADER]: 'completeness-unverified' }),
      ),
    ).toBeNull()
  })
})
