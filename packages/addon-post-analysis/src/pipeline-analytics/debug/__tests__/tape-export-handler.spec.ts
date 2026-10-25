/**
 * `GET|HEAD /addon/pipeline-analytics/tape-export?tapeId=…` — admin plane
 * (level in `data-plane-access.ts`).
 *
 * Fix round 1: `unknown` (no such row, 404), `unavailable` (the row exists
 * but this node cannot serve ANY tape, 503, tagged when a deviceId is known)
 * and `read-failed` (this node can serve tapes, but THIS read didn't land —
 * a release racing the download, 500, tagged) are three different things
 * (M1/M2). `HEAD` answers from the index row alone — it must never reach
 * `loadBundle` (M3). 400/405 refusals are logged too (L1).
 *
 * Disarm (kept from the original round): answer 200 with an empty body for
 * an unknown tape — the 404 test must fail.
 */
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { makeLogRecorder } from '../../__tests__/test-helpers.js'
import {
  sampleEnd,
  sampleFrame,
  sampleHeader,
} from '../../tracking-bench/__tests__/tape-fixtures.js'
import { type BundleParts, parseBundle } from '../../tracking-bench/bundle.js'
import {
  createTapeExportHandler,
  type TapeBundleLoad,
  type TapeBundlePeek,
} from '../tape-export-handler.js'

const PARTS: BundleParts = {
  manifest: {
    tapeId: 'promo-0001',
    deviceId: 102,
    scenario: '102-pairs-and-cars',
    lighting: 'day',
    durationMs: 0,
    frames: 1,
    skips: 0,
    gaps: 0,
    reviewed: true,
    recordedDate: '2026-09-29',
  },
  gt: { version: 1, reviewed: true, relations: [], purities: [], external: [] },
  tape: {
    header: sampleHeader({ deviceId: 102 }),
    body: [sampleFrame(0)],
    end: sampleEnd({ durationMs: 0, frames: 1 }),
  },
}

/** `unavail-0000`: a row this node has no shelf to serve (M1). `racing-0000`:
 *  a row this node CAN serve, but whose file lost a race with a delete (M2). */
function peekOutcome(tapeId: string): TapeBundlePeek {
  if (tapeId === 'promo-0001') return { kind: 'ok', deviceId: 102, scenario: '102-pairs-and-cars' }
  if (tapeId === 'unavail-0000')
    return { kind: 'unavailable', reason: 'tapes-not-started', deviceId: 900 }
  return { kind: 'unknown' }
}

function loadOutcome(tapeId: string): TapeBundleLoad {
  if (tapeId === 'promo-0001') return { kind: 'ok', parts: PARTS }
  if (tapeId === 'unavail-0000')
    return { kind: 'unavailable', reason: 'tapes-not-started', deviceId: 900 }
  if (tapeId === 'racing-0000')
    return { kind: 'read-failed', reason: 'ENOENT: no such file', deviceId: 102 }
  return { kind: 'unknown' }
}

interface Answer {
  readonly status: number
  readonly body: Buffer
  readonly disposition: string | null
  readonly entries: ReturnType<typeof makeLogRecorder>['entries']
  readonly peekCalls: readonly string[]
  readonly loadCalls: readonly string[]
}

/** A real HTTP round trip: the handler owns a real `ServerResponse`. */
async function call(pathAndQuery: string, method = 'GET'): Promise<Answer> {
  const { logger, entries } = makeLogRecorder()
  const peekCalls: string[] = []
  const loadCalls: string[] = []
  const handler = createTapeExportHandler({
    peekTape: async (id) => {
      peekCalls.push(id)
      return peekOutcome(id)
    },
    loadBundle: async (id) => {
      loadCalls.push(id)
      return loadOutcome(id)
    },
    logger,
    now: () => Date.now(),
  })
  const server = createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const response = await fetch(`http://127.0.0.1:${String(address.port)}${pathAndQuery}`, {
      method,
    })
    const body = Buffer.from(await response.arrayBuffer())
    return {
      status: response.status,
      body,
      disposition: response.headers.get('content-disposition'),
      entries,
      peekCalls,
      loadCalls,
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('tape-export handler', () => {
  it('refuses a request without a tape id, logged', async () => {
    const r = await call('/addon/pipeline-analytics/tape-export')
    expect(r.status).toBe(400)
    expect(r.entries.some((e) => e.message === 'tape export: missing or invalid tape id')).toBe(
      true,
    )
  })

  it('refuses an unsupported method, logged', async () => {
    const r = await call('/addon/pipeline-analytics/tape-export?tapeId=promo-0001', 'POST')
    expect(r.status).toBe(405)
    expect(r.entries.some((e) => e.message === 'tape export: method not allowed')).toBe(true)
  })

  it('answers an unknown tape with a logged 404', async () => {
    const r = await call('/addon/pipeline-analytics/tape-export?tapeId=nope-0000')
    expect(r.status).toBe(404)
    expect(r.entries.some((e) => e.message === 'tape export: unknown tape')).toBe(true)
  })

  it('streams the bundle of a known tape', async () => {
    const r = await call('/addon/pipeline-analytics/tape-export?tapeId=promo-0001')
    expect(r.status).toBe(200)
    expect(r.disposition).toContain('102-pairs-and-cars.tape-bundle.json.gz')
    expect(parseBundle(r.body)).toEqual(PARTS)
  })

  // M1: a row this node cannot serve is NEVER reported as "unknown".
  it('answers a known-but-unavailable tape with a tagged 503, never 404', async () => {
    const r = await call('/addon/pipeline-analytics/tape-export?tapeId=unavail-0000')
    expect(r.status).toBe(503)
    const entry = r.entries.find((e) => e.message === 'tape export: unavailable on this node')
    expect(entry?.extras?.tags).toEqual({ deviceId: 900 })
    expect(entry?.extras?.meta).toMatchObject({ reason: 'tapes-not-started' })
    expect(r.entries.some((e) => e.message === 'tape export: unknown tape')).toBe(false)
  })

  // M2: a read failure (a release/delete racing the download) is a tagged
  // 500 — a different thing from a whole-node `unavailable`.
  it('answers a read failure racing a release with a tagged 500', async () => {
    const r = await call('/addon/pipeline-analytics/tape-export?tapeId=racing-0000')
    expect(r.status).toBe(500)
    const entry = r.entries.find((e) => e.message === 'tape export: bundle could not be built')
    expect(entry?.extras?.tags).toEqual({ deviceId: 102 })
    expect(entry?.extras?.meta).toMatchObject({ error: 'ENOENT: no such file' })
  })

  // M3: HEAD answers from the index row alone — it must never build the bundle.
  it('answers HEAD from the index row alone, without building the bundle', async () => {
    const r = await call('/addon/pipeline-analytics/tape-export?tapeId=promo-0001', 'HEAD')
    expect(r.status).toBe(200)
    expect(r.disposition).toContain('102-pairs-and-cars.tape-bundle.json.gz')
    expect(r.body.length).toBe(0)
    expect(r.peekCalls).toEqual(['promo-0001'])
    expect(r.loadCalls).toEqual([])
  })

  it('answers a HEAD for an unavailable tape with a tagged 503, without building the bundle', async () => {
    const r = await call('/addon/pipeline-analytics/tape-export?tapeId=unavail-0000', 'HEAD')
    expect(r.status).toBe(503)
    expect(r.loadCalls).toEqual([])
    expect(r.entries.some((e) => e.message === 'tape export: unavailable on this node')).toBe(true)
  })
})
