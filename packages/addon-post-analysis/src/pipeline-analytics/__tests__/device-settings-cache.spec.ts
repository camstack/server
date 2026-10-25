/**
 * S6 (refactor spec 2026-07-22-post-analysis-maintainability-refactor):
 * `DeviceSettingsCacheHub` — the generic per-device settings TTL cache that
 * replaced the nine hand-rolled `<kind>CacheByDevice` maps in `index.ts`.
 *
 * Behavior-parity notes encoded as tests (A2 — the hub must behave EXACTLY
 * like the legacy per-map code):
 * - no single-flight: concurrent cold reads each run the loader (the legacy
 *   resolvers had no request coalescing either — parity, not an oversight);
 * - `expiresAt` is stamped from lookup START (legacy `now + TTL` capture);
 * - `peek` returns stale entries (the legacy sync stationary read never
 *   checked `expiresAt`).
 */
import { describe, it, expect } from 'vitest'
import { DeviceSettingsCacheHub } from '../device-settings-cache.js'

const TTL = 5_000

interface ManualClock {
  now: () => number
  advance: (ms: number) => void
  set: (ms: number) => void
}

function manualClock(start = 1_000_000): ManualClock {
  let at = start
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms
    },
    set: (ms: number) => {
      at = ms
    },
  }
}

interface CountingLoader<T> {
  load: (deviceId: number) => Promise<T>
  calls: () => number
  lastDeviceId: () => number | null
}

function countingLoader<T>(value: (deviceId: number) => T): CountingLoader<T> {
  let calls = 0
  let lastDeviceId: number | null = null
  return {
    load: (deviceId: number) => {
      calls += 1
      lastDeviceId = deviceId
      return Promise.resolve(value(deviceId))
    },
    calls: () => calls,
    lastDeviceId: () => lastDeviceId,
  }
}

describe('DeviceTtlCache — TTL expiry (injectable clock)', () => {
  it('serves the cached value within the TTL without re-running the loader', async () => {
    const clock = manualClock()
    const hub = new DeviceSettingsCacheHub(clock.now)
    const cache = hub.registerDeviceCache<string>('kind-a', TTL)
    const loader = countingLoader((id) => `settings-${id}`)

    expect(await cache.get(7, loader.load)).toBe('settings-7')
    expect(loader.calls()).toBe(1)
    expect(loader.lastDeviceId()).toBe(7)

    clock.advance(TTL - 1)
    expect(await cache.get(7, loader.load)).toBe('settings-7')
    expect(loader.calls()).toBe(1)
  })

  it('re-runs the loader once the TTL has elapsed', async () => {
    const clock = manualClock()
    const hub = new DeviceSettingsCacheHub(clock.now)
    const cache = hub.registerDeviceCache<number>('kind-a', TTL)
    const loader = countingLoader(() => 1)

    await cache.get(7, loader.load)
    clock.advance(TTL)
    await cache.get(7, loader.load)
    expect(loader.calls()).toBe(2)
  })

  it('stamps expiresAt from lookup START, not loader completion (legacy `now + TTL` capture)', async () => {
    const clock = manualClock()
    const hub = new DeviceSettingsCacheHub(clock.now)
    const cache = hub.registerDeviceCache<string>('kind-a', TTL)
    // A slow loader that takes longer than the TTL: the entry it produces is
    // already expired by wall-clock — exactly like the legacy resolvers,
    // which captured `now` BEFORE the awaited store read.
    let calls = 0
    const slowLoader = (id: number): Promise<string> => {
      calls += 1
      clock.advance(TTL + 1)
      return Promise.resolve(`slow-${id}`)
    }

    expect(await cache.get(3, slowLoader)).toBe('slow-3')
    // Next read: entry expired the moment it landed → loader runs again.
    expect(await cache.get(3, slowLoader)).toBe('slow-3')
    expect(calls).toBe(2)
  })

  it('caches per device independently', async () => {
    const clock = manualClock()
    const hub = new DeviceSettingsCacheHub(clock.now)
    const cache = hub.registerDeviceCache<string>('kind-a', TTL)
    const loader = countingLoader((id) => `v-${id}`)

    expect(await cache.get(1, loader.load)).toBe('v-1')
    expect(await cache.get(2, loader.load)).toBe('v-2')
    expect(loader.calls()).toBe(2)
    expect(await cache.get(1, loader.load)).toBe('v-1')
    expect(loader.calls()).toBe(2)
  })
})

describe('DeviceTtlCache — peek (legacy sync-read parity)', () => {
  it('returns undefined when nothing is cached and never runs a loader', () => {
    const hub = new DeviceSettingsCacheHub(manualClock().now)
    const cache = hub.registerDeviceCache<string>('kind-a', TTL)
    expect(cache.peek(9)).toBeUndefined()
  })

  it('returns a present-but-EXPIRED entry (the legacy sync stationary read ignored the TTL)', async () => {
    const clock = manualClock()
    const hub = new DeviceSettingsCacheHub(clock.now)
    const cache = hub.registerDeviceCache<string>('kind-a', TTL)
    await cache.get(9, () => Promise.resolve('stale-ok'))
    clock.advance(TTL * 10)
    expect(cache.peek(9)).toBe('stale-ok')
  })
})

describe('per-key isolation', () => {
  it('same deviceId in two registered kinds: values and deletes stay independent', async () => {
    const clock = manualClock()
    const hub = new DeviceSettingsCacheHub(clock.now)
    const a = hub.registerDeviceCache<string>('kind-a', TTL)
    const b = hub.registerDeviceCache<string>('kind-b', TTL)
    await a.get(5, () => Promise.resolve('A'))
    await b.get(5, () => Promise.resolve('B'))

    a.delete(5)
    expect(a.peek(5)).toBeUndefined()
    expect(b.peek(5)).toBe('B')
  })

  it('rejects a duplicate key registration (device and global)', () => {
    const hub = new DeviceSettingsCacheHub(manualClock().now)
    hub.registerDeviceCache<string>('kind-a', TTL)
    hub.registerGlobalCache<string>('glob-a', TTL)
    expect(() => hub.registerDeviceCache<string>('kind-a', TTL)).toThrow(/duplicate/)
    expect(() => hub.registerGlobalCache<string>('glob-a', TTL)).toThrow(/duplicate/)
  })
})

describe('clearDevice — the one-call replacement for the delete litanies', () => {
  it('drops ONE device from EVERY registered per-device cache, leaving other devices intact', async () => {
    const clock = manualClock()
    const hub = new DeviceSettingsCacheHub(clock.now)
    const a = hub.registerDeviceCache<string>('kind-a', TTL)
    const b = hub.registerDeviceCache<string>('kind-b', TTL)
    await a.get(1, () => Promise.resolve('a1'))
    await a.get(2, () => Promise.resolve('a2'))
    await b.get(1, () => Promise.resolve('b1'))

    hub.clearDevice(1)

    expect(a.peek(1)).toBeUndefined()
    expect(b.peek(1)).toBeUndefined()
    expect(a.peek(2)).toBe('a2')
  })

  it('does NOT clear global caches (legacy parity: the per-device litanies never touched them)', async () => {
    const clock = manualClock()
    const hub = new DeviceSettingsCacheHub(clock.now)
    const glob = hub.registerGlobalCache<boolean>('glob-a', TTL)
    let calls = 0
    const loader = (): Promise<boolean> => {
      calls += 1
      return Promise.resolve(true)
    }
    await glob.get(loader)
    hub.clearDevice(1)
    await glob.get(loader)
    expect(calls).toBe(1)
  })
})

describe('clearAll — the one-call replacement for the dispose litany', () => {
  it('clears every per-device AND global cache', async () => {
    const clock = manualClock()
    const hub = new DeviceSettingsCacheHub(clock.now)
    const a = hub.registerDeviceCache<string>('kind-a', TTL)
    const glob = hub.registerGlobalCache<string>('glob-a', TTL)
    await a.get(1, () => Promise.resolve('a1'))
    let globCalls = 0
    const globLoader = (): Promise<string> => {
      globCalls += 1
      return Promise.resolve('g')
    }
    await glob.get(globLoader)

    hub.clearAll()

    expect(a.peek(1)).toBeUndefined()
    await glob.get(globLoader)
    expect(globCalls).toBe(2)
  })
})

describe('GlobalTtlCache — TTL semantics mirror the device cache', () => {
  it('caches within the TTL and reloads after it', async () => {
    const clock = manualClock()
    const hub = new DeviceSettingsCacheHub(clock.now)
    const glob = hub.registerGlobalCache<number>('glob-a', TTL)
    let calls = 0
    const loader = (): Promise<number> => {
      calls += 1
      return Promise.resolve(calls)
    }

    expect(await glob.get(loader)).toBe(1)
    clock.advance(TTL - 1)
    expect(await glob.get(loader)).toBe(1)
    clock.advance(1)
    expect(await glob.get(loader)).toBe(2)
  })
})

describe('concurrency — NO single-flight (documented legacy parity)', () => {
  // The nine legacy resolvers had no request coalescing: two concurrent cold
  // reads each hit the device store and the last write won. The hub keeps
  // that behavior EXACTLY (A2 — no behavior change in this slice); adding
  // single-flight would be a (welcome) behavior change for a later slice.
  it('two concurrent cold gets each run the loader (last write wins)', async () => {
    const hub = new DeviceSettingsCacheHub(manualClock().now)
    const cache = hub.registerDeviceCache<number>('kind-a', TTL)
    let calls = 0
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const loader = async (): Promise<number> => {
      calls += 1
      const call = calls
      await gate
      return call
    }

    const p1 = cache.get(4, loader)
    const p2 = cache.get(4, loader)
    if (release !== null) {
      const releaseFn: () => void = release
      releaseFn()
    }
    const [v1, v2] = await Promise.all([p1, p2])

    expect(calls).toBe(2)
    expect(v1).toBe(1)
    expect(v2).toBe(2)
    // Last write wins in the cache — subsequent reads see the second value.
    expect(cache.peek(4)).toBe(2)
  })
})
