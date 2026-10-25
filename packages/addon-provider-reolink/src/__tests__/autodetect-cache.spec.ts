import { describe, it, expect, vi } from 'vitest'
import { AutodetectCache } from '../autodetect-cache'

interface FakeApi {
  close: ReturnType<typeof vi.fn>
}

function makeFakeResult(extra: Partial<{ type: string; uid: string }> = {}): {
  result: {
    type: 'camera' | 'udp-camera' | 'battery-cam' | 'nvr' | 'multifocal'
    transport: 'tcp' | 'udp'
    uid: string
    api: FakeApi
  }
  api: FakeApi
} {
  const api: FakeApi = { close: vi.fn().mockResolvedValue(undefined) }
  return {
    result: {
      type: (extra.type ?? 'camera') as 'camera',
      transport: 'tcp',
      uid: extra.uid ?? '',
      api,
    },
    api,
  }
}

const baseInputs = {
  host: '192.168.10.10',
  username: 'admin',
  password: 'super-secret',
  transport: 'auto' as const,
}

describe('AutodetectCache.keyFor', () => {
  it('hashes the password (no plaintext in the key)', () => {
    const key = AutodetectCache.keyFor(baseInputs)
    expect(key).not.toContain('super-secret')
    expect(key).toContain('192.168.10.10')
    expect(key).toContain('admin')
    expect(key).toContain('auto')
  })

  it('changes when the transport changes', () => {
    const a = AutodetectCache.keyFor({ ...baseInputs, transport: 'tcp' })
    const b = AutodetectCache.keyFor({ ...baseInputs, transport: 'udp' })
    expect(a).not.toBe(b)
  })

  it('changes when the uid changes', () => {
    const a = AutodetectCache.keyFor({ ...baseInputs, uid: 'aaa' })
    const b = AutodetectCache.keyFor({ ...baseInputs, uid: 'bbb' })
    expect(a).not.toBe(b)
  })

  it('lowercases the host so 192.168.10.10 == 192.168.10.10', () => {
    const a = AutodetectCache.keyFor({ ...baseInputs, host: '192.168.10.10' })
    const b = AutodetectCache.keyFor({ ...baseInputs, host: ' 192.168.10.10 ' })
    expect(a).toBe(b)
  })
})

describe('AutodetectCache get/set/take', () => {
  it('returns a freshly-set entry', () => {
    let now = 1_000
    const cache = new AutodetectCache({ now: () => now, ttlMs: 60_000 })
    const { result } = makeFakeResult()

    cache.set('k', result as never)
    const got = cache.get('k')
    expect(got).not.toBeNull()
    expect(got?.result).toBe(result)
    void now // silence unused
  })

  it('expires entries after the TTL', async () => {
    let now = 1_000
    const cache = new AutodetectCache({ now: () => now, ttlMs: 5_000 })
    const { result, api } = makeFakeResult()

    cache.set('k', result as never)
    now = 4_000
    expect(cache.get('k')).not.toBeNull()
    now = 6_001
    expect(cache.get('k')).toBeNull()
    // Expired entries dispose the api
    await new Promise((r) => setTimeout(r, 0))
    expect(api.close).toHaveBeenCalledTimes(1)
  })

  it('replaces a prior entry with the same key, disposing the old api', async () => {
    const cache = new AutodetectCache()
    const a = makeFakeResult()
    const b = makeFakeResult()
    cache.set('k', a.result as never)
    cache.set('k', b.result as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(a.api.close).toHaveBeenCalledTimes(1)
    expect(b.api.close).not.toHaveBeenCalled()
  })

  it('take() removes the entry without disposing the api', () => {
    const cache = new AutodetectCache()
    const { result, api } = makeFakeResult()
    cache.set('k', result as never)
    const taken = cache.take('k')
    expect(taken).toBe(result)
    expect(api.close).not.toHaveBeenCalled()
    expect(cache.size).toBe(0)
  })

  it('take() disposes when the entry has expired', async () => {
    let now = 1_000
    const cache = new AutodetectCache({ now: () => now, ttlMs: 1_000 })
    const { result, api } = makeFakeResult()
    cache.set('k', result as never)
    now = 5_000
    expect(cache.take('k')).toBeNull()
    await new Promise((r) => setTimeout(r, 0))
    expect(api.close).toHaveBeenCalledTimes(1)
  })

  it('dispose() drains the cache and closes every api', async () => {
    const cache = new AutodetectCache()
    const a = makeFakeResult()
    const b = makeFakeResult()
    cache.set('k1', a.result as never)
    cache.set('k2', b.result as never)
    await cache.dispose()
    expect(a.api.close).toHaveBeenCalledTimes(1)
    expect(b.api.close).toHaveBeenCalledTimes(1)
    expect(cache.size).toBe(0)
  })
})
