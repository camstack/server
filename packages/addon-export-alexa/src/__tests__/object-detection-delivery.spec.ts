/**
 * R4 (D779, amended 2026-10-08): what has to hold for an `ObjectDetection` event to
 * land in the camera's history in the Alexa app — measured on the live hub
 * 2026-10-08, where 300 events in 20 min were accepted (202) and the history
 * stayed empty.
 *
 *  - `objectIdentifier` is a VERSION-4 UUID (Amazon's field table); the first
 *    build sent a UUIDv5.
 *  - An image URI handed to Alexa stays resolvable for its whole ten minutes:
 *    the store's count bound (128) evicted lazy entries after ~4 minutes at
 *    that event rate, so a late fetch got a 410.
 *  - Every fetch of an image URI is logged with its outcome: without it, "did
 *    Amazon ever fetch the image?" could not be answered.
 *  - One redacted copy of the outgoing body is logged, so the shape on the
 *    wire can be compared with Amazon's example without a debugger.
 *  - At most one event per camera and class per 30 s: fragmented tracks of
 *    the same few people posted one event every ~8 s on one camera.
 */
import type { AddonHttpReply, AddonHttpRequest, IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { redactedObjectDetectionSample } from '../lwa-event-gateway.js'
import { handleSnapshotFetch } from '../snapshots/snapshot-route.js'
import { SNAPSHOT_URL_TTL_MS, SnapshotStore } from '../snapshots/snapshot-store.js'
import {
  CAMERA_EVENT_MIN_INTERVAL_MS,
  ObjectDetectionFeed,
  type VisionDetection,
} from '../vision/object-detection-feed.js'
import { objectIdentifierFor } from '../vision/vision-ids.js'
import { quietLogger } from './helpers/fake-device-api.js'

const NS = '6f1c2a54-1d0e-4c8b-9a52-0c3f7d2e9b11'
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

interface Logged {
  readonly level: string
  readonly msg: string
  readonly meta: Record<string, unknown>
}

function recordingLogger(): { logger: IScopedLogger; lines: Logged[] } {
  const lines: Logged[] = []
  const at =
    (level: string) =>
    (msg: string, ctx?: { meta?: Record<string, unknown> }): void => {
      lines.push({ level, msg, meta: ctx?.meta ?? {} })
    }
  const logger: IScopedLogger = {
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    debug: at('debug'),
    withTags: () => logger,
    child: () => logger,
  }
  return { logger, lines }
}

function reply(): { reply: AddonHttpReply; status: () => number } {
  let status = 200
  const r: AddonHttpReply = {
    status(code) {
      status = code
      return r
    },
    code(code) {
      status = code
      return r
    },
    send() {},
    redirect() {},
    header() {
      return r
    },
    type() {
      return r
    },
  }
  return { reply: r, status: () => status }
}

function request(path: string, token: string | null, ua?: string): AddonHttpRequest {
  const u = new URL(`https://hub.example${path}`)
  return {
    params: { file: u.pathname.split('/').pop() ?? '' },
    query: Object.fromEntries(u.searchParams.entries()),
    body: undefined,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(ua === undefined ? {} : { 'user-agent': ua }),
    },
  }
}

describe('objectIdentifier', () => {
  it('is a version-4 UUID, stable for the track', () => {
    const id = objectIdentifierFor(NS, 587, 'tv0qvxtxf7')
    expect(id).toMatch(V4)
    expect(objectIdentifierFor(NS, 587, 'tv0qvxtxf7')).toBe(id)
  })
})

describe('lazy image URIs live their whole ten minutes', () => {
  it('600 lazy URIs minted in a row are all still resolvable', () => {
    const now = { t: 1_000 }
    const store = new SnapshotStore(
      () => 'k',
      () => now.t,
    )
    const minted = Array.from({ length: 600 }, () =>
      store.mintLazy({ deviceId: 112, userId: 'u', capturedAt: 0, load: async () => null }),
    )
    now.t += SNAPSHOT_URL_TTL_MS - 1
    const first = minted[0]!
    const u = new URL(`https://hub.example${first.path}`)
    const found = store.lookup(
      first.imageId,
      u.searchParams.get('exp') ?? undefined,
      u.searchParams.get('sig') ?? undefined,
    )
    expect(found.kind).toBe('found')
  })
})

describe('every image fetch is logged with its outcome', () => {
  function setup() {
    const store = new SnapshotStore(
      () => 'k',
      () => 1_000,
    )
    const m = store.mintLazy({
      deviceId: 112,
      userId: 'alice',
      capturedAt: 0,
      load: async () => Buffer.from('JPEG'),
    })
    const { logger, lines } = recordingLogger()
    const deps = {
      store,
      enabled: () => true,
      verifyToken: async (t: string) => (t === 'alice-token' ? { userId: 'alice' } : null),
      mayView: async () => true,
      logger,
    }
    return { path: m.path, deps, lines }
  }

  it('a served image logs 200, its size and the fetcher, and never the signature', async () => {
    const s = setup()
    const r = reply()
    await handleSnapshotFetch(
      request(s.path, 'alice-token', 'AmazonImageFetcher/1'),
      r.reply,
      s.deps,
    )
    expect(r.status()).toBe(200)
    const line = s.lines.find((l) => l.msg.startsWith('alexa snapshot: fetch'))
    expect(line?.level).toBe('info')
    expect(line?.meta).toMatchObject({
      status: 200,
      bytes: 4,
      lazy: true,
      userAgent: 'AmazonImageFetcher/1',
    })
    expect(JSON.stringify(s.lines)).not.toMatch(/sig=|alice-token/)
  })

  it('a refused fetch logs its status and reason', async () => {
    const s = setup()
    const r = reply()
    await handleSnapshotFetch(
      request(s.path.replace(/sig=./, 'sig=z'), 'alice-token'),
      r.reply,
      s.deps,
    )
    expect(r.status()).toBe(410)
    const line = s.lines.find((l) => l.msg.startsWith('alexa snapshot: fetch'))
    expect(line?.meta).toMatchObject({ status: 410, reason: 'bad-signature' })
  })
})

describe('the logged body sample', () => {
  it('keeps the shape, drops the token and every URL signature', () => {
    const sample = redactedObjectDetectionSample({
      userId: 'u',
      endpointId: '587',
      detections: [
        {
          eventIdentifier: '2b3409df-d686-4a52-9bba-d361860bac61',
          imageNetClass: 'person',
          objectIdentifier: '573409df-5486-4c52-b4ba-d361860bac73',
          frameImageUri: 'https://hub.example/addon/export-alexa/snapshot/a.jpg?exp=5&sig=SECRET1',
          croppedImageUri:
            'https://hub.example/addon/export-alexa/snapshot/b.jpg?exp=5&sig=SECRET2',
        },
      ],
      timestamp: Date.UTC(2026, 9, 8, 15, 45, 12, 340),
      accessToken: 'Atza|REALTOKEN',
    })
    const text = JSON.stringify(sample)
    expect(text).not.toMatch(/SECRET|REALTOKEN/)
    expect(text).toContain('sig=<redacted>')
    expect(sample.event.endpoint.scope).toEqual({ type: 'BearerToken', token: '<redacted>' })
    expect(sample.event.payload.events[0]).toMatchObject({
      eventIdentifier: '2b3409df-d686-4a52-9bba-d361860bac61',
      imageNetClass: 'person',
      timeOfSample: '2026-10-08T15:45:12.340Z',
    })
  })
})

describe('per-camera rate', () => {
  function harness() {
    const posted: VisionDetection[] = []
    let now = 1_700_000_000_000
    const feed = new ObjectDetectionFeed({
      eventBus: { subscribe: () => () => {} } as never,
      reportableClasses: async () => ['person', 'package'],
      namespace: () => NS,
      post: async (_d, detection) => {
        posted.push(detection)
      },
      remember: async () => {},
      logger: quietLogger,
      now: () => now,
    })
    const track = (trackId: string, phase: 'start' | 'update', cls = 'person', deviceId = 112) =>
      feed.onTrackLifecycle({ deviceId, trackId, phase, bestClassName: cls })
    return { posted, track, advance: (ms: number) => (now += ms) }
  }

  it('fragmented tracks of one camera post at most one event per class per window', async () => {
    const h = harness()
    await h.track('a', 'start')
    h.advance(8_000)
    await h.track('b', 'start')
    h.advance(8_000)
    await h.track('c', 'start')
    expect(h.posted.map((d) => d.trackId)).toEqual(['a'])
  })

  it('a track still present once the window has passed is reported then', async () => {
    const h = harness()
    await h.track('a', 'start')
    await h.track('b', 'start')
    h.advance(CAMERA_EVENT_MIN_INTERVAL_MS)
    await h.track('b', 'update')
    expect(h.posted.map((d) => d.trackId)).toEqual(['a', 'b'])
  })

  it('other cameras and other classes are not held back', async () => {
    const h = harness()
    await h.track('a', 'start')
    await h.track('x', 'start', 'person', 104)
    await h.track('p', 'start', 'package')
    expect(h.posted.map((d) => d.trackId)).toEqual(['a', 'x', 'p'])
  })
})
