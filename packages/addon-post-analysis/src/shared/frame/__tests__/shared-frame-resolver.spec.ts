import { describe, it, expect, vi } from 'vitest'
import type { FrameHandle } from '@camstack/types'
import { createSharedFrameResolver, frameHandleKey } from '../shared-frame-resolver.js'

function handle(overrides: Partial<FrameHandle> = {}): FrameHandle {
  return {
    shmId: 'seg-a',
    slot: 0,
    seq: 2,
    width: 640,
    height: 480,
    format: 'rgb',
    pts: 1,
    byteLength: 100,
    nodeId: 'n1',
    slotCount: 8,
    ...overrides,
  }
}

describe('createSharedFrameResolver', () => {
  it('resolves once for repeated calls with the same frame identity', async () => {
    const resolve = vi.fn(async (h: FrameHandle) => `decoded-${h.seq}`)
    const shared = createSharedFrameResolver(resolve)
    const h = handle()
    const [a, b, c] = await Promise.all([shared(h), shared(h), shared(handle())])
    expect(a).toBe('decoded-2')
    expect(b).toBe('decoded-2')
    expect(c).toBe('decoded-2')
    expect(resolve).toHaveBeenCalledTimes(1) // one decode shared across all three
  })

  it('re-resolves when the slot was recycled (same shmId+slot, new seq)', async () => {
    const resolve = vi.fn(async (h: FrameHandle) => `decoded-${h.seq}`)
    const shared = createSharedFrameResolver(resolve)
    expect(await shared(handle({ seq: 2 }))).toBe('decoded-2')
    // Same segment + slot but a NEW committed sequence → a different frame.
    expect(await shared(handle({ seq: 4 }))).toBe('decoded-4')
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('re-resolves for a different node / segment / slot', async () => {
    const resolve = vi.fn(async (h: FrameHandle) => `${h.nodeId}:${h.shmId}:${h.slot}`)
    const shared = createSharedFrameResolver(resolve)
    await shared(handle())
    await shared(handle({ nodeId: 'n2' }))
    await shared(handle({ shmId: 'seg-b' }))
    await shared(handle({ slot: 3 }))
    expect(resolve).toHaveBeenCalledTimes(4)
  })

  it('frameHandleKey is the full nodeId:shmId:slot:seq identity', () => {
    expect(frameHandleKey(handle({ nodeId: 'n1', shmId: 's', slot: 2, seq: 6 }))).toBe('n1:s:2:6')
  })
})
