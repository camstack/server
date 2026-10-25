/**
 * The third data-plane route: `/clip-stream/<deviceId>/<clipKey>.mp4`.
 *
 * A plain `200` with no length, written on the FIRST muxed byte — until then
 * every refusal still owns the status line, so a camera that serves nothing
 * answers a status and a reason, never an empty 200. Not `Range`-able, and it
 * says so in its own headers rather than pretending.
 */
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import {
  CLIP_STREAM_PREFIX,
  CLIP_STREAM_TRANSPORT_HEADER,
  createClipStreamHandler,
  type ClipStreamTarget,
  type ClipStreamHandlerDeps,
  type ClipStreamRouteOutcome,
  type ClipStreamRouteSink,
} from '../clips/clip-data-plane.js'
import type { ReolinkClipRow } from '../clips/clip-catalog.js'
import type { GateClipDeviceOutcome } from '../clips/clip-service.js'
import type { ClipDeviceRef } from '../clips/reolink-videoclips-provider.js'
import { createClipStreamRoute } from '../clips/clip-stream-route.js'
import type {
  ClipStreamInput,
  ClipStreamOutcome,
  ClipStreamProducer,
} from '../clips/clip-stream.js'
import { createRecordingLogger } from './clip-test-logger.js'

interface Captured {
  status: number
  headers: Record<string, unknown>
  body: Buffer
  destroyed: boolean
}

function fakeExchange(url: string, options: { method?: string; range?: string } = {}) {
  const captured: Captured = { status: 0, headers: {}, body: Buffer.alloc(0), destroyed: false }
  const chunks: Buffer[] = []
  const res = new PassThrough()
  const settled = new Promise<Captured>((resolve) => {
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    const done = (): void => {
      captured.body = Buffer.concat(chunks)
      captured.destroyed = res.destroyed && !res.writableFinished
      resolve(captured)
    }
    res.on('finish', done)
    res.on('close', done)
  })
  Object.assign(res, {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, unknown>) {
      captured.status = status
      captured.headers = headers ?? {}
      Object.assign(res, { headersSent: true })
      return res
    },
  })
  const req = {
    url,
    method: options.method ?? 'GET',
    headers: options.range === undefined ? {} : { range: options.range },
  }
  return { req, res, settled }
}

const KEY = 'a'.repeat(40)

/** A producer that streams `body` into the sink and reports `outcome`. */
function streaming(body: readonly string[], outcome: ClipStreamRouteOutcome = { kind: 'served' }) {
  const stream = vi.fn(async (_target: ClipStreamTarget, sink: ClipStreamRouteSink) => {
    sink.begin('video/mp4')
    for (const piece of body) sink.write(Buffer.from(piece))
    sink.end()
    return outcome
  })
  return stream
}

function handler(stream: ClipStreamHandlerDeps['stream']) {
  const logger = createRecordingLogger()
  return { run: createClipStreamHandler({ stream, logger }), logger }
}

describe('the clip stream route', () => {
  it('lives beside the file route under its own prefix', () => {
    expect(CLIP_STREAM_PREFIX).toBe('clip-stream')
  })

  it('answers a plain 200 with no length, not Range-able, not cacheable, and says what it is', async () => {
    const stream = streaming(['ftyp', 'moov', 'moof+mdat'])
    const { run } = handler(stream)
    const { req, res, settled } = fakeExchange(`/107/${KEY}.mp4`)
    await run(req as never, res as never)
    const out = await settled
    expect(out.status).toBe(200)
    expect(out.headers['content-type']).toBe('video/mp4')
    expect(out.headers['accept-ranges']).toBe('none')
    expect(out.headers['cache-control']).toBe('no-store')
    expect(out.headers[CLIP_STREAM_TRANSPORT_HEADER]).toBe('forward-only')
    expect(out.headers['content-length']).toBeUndefined()
    expect(out.headers['content-range']).toBeUndefined()
    expect(out.body.toString()).toBe('ftypmoovmoof+mdat')
    // The route is told WHICH twin and WHICH audio; the path form negotiates
    // neither, and says so rather than leaving the producer to guess (D600).
    expect(stream).toHaveBeenCalledWith(
      { deviceId: 107, clipKey: KEY, twin: 'sub', audio: 'none' },
      expect.anything(),
    )
  })

  it('ignores a Range header — there is no length to range over — and logs that it did', async () => {
    const { run, logger } = handler(streaming(['x']))
    const debug = vi.fn()
    Object.assign(logger, { debug })
    const { req, res, settled } = fakeExchange(`/107/${KEY}.mp4`, { range: 'bytes=100-' })
    await run(req as never, res as never)
    const out = await settled
    expect(out.status).toBe(200)
    expect(out.headers['content-range']).toBeUndefined()
    expect(out.body.toString()).toBe('x')
  })

  it('answers HEAD with the stream headers and touches no camera', async () => {
    const stream = streaming(['x'])
    const { run } = handler(stream)
    const { req, res, settled } = fakeExchange(`/107/${KEY}.mp4`, { method: 'HEAD' })
    await run(req as never, res as never)
    const out = await settled
    expect(out.status).toBe(200)
    expect(out.headers['accept-ranges']).toBe('none')
    expect(out.body.byteLength).toBe(0)
    expect(stream).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown-device', 404],
    ['no-catalog-row', 404],
    ['sleeping', 409],
    ['uid-missing', 409],
    ['clip-in-progress', 409],
    ['camera-refused', 502],
    ['fetch-failed', 502],
  ] as const)('answers a refusal `%s` as %d with the reason in its headers, logged per camera', async (code, status) => {
    const stream = vi.fn(
      async () => ({ kind: 'refused', code, detail: `${code}: the reason` }) as const,
    )
    const { run, logger } = handler(stream)
    const { req, res, settled } = fakeExchange(`/107/${KEY}.mp4`)
    await run(req as never, res as never)
    const out = await settled
    expect(out.status).toBe(status)
    expect(out.headers['x-camstack-reason-code']).toBe(code)
    expect(String(out.headers['x-camstack-reason'])).toContain(code)
    expect(out.body.byteLength).toBe(0)
    const line = logger.infos.find((l) => l.message.includes('not served'))
    expect(line?.extras.tags).toEqual({ deviceId: 107 })
    expect(line?.extras.meta?.['code']).toBe(code)
    expect(line?.extras.meta?.['status']).toBe(status)
  })

  it('leaves a CUT stream alone — the producer already severed the peer', async () => {
    const stream = vi.fn(async (_t: ClipStreamTarget, sink: ClipStreamRouteSink) => {
      sink.begin('video/mp4')
      sink.write(Buffer.from('half'))
      sink.destroy()
      return { kind: 'cut' } as const
    })
    const { run } = handler(stream)
    const { req, res, settled } = fakeExchange(`/107/${KEY}.mp4`)
    await run(req as never, res as never)
    const out = await settled
    expect(out.status).toBe(200)
    expect(out.destroyed).toBe(true)
  })

  it('answers 500 when the producer throws before the status line, and severs after it', async () => {
    const before = handler(
      vi.fn(async () => {
        throw new Error('defect')
      }),
    )
    const a = fakeExchange(`/107/${KEY}.mp4`)
    await before.run(a.req as never, a.res as never)
    expect((await a.settled).status).toBe(500)
    expect(before.logger.warns.find((l) => l.message.includes('threw'))?.extras.tags).toEqual({
      deviceId: 107,
    })

    const after = handler(
      vi.fn(async (_t: ClipStreamTarget, sink: ClipStreamRouteSink) => {
        sink.begin('video/mp4')
        sink.write(Buffer.from('half'))
        throw new Error('defect')
      }),
    )
    const b = fakeExchange(`/107/${KEY}.mp4`)
    await after.run(b.req as never, b.res as never)
    const out = await b.settled
    expect(out.status).toBe(200)
    expect(out.destroyed).toBe(true)
  })

  it('refuses a method that is not GET or HEAD, and a path that is not a clip', async () => {
    const stream = streaming(['x'])
    const { run } = handler(stream)
    const post = fakeExchange(`/107/${KEY}.mp4`, { method: 'POST' })
    await run(post.req as never, post.res as never)
    expect((await post.settled).status).toBe(405)
    const bad = fakeExchange(`/107/../etc/passwd.mp4`)
    await run(bad.req as never, bad.res as never)
    expect((await bad.settled).status).toBe(400)
    expect(stream).not.toHaveBeenCalled()
  })
})

/**
 * The route's own decision: which FILE it opens, and what it tells the
 * producer to carry.
 *
 * Until D600 this module opened `row.subFileName` unconditionally while the
 * dial's answer already claimed `served: 'high'` for a `high` ask — the
 * silent 33x substitution D576 forbids, produced by the one call site D599
 * had not told. `chooseClipTwin` decides once, on the dial; the route obeys.
 */
describe('createClipStreamRoute: the twin and the audio it was told', () => {
  const ROW: ReolinkClipRow = {
    clipKey: KEY,
    channel: 0,
    subFileName: '/mnt/sda/RecS.mp4',
    mainFileName: '/mnt/sda/RecM.mp4',
    startMs: 1_790_000_000_000,
    endMs: 1_790_000_025_000,
    supportSub: true,
    nativeTypes: ['md'],
  }
  const DEVICE: ClipDeviceRef = {
    deviceId: 107,
    channel: 0,
    uid: undefined,
    isHubChild: false,
    isBattery: false,
    sleeping: false,
    timeZone: 'Europe/Rome',
    hostKey: 'h',
    getApi: async () => {
      throw new Error('the route must not reach the camera in this spec')
    },
  }

  function routeHarness(row: Partial<ReolinkClipRow> = {}) {
    const logger = createRecordingLogger()
    const stream = vi.fn(
      async (_input: ClipStreamInput): Promise<ClipStreamOutcome> => ({
        kind: 'cut',
        reason: 'peer-closed',
        detail: 'the spec does not serve bytes',
        bytesOut: 0,
      }),
    )
    const producer: ClipStreamProducer = { stream, active: () => 0 }
    const route = createClipStreamRoute({
      logger,
      gate: async (): Promise<GateClipDeviceOutcome> => ({ kind: 'ok', device: DEVICE }),
      rowFor: () => ({ ...ROW, ...row }),
      producer,
    })
    return { route, stream, logger }
  }

  it('opens the MAIN file for a `main` twin and the SUB file for a `sub` one', async () => {
    const main = routeHarness()
    await main.route({ deviceId: 107, clipKey: KEY, twin: 'main', audio: 'opus' }, sinkStub())
    expect(main.stream.mock.calls[0]?.[0]).toMatchObject({
      fileName: '/mnt/sda/RecM.mp4',
      twin: 'main',
      audio: 'opus',
    })
    const sub = routeHarness()
    await sub.route({ deviceId: 107, clipKey: KEY, twin: 'sub', audio: 'none' }, sinkStub())
    expect(sub.stream.mock.calls[0]?.[0]).toMatchObject({
      fileName: '/mnt/sda/RecS.mp4',
      twin: 'sub',
      audio: 'none',
    })
  })

  it('REFUSES a `main` twin the row has no handle for, rather than serving the sub copy', async () => {
    const h = routeHarness({ mainFileName: undefined })
    const outcome = await h.route(
      { deviceId: 107, clipKey: KEY, twin: 'main', audio: 'none' },
      sinkStub(),
    )
    expect(outcome).toMatchObject({ kind: 'refused', code: 'no-catalog-row' })
    expect(h.stream).not.toHaveBeenCalled()
    const warn = h.logger.warns.find((l) => l.message.includes('no byte handle for the twin'))
    expect(warn?.extras.tags).toEqual({ deviceId: 107 })
  })
})

function sinkStub(): ClipStreamRouteSink {
  return {
    begin: () => {},
    write: () => true,
    onceDrain: () => {},
    onceClose: () => {},
    end: () => {},
    destroy: () => {},
  }
}
