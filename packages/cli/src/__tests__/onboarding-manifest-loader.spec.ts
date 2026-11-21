import { describe, expect, it } from 'vitest'
import type { FetchFn } from '../mcp/context.js'
import {
  LIVE_FAILURE_TTL_MS,
  LIVE_TTL_MS,
  bundledManifest,
  createManifestProvider,
} from '../onboarding/manifest.js'

function serving(body: unknown, status = 200): { fetch: FetchFn; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    fetch: async () => {
      calls += 1
      return new Response(JSON.stringify(body), { status })
    },
  }
}

const bundled = bundledManifest()
const newer = { ...bundled, revision: bundled.revision + 1, contentHash: 'aaaaaaaaaaaaaaaa' }

describe('onboarding manifest provider', () => {
  it('ships a snapshot that parses, with unique step ids in a known phase order', () => {
    const ids = bundled.steps.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[0]).toBe('feasibility')
  })

  it('prefers a live document with a higher revision and says so', async () => {
    const site = serving(newer)
    const got = await createManifestProvider({ fetch: site.fetch, live: true })()
    expect(got.source).toBe('live')
    expect(got.manifest.revision).toBe(bundled.revision + 1)
    expect(got.note).toBeNull()
  })

  it('keeps the bundled copy when the live one is the same or older', async () => {
    const same = await createManifestProvider({ fetch: serving(bundled).fetch, live: true })()
    expect(same).toMatchObject({ source: 'bundled', note: null })
    const older = await createManifestProvider({
      fetch: serving({ ...bundled, revision: 0.5 }).fetch,
      live: true,
    })()
    expect(older.source).toBe('bundled')
    expect(older.note).toMatch(/cannot read/)
  })

  it('falls back with the reason when the site is down, malformed or slow', async () => {
    const down = await createManifestProvider({ fetch: serving({}, 503).fetch, live: true })()
    expect(down).toMatchObject({ source: 'bundled', note: 'the docs site answered 503' })
    const bad = await createManifestProvider({
      fetch: serving({ ...newer, steps: [] }).fetch,
      live: true,
    })()
    expect(bad.source).toBe('bundled')
    expect(bad.note).toMatch(/cannot read/)
    const slow: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const late = await createManifestProvider({ fetch: slow, live: true, timeoutMs: 5 })()
    expect(late).toMatchObject({ source: 'bundled', note: 'the docs site did not answer in time' })
  })

  it('never calls the network with --no-docs-fetch', async () => {
    const site = serving(newer)
    const got = await createManifestProvider({ fetch: site.fetch, live: false })()
    expect(site.calls()).toBe(0)
    expect(got.source).toBe('bundled')
    expect(got.note).toMatch(/--no-docs-fetch/)
  })

  it('reads the site once per hour, and retries a failure after five minutes', async () => {
    let t = 0
    const ok = serving(newer)
    const provider = createManifestProvider({ fetch: ok.fetch, live: true, now: () => t })
    await provider()
    t = LIVE_TTL_MS - 1
    await provider()
    expect(ok.calls()).toBe(1)
    t = LIVE_TTL_MS
    await provider()
    expect(ok.calls()).toBe(2)

    t = 0
    const down = serving({}, 500)
    const failing = createManifestProvider({ fetch: down.fetch, live: true, now: () => t })
    await failing()
    t = LIVE_FAILURE_TTL_MS - 1
    await failing()
    expect(down.calls()).toBe(1)
    t = LIVE_FAILURE_TTL_MS
    await failing()
    expect(down.calls()).toBe(2)
  })
})
