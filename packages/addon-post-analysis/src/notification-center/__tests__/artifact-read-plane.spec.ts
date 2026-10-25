import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeNcRecords } from './support/nc-test-deps.js'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { NcArtifactIndex } from '../artifact-index.js'
import { NcArtifactStore } from '../artifact-store.js'
import { NcArtifactReadPlane, parseByteRange } from '../artifact-read-plane.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'

const RETENTION_MS = 14 * 24 * 3600_000
let dir: string
let clock = 1_700_000_000_000

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-read-plane-'))
  clock = 1_700_000_000_000
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

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

const reqFor = (
  url: string,
  headers: Record<string, string> = {},
  method = 'GET',
): IncomingMessage => ({ url, headers, method }) as unknown as IncomingMessage

interface Harness {
  readonly plane: NcArtifactReadPlane
  readonly index: NcArtifactIndex
  readonly store: NcArtifactStore
}

async function makeHarness(): Promise<Harness> {
  const store = new NcArtifactStore({ rootDir: dir, logger: makeSilentLogger(), now: () => clock })
  await store.start()
  const world = makeNcRecords()
  const index = new NcArtifactIndex({
    records: world.records,
    logger: makeSilentLogger(),
    addonId: 'pipeline-analytics',
    retentionMs: RETENTION_MS,
    now: () => clock,
  })
  return {
    plane: new NcArtifactReadPlane({ index, store, logger: makeSilentLogger() }),
    index,
    store,
  }
}

const payload = (n: number): Uint8Array =>
  new Uint8Array(Array.from({ length: n }, (_, i) => i % 251))

async function seed(h: Harness, bytes: Uint8Array, mime = 'video/mp4'): Promise<string> {
  const art = await h.store.put(bytes, mime, { retain: true, deviceId: 102 })
  await h.index.record({
    id: art.id,
    kind: 'timelapse',
    mime,
    sizeBytes: art.bytes,
    capturedAt: clock,
    deviceId: 102,
    deviceIds: [102],
  })
  return art.id
}

describe('parseByteRange', () => {
  it('answers null when there is nothing to honour', () => {
    expect(parseByteRange(undefined, 100)).toBeNull()
    expect(parseByteRange('bytes=-', 100)).toBeNull()
    expect(parseByteRange('items=0-10', 100)).toBeNull()
    // Multi-range: answered whole rather than wrongly.
    expect(parseByteRange('bytes=0-10,20-30', 100)).toBeNull()
  })

  it('parses a closed range and clamps the end to the payload', () => {
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseByteRange('bytes=90-999', 100)).toEqual({ start: 90, end: 99 })
  })

  it('parses an open-ended range', () => {
    expect(parseByteRange('bytes=10-', 100)).toEqual({ start: 10, end: 99 })
  })

  it('parses a suffix range as the LAST n bytes', () => {
    expect(parseByteRange('bytes=-20', 100)).toEqual({ start: 80, end: 99 })
    expect(parseByteRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
  })

  it('reports a range that cannot exist as unsatisfiable, never as a 200', () => {
    expect(parseByteRange('bytes=100-200', 100)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=50-10', 100)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=-0', 100)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=0-10', 0)).toBe('unsatisfiable')
  })
})

describe('NcArtifactReadPlane', () => {
  it('serves an indexed artefact whole', async () => {
    const h = await makeHarness()
    const id = await seed(h, payload(64))
    const out = fakeRes()
    await h.plane.handler(reqFor(`/addon/pipeline-analytics/nc-artifact-read/${id}`), out.res)
    expect(out.status()).toBe(200)
    expect(out.headers()['content-type']).toBe('video/mp4')
    expect(out.headers()['content-length']).toBe('64')
    expect(out.headers()['accept-ranges']).toBe('bytes')
    expect(Buffer.from(out.body() ?? '').byteLength).toBe(64)
  })

  it('answers a byte range with 206 and a content-range', async () => {
    const h = await makeHarness()
    const id = await seed(h, payload(100))
    const out = fakeRes()
    await h.plane.handler(
      reqFor(`/addon/pipeline-analytics/nc-artifact-read/${id}`, { range: 'bytes=10-19' }),
      out.res,
    )
    expect(out.status()).toBe(206)
    expect(out.headers()['content-range']).toBe('bytes 10-19/100')
    expect(out.headers()['content-length']).toBe('10')
    expect(Buffer.from(out.body() ?? '')).toEqual(Buffer.from(payload(100).subarray(10, 20)))
  })

  it('answers 416 for a range that cannot exist', async () => {
    const h = await makeHarness()
    const id = await seed(h, payload(10))
    const out = fakeRes()
    await h.plane.handler(
      reqFor(`/addon/pipeline-analytics/nc-artifact-read/${id}`, { range: 'bytes=100-200' }),
      out.res,
    )
    expect(out.status()).toBe(416)
    expect(out.headers()['content-range']).toBe('bytes */10')
  })

  it('answers HEAD with the metadata and no body', async () => {
    const h = await makeHarness()
    const id = await seed(h, payload(42))
    const out = fakeRes()
    await h.plane.handler(
      reqFor(`/addon/pipeline-analytics/nc-artifact-read/${id}`, {}, 'HEAD'),
      out.res,
    )
    expect(out.status()).toBe(200)
    expect(out.headers()['content-length']).toBe('42')
    expect(out.body()).toBeUndefined()
  })

  // The id is not a filesystem path and an unindexed artefact is not fetchable
  // here — the scratch shelf is the SIGNED plane's business, not this one's.
  it('refuses an id that is not in the index', async () => {
    const h = await makeHarness()
    const art = await h.store.put(payload(8), 'image/jpeg')
    const out = fakeRes()
    await h.plane.handler(reqFor(`/addon/pipeline-analytics/nc-artifact-read/${art.id}`), out.res)
    expect(out.status()).toBe(404)
  })

  it('refuses a traversal-shaped id', async () => {
    const h = await makeHarness()
    const out = fakeRes()
    await h.plane.handler(
      reqFor('/addon/pipeline-analytics/nc-artifact-read/..%2F..%2Fetc%2Fpasswd'),
      out.res,
    )
    expect(out.status()).toBe(404)
  })

  // The one failure an operator reports as "the app shows a broken tile".
  it('404s and LOGS when the row outlived its bytes', async () => {
    const h = await makeHarness()
    const id = await seed(h, payload(16))
    // The seed's record names deviceId 102, so the bytes filed under that
    // camera bucket of the artifacts-class layout.
    await fs.rm(path.join(dir, '102', 'nc-artifacts', 'kept', `${id}.mp4`), {
      force: true,
    })
    const out = fakeRes()
    await h.plane.handler(reqFor(`/addon/pipeline-analytics/nc-artifact-read/${id}`), out.res)
    expect(out.status()).toBe(404)
  })
})
