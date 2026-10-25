import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { fetchBundleFromHub } from '../fetch-bundle-from-hub'

const body = Buffer.from('AGENTTGZ')
const sha = createHash('sha256').update(body).digest('hex')
const okFetch = (async (_url: string, init?: RequestInit) => {
  const auth = (init?.headers as Record<string, string>)?.['Authorization']
  if (auth !== 'Bearer good') return new Response('no', { status: 401 })
  return new Response(body, { status: 200 })
}) as unknown as typeof fetch

describe('fetchBundleFromHub', () => {
  it('downloads and returns the buffer when sha+bytes match', async () => {
    const out = await fetchBundleFromHub({
      url: 'https://h/b',
      token: 'good',
      sha256: sha,
      bytes: body.length,
      fetchImpl: okFetch,
    })
    expect(out.equals(body)).toBe(true)
  })
  it('throws on http error', async () => {
    await expect(
      fetchBundleFromHub({
        url: 'https://h/b',
        token: 'bad',
        sha256: sha,
        bytes: body.length,
        fetchImpl: okFetch,
      }),
    ).rejects.toThrow(/401/)
  })
  it('throws on sha256 mismatch', async () => {
    await expect(
      fetchBundleFromHub({
        url: 'https://h/b',
        token: 'good',
        sha256: 'deadbeef',
        bytes: body.length,
        fetchImpl: okFetch,
      }),
    ).rejects.toThrow(/sha256/i)
  })
  it('throws on byte-count mismatch', async () => {
    await expect(
      fetchBundleFromHub({
        url: 'https://h/b',
        token: 'good',
        sha256: sha,
        bytes: 999,
        fetchImpl: okFetch,
      }),
    ).rejects.toThrow(/bytes/i)
  })
})
