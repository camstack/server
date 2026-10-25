/**
 * Unit tests for the bundled brand-icon HTTP surface.
 *
 * The addon serves an official SVG per notifier kind over its own
 * `addon-routes` provider and stamps a matching `iconUrl` onto each descriptor
 * returned by `listTargetKinds`. These tests exercise the route handler (SVG
 * body + content-type, 404 for an unknown kind) and the URL helper — no
 * network, no filesystem.
 */
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import type { AddonHttpReply, AddonHttpRequest, TargetKind, TargetKindCaps } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NotifierAdapter } from '../adapters/adapter.js'
import { iconMediaTypeFor, iconRoutes, hasIcon, iconUrlFor } from '../icon-routes.js'
import { NOTIFIER_ICONS } from '../icons-data.js'
import { createNotificationOutputProvider } from '../provider.js'
import { makeNotifiersRecords } from './fake-records.js'
import { TargetStore } from '../target-store.js'

/** Minimal capturing reply mirroring the Fastify-shaped `AddonHttpReply`. */
interface Captured {
  status: number
  contentType?: string
  headers: Record<string, string>
  body?: unknown
}

function capturingReply(): { reply: AddonHttpReply; captured: Captured } {
  const captured: Captured = { status: 200, headers: {} }
  const reply: AddonHttpReply = {
    status(code) {
      captured.status = code
      return reply
    },
    code(code) {
      captured.status = code
      return reply
    },
    type(mime) {
      captured.contentType = mime
      return reply
    },
    header(name, value) {
      captured.headers[name.toLowerCase()] = value
      return reply
    },
    send(data) {
      captured.body = data
    },
    redirect() {
      /* unused */
    },
  }
  return { reply, captured }
}

function request(
  params: Record<string, string>,
  headers: Record<string, string> = {},
): AddonHttpRequest {
  return { params, query: {}, body: undefined, headers }
}

async function invokeIconRoute(
  kind: string,
  headers: Record<string, string> = {},
): Promise<Captured | undefined> {
  const route = iconRoutes().find((r) => r.path === `/icons/${kind}`)
  if (route === undefined) return undefined
  const { reply, captured } = capturingReply()
  await route.handler(request({ kind }, headers), reply)
  return captured
}

/** The response body is always raw bytes now (never a string) — the route owns
 *  the content-coding. Decode back to the identity bytes for assertions. */
function decodeBody(res: Captured): Uint8Array {
  const body = res.body
  if (!(body instanceof Uint8Array)) throw new Error('icon body must be raw bytes')
  switch (res.headers['content-encoding']) {
    case 'br':
      return brotliDecompressSync(body)
    case 'gzip':
      return gunzipSync(body)
    case undefined:
      return body
    default:
      throw new Error(`unexpected content-encoding: ${res.headers['content-encoding']}`)
  }
}

const ALL_KINDS = Object.keys(NOTIFIER_ICONS)

describe('icon-routes — helpers', () => {
  it('reports an icon for every bundled kind', () => {
    for (const kind of ALL_KINDS) expect(hasIcon(kind)).toBe(true)
  })

  it('has no icon for an unknown kind', () => {
    expect(hasIcon('smoke-signal')).toBe(false)
    expect(iconUrlFor('smoke-signal')).toBeUndefined()
  })

  it('builds a stable root-relative addon URL per kind', () => {
    expect(iconUrlFor('zentik')).toBe('/addon/notifiers/icons/zentik')
    expect(iconUrlFor('telegram')).toBe('/addon/notifiers/icons/telegram')
    expect(iconUrlFor('email')).toBe('/addon/notifiers/icons/email')
  })
})

describe('icon-routes — route provider', () => {
  it('registers one public static GET route per bundled kind', () => {
    const routes = iconRoutes()
    expect(routes).toHaveLength(ALL_KINDS.length)
    for (const route of routes) {
      expect(route.method).toBe('GET')
      expect(route.access).toBe('public')
      // Static path (no `:param`) — survives the forked-addon route bridge.
      expect(route.path).not.toContain(':')
      expect(route.path).toMatch(/^\/icons\/[a-z]+$/)
    }
  })

  it('serves each bundled kind with its own content-type (bytes, identity by default)', async () => {
    for (const kind of ALL_KINDS) {
      const res = await invokeIconRoute(kind)
      expect(res).toBeDefined()
      expect(res!.status).toBe(200)
      expect(res!.contentType).toBe(NOTIFIER_ICONS[kind as keyof typeof NOTIFIER_ICONS].contentType)
      expect(res!.headers['cache-control']).toContain('max-age')
      // No Accept-Encoding on the request → identity bytes, no content-encoding,
      // and Vary so shared caches key on the coding.
      expect(res!.body).toBeInstanceOf(Uint8Array)
      expect(res!.headers['content-encoding']).toBeUndefined()
      expect(res!.headers['vary']).toBe('accept-encoding')
    }
  })

  it('serves the vector kinds as standalone SVG documents (no editor namespaces)', async () => {
    const svgKinds = ALL_KINDS.filter(
      (k) => NOTIFIER_ICONS[k as keyof typeof NOTIFIER_ICONS].contentType === 'image/svg+xml',
    )
    for (const kind of svgKinds) {
      const res = await invokeIconRoute(kind)
      expect(res!.contentType).toBe('image/svg+xml')
      const svg = Buffer.from(decodeBody(res!)).toString('utf8')
      expect(svg).toMatch(/^<svg[\s\S]*<\/svg>$/)
      // A browser <img> SVG renderer chokes on editor-tool namespaces — none
      // must survive in the bundled markup.
      expect(svg).not.toContain('sodipodi')
      expect(svg).not.toContain('inkscape')
      expect(svg).not.toContain('<switch')
      expect(svg).not.toContain('foreignObject')
    }
  })

  it('owns the content-coding so the hub compressor skips the bridged response', async () => {
    // A >1 KiB SVG is exactly what the hub's global compressor emptied on the
    // forked-addon route bridge. With `Accept-Encoding: br` we must return a
    // valid, self-framed brotli stream (content-encoding: br) — not defer to the
    // hub — that decodes back to the SVG markup.
    const res = await invokeIconRoute('discord', { 'accept-encoding': 'gzip, deflate, br' })
    expect(res!.contentType).toBe('image/svg+xml')
    expect(res!.headers['content-encoding']).toBe('br')
    expect(res!.body).toBeInstanceOf(Uint8Array)
    const svg = brotliDecompressSync(res!.body as Uint8Array).toString('utf8')
    expect(svg).toMatch(/^<svg[\s\S]*<\/svg>$/)

    // gzip-only clients get gzip; a client that names no supported coding gets
    // identity bytes with no content-encoding.
    const gz = await invokeIconRoute('discord', { 'accept-encoding': 'gzip' })
    expect(gz!.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(gz!.body as Uint8Array).toString('utf8')).toMatch(/^<svg/)
    const idn = await invokeIconRoute('discord', { 'accept-encoding': 'identity' })
    expect(idn!.headers['content-encoding']).toBeUndefined()
  })

  it('serves zentik as raw PNG bytes (not an SVG-wrapped data URI)', async () => {
    const res = await invokeIconRoute('zentik')
    expect(res!.contentType).toBe('image/png')
    const bytes = decodeBody(res!)
    // PNG magic number: 89 50 4E 47 0D 0A 1A 0A.
    expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  })

  it('registers no route for an unknown kind', async () => {
    expect(await invokeIconRoute('smoke-signal')).toBeUndefined()
  })
})

// ── iconUrl stamping on listTargetKinds ─────────────────────────────

const CAPS: TargetKindCaps = {
  attachments: { mediaTypes: [], mode: 'url', max: 0 },
  actions: 0,
  levels: [{ id: 'normal', label: 'Normal', ordinal: 3 }],
  format: ['text'],
  clickUrl: false,
  sound: false,
  ttl: false,
  bodyMaxLen: 1000,
}

function adapter(kind: string): NotifierAdapter {
  const descriptor: TargetKind = {
    kind,
    label: kind,
    icon: 'bell',
    addonId: 'notifiers',
    configSchema: { sections: [] },
    supportsDiscovery: false,
    caps: CAPS,
  }
  return {
    descriptor,
    destinationKeys: ['url'],
    buildRequest: () => ({ url: 'http://x', body: { kind: 'json', value: {} } }),
  }
}

describe('provider.listTargetKinds — iconUrl stamping', () => {
  it('stamps iconUrl for a kind that has a bundled icon, omits it otherwise', async () => {
    const store = TargetStore.of((await makeNotifiersRecords()).records)
    const provider = createNotificationOutputProvider({
      store,
      adapters: [adapter('telegram'), adapter('smoke-signal')],
      iconUrlFor,
    })
    const kinds = await provider.listTargetKinds({})
    const telegram = kinds.find((k) => k.kind === 'telegram')
    const smoke = kinds.find((k) => k.kind === 'smoke-signal')
    expect((telegram as { iconUrl?: string }).iconUrl).toBe('/addon/notifiers/icons/telegram')
    expect((smoke as { iconUrl?: string }).iconUrl).toBeUndefined()
  })

  it('stamps no iconUrl at all when iconUrlFor is not provided', async () => {
    const store = TargetStore.of((await makeNotifiersRecords()).records)
    const provider = createNotificationOutputProvider({ store, adapters: [adapter('telegram')] })
    const [telegram] = await provider.listTargetKinds({})
    expect((telegram as { iconUrl?: string }).iconUrl).toBeUndefined()
  })
})

/**
 * The media type must travel WITH the URL.
 *
 * A React-Native client draws SVG and raster through different components and
 * cannot infer the type from the URL — the route path deliberately carries no
 * file extension. Without this field expo-image was handed `image/svg+xml`,
 * failed silently, and 7 of the 8 brand icons fell back to a placeholder glyph
 * on mobile while the web build looked correct.
 */
describe('provider.listTargetKinds — iconMediaType stamping', () => {
  it('stamps the real media type beside the URL, per kind', async () => {
    const store = TargetStore.of((await makeNotifiersRecords()).records)
    const provider = createNotificationOutputProvider({
      store,
      adapters: [adapter('telegram'), adapter('zentik'), adapter('smoke-signal')],
      iconUrlFor,
      iconMediaTypeFor,
    })
    const kinds = await provider.listTargetKinds({})

    // The vector kinds — the ones that were broken on mobile.
    expect(kinds.find((k) => k.kind === 'telegram')?.iconMediaType).toBe('image/svg+xml')
    // zentik ships as a raster PNG (an SVG wrapping a data: URI is refused by
    // the strict <img> parser), so it must NOT be routed to the SVG renderer.
    expect(kinds.find((k) => k.kind === 'zentik')?.iconMediaType).toBe('image/png')
    // No bundled icon → neither field is stamped.
    const smoke = kinds.find((k) => k.kind === 'smoke-signal')
    expect(smoke?.iconUrl).toBeUndefined()
    expect(smoke?.iconMediaType).toBeUndefined()
  })

  it('omits iconMediaType when the resolver is not wired (legacy provider)', async () => {
    const store = TargetStore.of((await makeNotifiersRecords()).records)
    const provider = createNotificationOutputProvider({
      store,
      adapters: [adapter('telegram')],
      iconUrlFor,
    })
    const kinds = await provider.listTargetKinds({})
    expect(kinds[0]?.iconUrl).toBe('/addon/notifiers/icons/telegram')
    expect(kinds[0]?.iconMediaType).toBeUndefined()
  })
})
