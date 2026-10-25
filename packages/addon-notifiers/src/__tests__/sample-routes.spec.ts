/**
 * The bundled test-notification samples.
 *
 * These exist because the test panel used to attach `https://example.com/...`
 * — a domain that serves no media — so every "does this target deliver an
 * image / gif / video" test was broken by construction. The guarantees worth
 * pinning are therefore: the bytes really ship, they are the media type they
 * claim, and they stay small enough that no adapter rejects them.
 */
import type { AddonHttpReply, AddonHttpRequest } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { hasSample, sampleRoutes, sampleUrlFor } from '../sample-routes.js'

/** The tightest attachment cap across every shipped adapter (pushover, 5 MiB). */
const TIGHTEST_ADAPTER_CAP_BYTES = 5_242_880

interface Captured {
  status: number
  headers: Record<string, string>
  body: unknown
  contentType: string
}

function capturingReply(): { reply: AddonHttpReply; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: undefined, contentType: '' }
  const reply = {
    code(status: number) {
      captured.status = status
      return reply
    },
    type(value: string) {
      captured.contentType = value
      return reply
    },
    header(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value
      return reply
    },
    send(body: unknown) {
      captured.body = body
      return reply
    },
  } as unknown as AddonHttpReply
  return { reply, captured }
}

function request(): AddonHttpRequest {
  return { params: {}, query: {}, body: undefined, headers: {} } as AddonHttpRequest
}

async function invokeSample(name: string): Promise<Captured | undefined> {
  const route = sampleRoutes().find((r) => r.path === `/samples/${name}`)
  if (route === undefined) return undefined
  const { reply, captured } = capturingReply()
  await route.handler(request(), reply)
  return captured
}

/** Media type → the magic bytes that prove the file is what it says it is. */
const MAGIC: ReadonlyArray<{ name: string; contentType: string; magic: readonly number[] }> = [
  { name: 'image', contentType: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { name: 'gif', contentType: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  // MP4: `ftyp` at offset 4.
  { name: 'video', contentType: 'video/mp4', magic: [0x66, 0x74, 0x79, 0x70] },
  { name: 'icon', contentType: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
]

describe('sample-routes — the bundled test media', () => {
  it('exposes a root-relative URL per media type, and nothing else', () => {
    for (const name of ['image', 'gif', 'video', 'audio', 'icon']) {
      expect(hasSample(name)).toBe(true)
      expect(sampleUrlFor(name)).toBe(`/addon/notifiers/samples/${name}`)
    }
    expect(hasSample('nope')).toBe(false)
    expect(sampleUrlFor('nope')).toBeUndefined()
  })

  it('registers one public static GET route per sample', () => {
    const routes = sampleRoutes()
    expect(routes).toHaveLength(5)
    for (const route of routes) {
      expect(route.method).toBe('GET')
      expect(route.access).toBe('public')
      // Static path (no `:param`) — a param route is clobbered by the
      // forked-addon route bridge, same as the icons.
      expect(route.path).not.toContain(':')
    }
  })

  for (const { name, contentType, magic } of MAGIC) {
    it(`serves \`${name}\` as real ${contentType} bytes`, async () => {
      const captured = await invokeSample(name)
      expect(captured).toBeDefined()
      expect(captured?.status).toBe(200)
      expect(captured?.contentType).toBe(contentType)

      const body = captured?.body
      expect(body).toBeInstanceOf(Uint8Array)
      const bytes = body as Uint8Array
      // MP4 carries `ftyp` at offset 4; every other type leads with its magic.
      const offset = name === 'video' ? 4 : 0
      expect([...bytes.slice(offset, offset + magic.length)]).toEqual([...magic])
    })
  }

  it('declares an explicit identity content-encoding', async () => {
    // The hub pipes addon-route replies through @fastify/compress, which emits
    // an EMPTY brotli stream on the forked-addon bridge for a compressible body
    // over 1 KiB. Declaring a content-encoding is what makes it skip us — and
    // these media are already compressed, so identity is the honest value.
    const captured = await invokeSample('image')
    expect(captured?.headers['content-encoding']).toBe('identity')
    expect(captured?.headers['content-length']).toBeDefined()
  })

  it('keeps every sample under the tightest adapter attachment cap', async () => {
    for (const { name } of MAGIC) {
      const captured = await invokeSample(name)
      const bytes = captured?.body as Uint8Array
      expect(bytes.byteLength).toBeGreaterThan(0)
      expect(bytes.byteLength).toBeLessThan(TIGHTEST_ADAPTER_CAP_BYTES)
    }
  })
})
