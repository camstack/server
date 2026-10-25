import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IdlePoolReaper } from '../idle-pool-reaper.js'

describe('IdlePoolReaper — per-device pool idle eviction (C3)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('disposes a key after ttl of no use', async () => {
    const disposed: string[] = []
    const reaper = new IdlePoolReaper({ ttlMs: 1000, dispose: async (k) => void disposed.push(k) })
    reaper.touch('openvino:gpu')
    await vi.advanceTimersByTimeAsync(1000)
    expect(disposed).toEqual(['openvino:gpu'])
  })

  it('a touch inside the window re-arms the timer (active pool never idles out)', async () => {
    const disposed: string[] = []
    const reaper = new IdlePoolReaper({ ttlMs: 1000, dispose: async (k) => void disposed.push(k) })
    reaper.touch('edgetpu:usb')
    await vi.advanceTimersByTimeAsync(600)
    reaper.touch('edgetpu:usb') // reuse before TTL → reset
    await vi.advanceTimersByTimeAsync(600) // 1200 total, but only 600 since last use
    expect(disposed).toEqual([])
    await vi.advanceTimersByTimeAsync(400) // now 1000 since last use
    expect(disposed).toEqual(['edgetpu:usb'])
  })

  it('cancel() stops a pending eviction; disposeAll() clears all timers', async () => {
    const disposed: string[] = []
    const reaper = new IdlePoolReaper({ ttlMs: 1000, dispose: async (k) => void disposed.push(k) })
    reaper.touch('a')
    reaper.touch('b')
    reaper.cancel('a')
    reaper.disposeAll()
    await vi.advanceTimersByTimeAsync(5000)
    expect(disposed).toEqual([])
  })

  it('tracks distinct keys independently', async () => {
    const disposed: string[] = []
    const reaper = new IdlePoolReaper({ ttlMs: 1000, dispose: async (k) => void disposed.push(k) })
    reaper.touch('openvino:npu')
    await vi.advanceTimersByTimeAsync(500)
    reaper.touch('openvino:gpu')
    await vi.advanceTimersByTimeAsync(500) // npu idles at 1000, gpu at 500
    expect(disposed).toEqual(['openvino:npu'])
    await vi.advanceTimersByTimeAsync(500)
    expect(disposed).toEqual(['openvino:npu', 'openvino:gpu'])
  })
})
