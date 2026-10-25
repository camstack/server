/**
 * D696 — this provider never writes the camera's `motion` slice: the
 * orchestrator is its only writer, with the EFFECTIVE motion. No boot seed, no
 * firmware Start, no Stop. `motion.isDetected` answers from the HUB's slice;
 * an unreadable hub, or a slice nobody published yet, fails the call, never
 * `false` (D49, D393).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AmcrestCamera } from '../amcrest-camera.js'

interface MotionProviderShape {
  isDetected(input: { deviceId: number }): Promise<boolean>
  getStatus(input: { deviceId: number }): Promise<unknown>
}

function isMotionProvider(value: unknown): value is MotionProviderShape {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isDetected' in value &&
    typeof value.isDetected === 'function' &&
    'getStatus' in value &&
    typeof value.getStatus === 'function'
  )
}

const ID = 618

function makeSubject(hub: () => Promise<Readonly<Record<string, unknown>> | null>) {
  const registered: { readonly name: string; readonly provider: unknown }[] = []
  const setCapSlice = vi.fn()
  const subject = {
    id: ID,
    motionActive: false,
    motionKeepaliveTimer: null,
    setCapSlice,
    getCapSlice: vi.fn(() => null),
    emitMotion: vi.fn(),
    clearMotionKeepalive: AmcrestCamera.prototype['clearMotionKeepalive'],
    ctx: {
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      eventBus: { emit: vi.fn() },
      registerNativeCap: (cap: { readonly name: string }, provider: unknown) => {
        registered.push({ name: cap.name, provider })
      },
      api: { deviceState: { getCapSlice: { query: vi.fn(hub) } } },
    },
  }
  const motionProvider = (): MotionProviderShape => {
    const found = registered.find((r) => r.name === 'motion')?.provider
    if (!isMotionProvider(found)) throw new Error('no motion provider registered')
    return found
  }
  return { subject, setCapSlice, motionProvider }
}

describe('Amcrest writes no camera motion slice (D696)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('registering the motion cap seeds no slice', () => {
    const h = makeSubject(async () => null)
    AmcrestCamera.prototype['registerMotionCap'].call(h.subject)
    expect(h.setCapSlice).not.toHaveBeenCalled()
  })

  it('a firmware Start and Stop write no slice', () => {
    const h = makeSubject(async () => null)
    AmcrestCamera.prototype['onMotionStart'].call(h.subject, 10)
    AmcrestCamera.prototype['onMotionStop'].call(h.subject, 20)
    expect(h.setCapSlice).not.toHaveBeenCalled()
    expect(h.subject.emitMotion.mock.calls).toEqual([
      [true, 10],
      [false, 20],
    ])
  })

  it('isDetected answers from the hub slice, and an unknown one fails', async () => {
    const on = makeSubject(async () => ({
      detected: true,
      lastDetectedAt: 1,
      autoClearAfterMs: 15_000,
    }))
    AmcrestCamera.prototype['registerMotionCap'].call(on.subject)
    await expect(on.motionProvider().isDetected({ deviceId: ID })).resolves.toBe(true)
    const cold = makeSubject(async () => null)
    AmcrestCamera.prototype['registerMotionCap'].call(cold.subject)
    await expect(cold.motionProvider().isDetected({ deviceId: ID })).rejects.toThrow(
      /not published/,
    )
    const down = makeSubject(async () => {
      throw new Error('hub down')
    })
    AmcrestCamera.prototype['registerMotionCap'].call(down.subject)
    await expect(down.motionProvider().isDetected({ deviceId: ID })).rejects.toThrow(/unreadable/)
  })

  /**
   * 2026-10-06: the provider served only `isDetected`, so `registerNativeCap`
   * installed the framework's default `getStatus` over this process's LOCAL
   * runtime state — empty under D696 — and `motion.getStatus` answered `null`
   * for every camera while the hub held its slice.
   */
  it('getStatus answers the hub slice; an unpublished one is null, an unreadable hub fails', async () => {
    const slice = { detected: false, lastDetectedAt: 1_791_305_772_852, autoClearAfterMs: null }
    const on = makeSubject(async () => slice)
    AmcrestCamera.prototype['registerMotionCap'].call(on.subject)
    await expect(on.motionProvider().getStatus({ deviceId: ID })).resolves.toEqual(slice)
    const cold = makeSubject(async () => null)
    AmcrestCamera.prototype['registerMotionCap'].call(cold.subject)
    await expect(cold.motionProvider().getStatus({ deviceId: ID })).resolves.toBeNull()
    const down = makeSubject(async () => {
      throw new Error('hub down')
    })
    AmcrestCamera.prototype['registerMotionCap'].call(down.subject)
    await expect(down.motionProvider().getStatus({ deviceId: ID })).rejects.toThrow(/unreadable/)
  })
})
