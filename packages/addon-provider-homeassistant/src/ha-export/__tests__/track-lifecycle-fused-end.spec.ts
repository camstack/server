/**
 * D683 Task 18 fix round 1 (review L2): the HA export hands the lifecycle's
 * `fusedIntoTrackId` to the projector, so a fused piece's `end` pushes no
 * state. Disarm: stop passing `fusedIntoTrackId` in `onTrackLifecycle` —
 * "a fused piece's end pushes nothing" fails.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { HaExportAddon } from '../ha-export.addon.js'
import type { StateValue } from '../state-projector.js'

const silent: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

function harness(): {
  readonly onLifecycle: (data: unknown) => Promise<void>
  readonly pushed: (readonly StateValue[])[]
} {
  const addon = new HaExportAddon()
  const pushed: (readonly StateValue[])[] = []
  Reflect.set(addon, '_ctx', { logger: silent })
  Reflect.set(addon, 'keyByDeviceId', new Map([[101, 'camstack-reolink-101']]))
  Reflect.set(addon, 'push', (_deviceId: number, values: readonly StateValue[]) => {
    pushed.push(values)
  })
  const handler: unknown = Reflect.get(addon, 'onTrackLifecycle')
  if (typeof handler !== 'function') throw new Error('no onTrackLifecycle')
  return {
    onLifecycle: async (data) => {
      await handler.call(addon, data)
    },
    pushed,
  }
}

const END = {
  deviceId: 101,
  trackId: 'B',
  phase: 'end',
  classes: ['person'],
  bestClassName: 'person',
  lastSeen: 1_770_000_000_000,
}

describe('HA export — a fused piece ending (D683)', () => {
  it("a fused piece's end pushes nothing", async () => {
    const h = harness()
    await h.onLifecycle({ ...END, fusedIntoTrackId: 'A' })
    expect(h.pushed).toEqual([])
  })

  it('a real end is pushed', async () => {
    const h = harness()
    await h.onLifecycle(END)
    expect(h.pushed).toHaveLength(1)
    expect(h.pushed[0]).toContainEqual({
      topic: 'camstack/camstack-reolink-101/person_detected',
      value: 'false',
    })
  })
})
