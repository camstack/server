import { describe, expect, it } from 'vitest'
import { harness } from './mirror-harness.js'

interface Told {
  readonly deviceId: number
  readonly capName: string
  readonly prior: Readonly<Record<string, unknown>> | undefined
  readonly slice: Readonly<Record<string, unknown>>
}

describe('DeviceStateMirror - transition tap (D1022)', () => {
  it('is told the previous and the new slice of a change', () => {
    const h = harness()
    const told: Told[] = []
    h.mirror.setTransitionTap((deviceId, capName, prior, slice) =>
      void told.push({ deviceId, capName, prior, slice }),
    )
    h.mirror.applySingleCapUpdate(7, 'switch', { on: false })
    h.mirror.applySingleCapUpdate(7, 'switch', { on: true })
    expect(told).toEqual([
      { deviceId: 7, capName: 'switch', prior: undefined, slice: { on: false } },
      { deviceId: 7, capName: 'switch', prior: { on: false }, slice: { on: true } },
    ])
  })

  it('is not told of an identical write', () => {
    const h = harness()
    let calls = 0
    h.mirror.applySingleCapUpdate(7, 'switch', { on: true })
    h.mirror.setTransitionTap(() => void (calls += 1))
    h.mirror.applySingleCapUpdate(7, 'switch', { on: true })
    expect(calls).toBe(0)
  })

  it('serves the stored slice back for the correlator to read', () => {
    const h = harness()
    h.mirror.applySingleCapUpdate(7, 'switch', { on: true })
    expect(h.mirror.currentSlice(7, 'switch')).toEqual({ on: true })
    expect(h.mirror.currentSlice(7, 'cover')).toBeUndefined()
    expect(h.mirror.currentSlice(8, 'switch')).toBeUndefined()
  })

  it('a mirror with no tap behaves as before', () => {
    const h = harness()
    expect(h.mirror.applySingleCapUpdate(7, 'switch', { on: true })).toBe(true)
  })
})
