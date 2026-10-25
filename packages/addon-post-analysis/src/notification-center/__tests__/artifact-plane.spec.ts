import { promises as fs } from 'node:fs'
import { makeNcRecords } from './support/nc-test-deps.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcArtifactIndex } from '../artifact-index.js'
import { collectArtifactEndpoints, NcArtifactPlane } from '../artifact-plane.js'
import { NcArtifactStore } from '../artifact-store.js'
import { type ArtifactEndpoint, pickArtifactBaseUrl } from '../artifact-url.js'

const SECRET = 'plane-secret'
const PREFIX = '/addon/pipeline-analytics/nc-artifact'
let dir: string
let clock = 5_000_000

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-plane-'))
  clock = 5_000_000
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

// Priority 0 — exactly what `local-network` gives its PREFERRED interface. The
// first version of this fixture used 10, so a tunnel ranked 10 tied and won by
// insertion order; in production the LAN won every time and the test stayed
// green for the wrong reason.
const LAN: ArtifactEndpoint = { baseUrl: 'https://hub.lan:4443', kind: 'lan-ipv4', priority: 0 }
const LOOPBACK: ArtifactEndpoint = {
  baseUrl: 'https://127.0.0.1:4443',
  kind: 'loopback',
  priority: 1000,
}

async function makePlane(
  endpoints: readonly ArtifactEndpoint[],
): Promise<{ plane: NcArtifactPlane; listEndpoints: ReturnType<typeof vi.fn> }> {
  const store = new NcArtifactStore({ rootDir: dir, logger: makeSilentLogger(), now: () => clock })
  await store.start()
  const listEndpoints = vi.fn(async () => endpoints)
  const plane = new NcArtifactPlane({
    store,
    secret: SECRET,
    logger: makeSilentLogger(),
    listEndpoints,
    routePrefix: PREFIX,
    now: () => clock,
  })
  return { plane, listEndpoints }
}

/** A minimal ServerResponse double capturing status/headers/body. */
function fakeRes(): {
  res: ServerResponse
  status: () => number
  headers: () => Record<string, string>
  body: () => Buffer | string | undefined
} {
  let status = 0
  let headers: Record<string, string> = {}
  let body: Buffer | string | undefined
  const res = {
    writeHead: (s: number, h?: Record<string, string>) => {
      status = s
      headers = h ?? {}
    },
    end: (b?: Buffer | string) => {
      body = b
    },
  }
  return {
    res: res as unknown as ServerResponse,
    status: () => status,
    headers: () => headers,
    body: () => body,
  }
}

const reqFor = (url: string): IncomingMessage => ({ url }) as IncomingMessage

describe('NcArtifactPlane', () => {
  it('publishes a link the handler then serves', async () => {
    const { plane } = await makePlane([LAN])
    const url = await plane.publish(new Uint8Array([1, 2, 3, 4]), 'image/jpeg')
    expect(url).not.toBeNull()
    expect(url?.startsWith('https://hub.lan:4443/addon/')).toBe(true)

    const parsed = new URL(url ?? '')
    const out = fakeRes()
    await plane.handler(reqFor(`${parsed.pathname}${parsed.search}`), out.res)
    expect(out.status()).toBe(200)
    expect(out.headers()['content-type']).toBe('image/jpeg')
    expect(Buffer.from(out.body() ?? '')).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  // Loopback-only means the recipient could never open the link. Shipping
  // bytes alone is the correct degrade — the notification still carries media.
  it('returns null (bytes-only) when every endpoint is loopback', async () => {
    const { plane } = await makePlane([LOOPBACK])
    expect(await plane.publish(new Uint8Array([1]), 'image/jpeg')).toBeNull()
  })

  it('never throws when the endpoint lookup fails — an URL is an enhancement', async () => {
    const store = new NcArtifactStore({
      rootDir: dir,
      logger: makeSilentLogger(),
      now: () => clock,
    })
    await store.start()
    const plane = new NcArtifactPlane({
      store,
      secret: SECRET,
      logger: makeSilentLogger(),
      listEndpoints: async () => {
        throw new Error('local-network unreachable')
      },
      routePrefix: PREFIX,
      now: () => clock,
    })
    expect(await plane.publish(new Uint8Array([1]), 'image/jpeg')).toBeNull()
  })

  it('404s a tampered signature, an expired link and an unknown id ALIKE', async () => {
    const { plane } = await makePlane([LAN])
    const url = new URL((await plane.publish(new Uint8Array([9]), 'image/jpeg')) ?? '')

    const tampered = fakeRes()
    await plane.handler(
      reqFor(`${url.pathname}?exp=${url.searchParams.get('exp')}&sig=deadbeef`),
      tampered.res,
    )
    expect(tampered.status()).toBe(404)

    const expired = fakeRes()
    clock += 48 * 3600_000
    await plane.handler(reqFor(`${url.pathname}${url.search}`), expired.res)
    expect(expired.status()).toBe(404)
    // Same body for every rejection — a public route that distinguishes them
    // is an oracle for guessing ids.
    expect(String(expired.body())).toBe(String(tampered.body()))
  })

  it('caches the endpoint lookup across publishes', async () => {
    const { plane, listEndpoints } = await makePlane([LAN])
    await plane.publish(new Uint8Array([1]), 'image/jpeg')
    await plane.publish(new Uint8Array([2]), 'image/jpeg')
    expect(listEndpoints).toHaveBeenCalledTimes(1)
  })

  // The store files per camera inside the eventMedia class — a publish that
  // knows the device must say so, or the artifact lands in the 0 bucket and
  // stops being attributable ("do not invent a device id" cuts both ways).
  it('files a device-attributed publish under that camera bucket', async () => {
    const { plane } = await makePlane([LAN])
    const url = await plane.publish(new Uint8Array([1, 2]), 'image/jpeg', 42)
    expect(url).not.toBeNull()
    const names = await fs.readdir(path.join(dir, '42', 'nc-artifacts'))
    expect(names).toHaveLength(1)
  })
})

// `mintUrl` — the getHistory → artefact link (2026-08-26). A history row
// carries an artefact ID; this is what turns that id back into a fetchable
// URL on demand, without re-storing bytes.
describe('NcArtifactPlane.mintUrl', () => {
  const RETENTION_MS = 60_000

  async function makeIndexedPlane(
    endpoints: readonly ArtifactEndpoint[],
  ): Promise<{ plane: NcArtifactPlane; index: NcArtifactIndex }> {
    const store = new NcArtifactStore({
      rootDir: dir,
      logger: makeSilentLogger(),
      now: () => clock,
    })
    await store.start()
    const world = makeNcRecords()
    const index = new NcArtifactIndex({
      records: world.records,
      logger: makeSilentLogger(),
      addonId: 'pipeline-analytics',
      retentionMs: RETENTION_MS,
      now: () => clock,
    })
    const plane = new NcArtifactPlane({
      store,
      secret: SECRET,
      index,
      logger: makeSilentLogger(),
      listEndpoints: async () => endpoints,
      routePrefix: PREFIX,
      now: () => clock,
    })
    return { plane, index }
  }

  it('mints a fresh signed URL for an artefact already on the shelf — no re-store', async () => {
    const { plane } = await makeIndexedPlane([LAN])
    const pub = await plane.publishIndexed(new Uint8Array([1, 2, 3]), 'image/jpeg', {
      kind: 'event-still',
      deviceId: 104,
      deviceIds: [104],
      capturedAt: clock,
    })
    expect(pub.artifactId).not.toBeNull()

    // The indexed publish carries the camera in its meta — the bytes must land
    // in that camera's bucket, not the unattributed one.
    const keptNames = await fs.readdir(path.join(dir, '104', 'nc-artifacts', 'kept'))
    expect(keptNames).toEqual([`${pub.artifactId}.jpg`])

    const minted = await plane.mintUrl(pub.artifactId ?? '')
    expect(minted).not.toBeNull()
    expect(minted).toContain('nc-artifact')

    const parsed = new URL(minted ?? '')
    const out = fakeRes()
    await plane.handler(reqFor(`${parsed.pathname}${parsed.search}`), out.res)
    expect(out.status()).toBe(200)
    expect(Buffer.from(out.body() ?? '')).toEqual(Buffer.from([1, 2, 3]))
  })

  it('degrades to null for an unknown id — never a broken link', async () => {
    const { plane } = await makeIndexedPlane([LAN])
    expect(await plane.mintUrl('never-existed')).toBeNull()
  })

  it('degrades to null once the artefact has expired past the shelf retention', async () => {
    const { plane } = await makeIndexedPlane([LAN])
    const pub = await plane.publishIndexed(new Uint8Array([1]), 'image/jpeg', {
      kind: 'event-still',
      deviceId: 104,
      deviceIds: [104],
      capturedAt: clock,
    })
    expect(await plane.mintUrl(pub.artifactId ?? '')).not.toBeNull()
    clock += RETENTION_MS + 1
    expect(await plane.mintUrl(pub.artifactId ?? '')).toBeNull()
  })

  it('degrades to null when no index is wired at all', async () => {
    const { plane } = await makePlane([LAN])
    expect(await plane.mintUrl('anything')).toBeNull()
  })

  it('degrades to null when no externally-reachable base URL exists', async () => {
    const { plane } = await makeIndexedPlane([LOOPBACK])
    const pub = await plane.publishIndexed(new Uint8Array([1]), 'image/jpeg', {
      kind: 'event-still',
      deviceId: 104,
      deviceIds: [104],
      capturedAt: clock,
    })
    expect(await plane.mintUrl(pub.artifactId ?? '')).toBeNull()
  })
})

describe('collectArtifactEndpoints', () => {
  const logger = makeSilentLogger()

  it('falls back to the LAN address when nothing public is configured', async () => {
    const out = await collectArtifactEndpoints({
      getConnected: async () => null,
      listExternal: async () => [],
      listLan: async () => [LAN, LOOPBACK],
      logger,
    })
    expect(pickArtifactBaseUrl(out)).toBe(LAN.baseUrl)
  })

  it('a failing source contributes nothing instead of failing the list', async () => {
    const out = await collectArtifactEndpoints({
      getConnected: async () => null,
      listExternal: async () => {
        throw new Error('network-access down')
      },
      listLan: async () => [LAN],
      logger,
    })
    expect(pickArtifactBaseUrl(out)).toBe(LAN.baseUrl)
  })

  it('skips a non-https tunnel', async () => {
    const out = await collectArtifactEndpoints({
      getConnected: async () => null,
      listExternal: async () => [{ url: 'http://plain.example', protocol: 'http' }],
      listLan: async () => [LAN],
      logger,
    })
    expect(pickArtifactBaseUrl(out)).toBe(LAN.baseUrl)
  })
})

describe('collectArtifactEndpoints — the CONNECTED single ingress', () => {
  const logger = makeSilentLogger()

  // The live hub had a connected `https://camstack…` tunnel while
  // `listEndpoints` answered `[]` (the cap lets a single-endpoint provider omit
  // that method entirely), so the first artifact link ever minted went out on
  // the LAN address.
  it('prefers the connected tunnel over the LAN even when listEndpoints is empty', async () => {
    const out = await collectArtifactEndpoints({
      getConnected: async () => ({ url: 'https://cams.example.top', protocol: 'https' }),
      listExternal: async () => [],
      listLan: async () => [LAN],
      logger,
    })
    expect(pickArtifactBaseUrl(out)).toBe('https://cams.example.top')
  })

  it('ignores a DISCONNECTED ingress', async () => {
    const out = await collectArtifactEndpoints({
      getConnected: async () => null,
      listExternal: async () => [],
      listLan: async () => [LAN],
      logger,
    })
    expect(pickArtifactBaseUrl(out)).toBe(LAN.baseUrl)
  })
})

describe('collectArtifactEndpoints — the hub PUBLIC ENDPOINT (D734)', () => {
  const logger = makeSilentLogger()

  it('outranks the connected tunnel and the LAN', async () => {
    const out = await collectArtifactEndpoints({
      publicEndpoint: 'https://public.example',
      getConnected: async () => ({ url: 'https://tunnel.example', protocol: 'https' }),
      listExternal: async () => [],
      listLan: async () => [LAN],
      logger,
    })
    expect(pickArtifactBaseUrl(out)).toBe('https://public.example')
  })

  it('the CamStack app link is never a hub base — media keeps the hub ladder', async () => {
    const out = await collectArtifactEndpoints({
      publicEndpoint: 'https://camstack.zentik.app',
      getConnected: async () => ({ url: 'https://tunnel.example', protocol: 'https' }),
      listExternal: async () => [],
      listLan: async () => [LAN],
      logger,
    })
    expect(pickArtifactBaseUrl(out)).toBe('https://tunnel.example')
    expect(out.some((e) => e.baseUrl.includes('zentik'))).toBe(false)
  })

  it('an unreadable public endpoint falls back to the ingress ladder', async () => {
    const out = await collectArtifactEndpoints({
      getConnected: async () => ({ url: 'https://tunnel.example', protocol: 'https' }),
      listExternal: async () => [],
      listLan: async () => [LAN],
      logger,
    })
    expect(pickArtifactBaseUrl(out)).toBe('https://tunnel.example')
  })
})
