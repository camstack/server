import { describe, expect, it, vi } from 'vitest'
import { createFlipperIrdbClient, FlipperIrdbError, filterEntries } from '../flipper-irdb-client'

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
}

const LISTING = [
  { name: 'Samsung', path: 'TVs/Samsung', type: 'dir' },
  { name: 'README.md', path: 'TVs/README.md', type: 'file' },
  { name: 'LG', path: 'TVs/LG', type: 'dir' },
]

describe('createFlipperIrdbClient', () => {
  it('lists a directory, directories first and only .ir files and folders', async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL) => response(200, LISTING))
    const client = createFlipperIrdbClient({ fetchFn })
    const entries = await client.list('TVs')
    expect(entries.map((e) => e.name)).toEqual(['LG', 'Samsung'])
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      'https://api.github.com/repos/Lucaslhm/Flipper-IRDB/contents/TVs',
    )
  })

  it('serves a repeated listing from the cache until it expires', async () => {
    let now = 0
    const fetchFn = vi.fn(async (_url: RequestInfo | URL) => response(200, LISTING))
    const client = createFlipperIrdbClient({ fetchFn, now: () => now, ttlMs: 1000 })
    await client.list('TVs')
    await client.list('TVs')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    now = 1001
    await client.list('TVs')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('maps an exhausted rate limit to a typed error carrying the reset time', async () => {
    const fetchFn = vi.fn(async () =>
      response(
        403,
        { message: 'API rate limit exceeded' },
        {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1800000000',
        },
      ),
    )
    const client = createFlipperIrdbClient({ fetchFn })
    const error = await client.list('TVs').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FlipperIrdbError)
    expect(error).toMatchObject({ code: 'rate-limited', resetAtMs: 1800000000 * 1000 })
  })

  it('does not cache a failure', async () => {
    const fetchFn = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(response(403, {}, { 'x-ratelimit-remaining': '0' }))
      .mockResolvedValueOnce(response(200, LISTING))
    const client = createFlipperIrdbClient({ fetchFn })
    await expect(client.list('TVs')).rejects.toBeInstanceOf(FlipperIrdbError)
    await expect(client.list('TVs')).resolves.toHaveLength(2)
  })

  it('a 404 is not-found and a dropped connection is network', async () => {
    const missing = createFlipperIrdbClient({ fetchFn: async () => response(404, {}) })
    await expect(missing.list('Nope')).rejects.toMatchObject({ code: 'not-found' })
    const down = createFlipperIrdbClient({
      fetchFn: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    await expect(down.list('TVs')).rejects.toMatchObject({ code: 'network' })
  })

  it('refuses an answer that is not a listing', async () => {
    const client = createFlipperIrdbClient({ fetchFn: async () => response(200, { oops: 1 }) })
    await expect(client.list('TVs')).rejects.toMatchObject({ code: 'bad-response' })
  })

  it('reads a file from the raw host, encoding each path segment', async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL) =>
      response(200, 'Filetype: IR signals file\n'),
    )
    const client = createFlipperIrdbClient({ fetchFn })
    const text = await client.readFile('TVs/Samsung/Samsung BN59.ir')
    expect(text).toContain('Filetype')
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      'https://raw.githubusercontent.com/Lucaslhm/Flipper-IRDB/main/TVs/Samsung/Samsung%20BN59.ir',
    )
  })
})

describe('filterEntries', () => {
  const entries = [
    { name: 'Samsung', path: 'TVs/Samsung', kind: 'dir' as const },
    { name: 'LG', path: 'TVs/LG', kind: 'dir' as const },
  ]
  it('matches case-insensitively on the name', () => {
    expect(filterEntries(entries, 'sam').map((e) => e.name)).toEqual(['Samsung'])
    expect(filterEntries(entries, '  ')).toHaveLength(2)
  })
})
