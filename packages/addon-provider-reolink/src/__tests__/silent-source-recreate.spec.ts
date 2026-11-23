/**
 * A cached listening server that went down is recreated (the library tears a
 * server down after ~15 s with no client). A caller joining a materialize run
 * that has been in flight for a while logs it, instead of waiting in silence.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReolinkCamera } from '../reolink-camera.js'

afterEach(() => {
  vi.useRealTimers()
})

function makeCamera() {
  const close = vi.fn(async () => undefined)
  const cached = { server: { listening: true }, close }
  const camera = Object.create(ReolinkCamera.prototype)
  const warn = vi.fn()
  Object.defineProperties(camera, {
    id: { value: 3628 },
    active: { value: new Map([['native:main', { camStreamId: 'native:main', server: cached }]]) },
    ctx: { value: { logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } } },
    syncKeepAwake: { value: vi.fn() },
    // Recreation proceeds to a login; stop it there — the point is what happened before.
    ensureApi: { value: async () => Promise.reject(new Error('stop here')) },
    materializeInFlight: { value: new Map() },
    materializeStartedAt: { value: new Map() },
  })
  return { camera, close, cached, warn }
}

describe('ensureRfc4571Server cached entry', () => {
  it('recreates the server when the cached one is no longer listening', async () => {
    const { camera, close, cached } = makeCamera()
    cached.server.listening = false
    const result = await camera.ensureRfc4571Server('native:main', 0, 'main')
    expect(close).toHaveBeenCalledWith('recreate')
    expect(camera.active.has('native:main')).toBe(false)
    expect(result).toBeNull()
  })

  it('keeps a listening server', async () => {
    const { camera, close, cached } = makeCamera()
    const result = await camera.ensureRfc4571Server('native:main', 0, 'main')
    expect(close).not.toHaveBeenCalled()
    expect(result).toBe(cached)
  })
})

describe('materializeStreamSocket joining an old run', () => {
  it('warns with the deviceId when it joins a run in flight for over 20 s', async () => {
    vi.useFakeTimers()
    const { camera, warn } = makeCamera()
    camera.materializeInFlight.set('native:main', new Promise<void>(() => {}))
    camera.materializeStartedAt.set('native:main', Date.now())
    void camera.materializeStreamSocket('native:main')
    expect(warn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(21_000)
    void camera.materializeStreamSocket('native:main')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('joining a run still in flight'),
      expect.objectContaining({ tags: { deviceId: 3628, camStreamId: 'native:main' } }),
    )
  })
})
