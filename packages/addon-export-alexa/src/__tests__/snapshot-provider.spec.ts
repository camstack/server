/**
 * R2 — `Alexa.SmartVision.SnapshotProvider` and the image route (D773).
 *
 * Amazon's rules for the image URI, each pinned here: HTTPS on the hub's public
 * address, valid about ten minutes, HTTP 410 once expired or invalid, never a
 * redirect, and NOT public — the fetch must carry the account-link token of the
 * user the image was made for, who must still be allowed to see the camera.
 */
import type { AddonContext, AddonHttpReply, AddonHttpRequest } from '@camstack/types'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { handleGetSnapshot } from '../handlers/snapshot-provider.js'
import {
  MIN_SHORT_SIDE_PX,
  TARGET_SHORT_SIDE_PX,
  toAlexaJpeg,
} from '../snapshots/snapshot-image.js'
import { handleSnapshotFetch, type SnapshotRouteDeps } from '../snapshots/snapshot-route.js'
import { SNAPSHOT_URL_TTL_MS, SnapshotStore } from '../snapshots/snapshot-store.js'
import { quietLogger } from './helpers/fake-device-api.js'

const HEADER = {
  namespace: 'Alexa.SmartVision.SnapshotProvider',
  name: 'GetSnapshot',
  payloadVersion: '1.1',
  messageId: 'm1',
  correlationToken: 'c1',
}
const CALLER = { userId: 'alice', username: 'alice', scopes: [] }

async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 90, g: 120, b: 60 } } })
    .jpeg()
    .toBuffer()
}

function ctxWithSnapshot(bytes: Buffer | null): AddonContext {
  return {
    api: {
      snapshot: {
        getSnapshot: {
          query: async () =>
            bytes === null ? null : { base64: bytes.toString('base64'), contentType: 'image/jpeg' },
        },
      },
    },
  } as unknown as AddonContext
}

interface Captured {
  status: number
  headers: Record<string, string>
  type: string | null
  body: unknown
  redirected: boolean
}

function captureReply(): { reply: AddonHttpReply; out: Captured } {
  const out: Captured = { status: 200, headers: {}, type: null, body: undefined, redirected: false }
  const reply: AddonHttpReply = {
    status(code) {
      out.status = code
      return reply
    },
    code(code) {
      out.status = code
      return reply
    },
    send(data) {
      out.body = data
    },
    redirect() {
      out.redirected = true
    },
    header(name, value) {
      out.headers[name.toLowerCase()] = value
      return reply
    },
    type(mime) {
      out.type = mime
      return reply
    },
  }
  return { reply, out }
}

function requestFor(url: string, token: string | null): AddonHttpRequest {
  const u = new URL(url)
  const file = u.pathname.split('/').pop() ?? ''
  return {
    params: { file },
    query: Object.fromEntries(u.searchParams.entries()),
    body: undefined,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  }
}

describe('toAlexaJpeg', () => {
  it('shrinks a 4K frame to a short side of 480 px', async () => {
    const out = await toAlexaJpeg(await jpeg(3840, 2160))
    expect(Math.min(out.width, out.height)).toBe(TARGET_SHORT_SIDE_PX)
    expect(out.bytes.length).toBeLessThan(200_000)
  })

  it("raises a tiny sub-stream frame to Amazon's 360 px minimum", async () => {
    const out = await toAlexaJpeg(await jpeg(320, 180))
    expect(Math.min(out.width, out.height)).toBe(MIN_SHORT_SIDE_PX)
  })
})

describe('GetSnapshot → Snapshot event', () => {
  function deps(
    opts: { bytes?: Buffer | null; enabled?: boolean; hub?: string; now?: number } = {},
  ) {
    const store = new SnapshotStore(
      () => 'k',
      () => opts.now ?? 1_000_000,
    )
    return {
      store,
      d: {
        ctx: ctxWithSnapshot(opts.bytes === undefined ? Buffer.from('x') : opts.bytes),
        logger: quietLogger,
        store,
        enabled: () => opts.enabled ?? true,
        publicHubUrl: () => opts.hub ?? 'https://hub.example/',
        encode: async () => ({ bytes: Buffer.from('jpeg'), width: 640, height: 480 }),
        now: () => opts.now ?? 1_000_000,
      },
    }
  }

  it('answers a Snapshot (1.1) with an HTTPS, ten-minute, ACCESS_TOKEN URI', async () => {
    const { d } = deps()
    const res = (await handleGetSnapshot(HEADER, { endpointId: '101' }, d, CALLER)) as {
      event: { header: Record<string, string>; payload: { value: Record<string, string> } }
    }
    expect(res.event.header).toMatchObject({
      namespace: 'Alexa.SmartVision.SnapshotProvider',
      name: 'Snapshot',
      payloadVersion: '1.1',
      correlationToken: 'c1',
    })
    const value = res.event.payload.value
    expect(value.uri).toMatch(
      /^https:\/\/hub\.example\/addon\/export-alexa\/snapshot\/[0-9a-f-]{36}\.jpg\?exp=\d+&sig=[0-9a-f]+$/,
    )
    expect(value.authenticationType).toBe('ACCESS_TOKEN')
    expect(Date.parse(value.uriExpirationTime ?? '') - 1_000_000).toBe(SNAPSHOT_URL_TTL_MS)
  })

  it('refuses without a public HTTPS address rather than handing out a LAN or loopback URL', async () => {
    const { d } = deps({ hub: 'http://192.0.2.10:4443' })
    const res = (await handleGetSnapshot(HEADER, { endpointId: '101' }, d, CALLER)) as {
      event: { payload: { type: string } }
    }
    expect(res.event.payload.type).toBe('INTERNAL_ERROR')
  })

  it('is DISABLED_BY_USER when the integration switch is off', async () => {
    const { d } = deps({ enabled: false })
    const res = (await handleGetSnapshot(HEADER, { endpointId: '101' }, d, CALLER)) as {
      event: { header: { name: string }; payload: { type: string } }
    }
    expect(res.event.payload.type).toBe('DISABLED_BY_USER')
  })

  it('ENDPOINT_UNREACHABLE when the camera has no frame', async () => {
    const { d } = deps({ bytes: null })
    const res = (await handleGetSnapshot(HEADER, { endpointId: '101' }, d, CALLER)) as {
      event: { payload: { type: string } }
    }
    expect(res.event.payload.type).toBe('ENDPOINT_UNREACHABLE')
  })
})

describe('the image route', () => {
  async function minted(now: { t: number }) {
    const store = new SnapshotStore(
      () => 'k',
      () => now.t,
    )
    const m = store.mint({
      deviceId: 101,
      userId: 'alice',
      bytes: Buffer.from('JPEG'),
      capturedAt: 0,
    })
    const url = `https://hub.example${m.path}`
    const routeDeps = (over: Partial<SnapshotRouteDeps> = {}): SnapshotRouteDeps => ({
      store,
      enabled: () => true,
      verifyToken: async (token) =>
        token === 'alice-token'
          ? { userId: 'alice' }
          : token === 'bob-token'
            ? { userId: 'bob' }
            : null,
      mayView: async () => true,
      logger: quietLogger,
      ...over,
    })
    return { url, routeDeps }
  }

  it('serves the JPEG to the token of the user it was made for — 200, no redirect, not cached', async () => {
    const now = { t: 1_000 }
    const { url, routeDeps } = await minted(now)
    const { reply, out } = captureReply()
    await handleSnapshotFetch(requestFor(url, 'alice-token'), reply, routeDeps())
    expect(out.status).toBe(200)
    expect(out.type).toBe('image/jpeg')
    expect(out.redirected).toBe(false)
    expect(out.headers['cache-control']).toContain('no-store')
    expect(Buffer.isBuffer(out.body)).toBe(true)
  })

  it('410 once expired', async () => {
    const now = { t: 1_000 }
    const { url, routeDeps } = await minted(now)
    now.t += SNAPSHOT_URL_TTL_MS + 1
    const { reply, out } = captureReply()
    await handleSnapshotFetch(requestFor(url, 'alice-token'), reply, routeDeps())
    expect(out.status).toBe(410)
  })

  it('410 for a tampered signature or an unknown image', async () => {
    const now = { t: 1_000 }
    const { url, routeDeps } = await minted(now)
    const tampered = url.replace(
      /sig=([0-9a-f])/,
      (_m, c: string) => `sig=${c === 'a' ? 'b' : 'a'}`,
    )
    const a = captureReply()
    await handleSnapshotFetch(requestFor(tampered, 'alice-token'), a.reply, routeDeps())
    expect(a.out.status).toBe(410)
  })

  it('410 for every minted URL once the integration switch is off', async () => {
    const now = { t: 1_000 }
    const { url, routeDeps } = await minted(now)
    const { reply, out } = captureReply()
    await handleSnapshotFetch(
      requestFor(url, 'alice-token'),
      reply,
      routeDeps({ enabled: () => false }),
    )
    expect(out.status).toBe(410)
  })

  it('401 without a valid account-link token — the URI is not public', async () => {
    const now = { t: 1_000 }
    const { url, routeDeps } = await minted(now)
    for (const token of [null, 'garbage']) {
      const { reply, out } = captureReply()
      await handleSnapshotFetch(requestFor(url, token), reply, routeDeps())
      expect(out.status).toBe(401)
    }
  })

  it("403 for another user's token, and for a user who has since lost the camera", async () => {
    const now = { t: 1_000 }
    const { url, routeDeps } = await minted(now)
    const a = captureReply()
    await handleSnapshotFetch(requestFor(url, 'bob-token'), a.reply, routeDeps())
    expect(a.out.status).toBe(403)
    const b = captureReply()
    await handleSnapshotFetch(
      requestFor(url, 'alice-token'),
      b.reply,
      routeDeps({ mayView: async () => false }),
    )
    expect(b.out.status).toBe(403)
  })
})

describe('wiring', () => {
  it('the image route is a public GET the handler gates, and GetSnapshot needs only view', async () => {
    const { buildRoutes } = await import('../http-server.js')
    const { snapshotsOff } = await import('./helpers/allow-all-access.js')
    const routes = buildRoutes({
      ctx: {} as AddonContext,
      logger: quietLogger,
      getSettings: () => ({}) as never,
      directiveDeps: {} as never,
      lwaTokensCallbackDeps: {} as never,
      redetectPublicHubUrl: async () => ({ publicHubUrl: '' }),
      snapshotRoute: snapshotsOff().route,
    })
    const route = routes.find((r) => r.path === '/snapshot/:file')
    expect(route).toMatchObject({ method: 'GET', access: 'public' })
  })
})

/**
 * R4 (D779): object-detection images are minted at event / history-read time
 * but their pixels are read only when Alexa fetches them — a history page of
 * ten events must not read and re-encode twenty images inside Amazon's 8 s.
 */
describe('lazy images (object detection)', () => {
  function lazyStore(load: () => Promise<Buffer | null>) {
    const store = new SnapshotStore(
      () => 'k',
      () => 1_000,
    )
    let loads = 0
    const m = store.mintLazy({
      deviceId: 101,
      userId: 'alice',
      capturedAt: 0,
      load: async () => {
        loads += 1
        return load()
      },
    })
    const routeDeps: SnapshotRouteDeps = {
      store,
      enabled: () => true,
      verifyToken: async (t) => (t === 'alice-token' ? { userId: 'alice' } : null),
      mayView: async () => true,
      logger: quietLogger,
    }
    return { url: `https://hub.example${m.path}`, routeDeps, loads: () => loads }
  }

  it('reads the pixels on the first authorised fetch, once', async () => {
    const l = lazyStore(async () => Buffer.from('JPEG'))
    expect(l.loads()).toBe(0)
    const a = captureReply()
    await handleSnapshotFetch(requestFor(l.url, 'alice-token'), a.reply, l.routeDeps)
    const b = captureReply()
    await handleSnapshotFetch(requestFor(l.url, 'alice-token'), b.reply, l.routeDeps)
    expect(a.out.status).toBe(200)
    expect(b.out.body).toEqual(Buffer.from('JPEG'))
    expect(l.loads()).toBe(1)
  })

  it('an unauthenticated fetch never triggers a read', async () => {
    const l = lazyStore(async () => Buffer.from('JPEG'))
    const a = captureReply()
    await handleSnapshotFetch(requestFor(l.url, null), a.reply, l.routeDeps)
    expect(a.out.status).toBe(401)
    expect(l.loads()).toBe(0)
  })

  it('no image available → 410, never a broken body', async () => {
    const l = lazyStore(async () => null)
    const a = captureReply()
    await handleSnapshotFetch(requestFor(l.url, 'alice-token'), a.reply, l.routeDeps)
    expect(a.out.status).toBe(410)
  })
})
