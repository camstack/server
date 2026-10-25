/**
 * D696 — this provider never writes the camera's `motion` slice: the
 * orchestrator is its only writer, with the EFFECTIVE motion. No boot seed, no
 * VMD rise, no inactivity clear. `motion.isDetected` answers from the HUB's
 * slice; an unreadable hub, or a slice nobody published yet, fails the call,
 * never `false` (D49, D393).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HikvisionCamera } from '../hikvision-camera.js'
import type { HikvisionAlarmEvent } from '../hikvision-isapi-client.js'

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

const ID = 101

function makeSubject(hub: () => Promise<Readonly<Record<string, unknown>> | null>) {
  const registered: { readonly name: string; readonly provider: unknown }[] = []
  const setCapSlice = vi.fn()
  const subject = {
    id: ID,
    eventSource: { type: 'device', id: ID, addonId: 'provider-hikvision', deviceId: ID },
    lastMotionAt: new Map<string, number>(),
    motionInactiveTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    motionIngress: { received: vi.fn(), ended: vi.fn() },
    state: {},
    setCapSlice,
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

const VMD: HikvisionAlarmEvent = {
  observedAt: 1_000,
  type: 'VMD',
  state: 'active',
  channelId: '1',
  aiClass: null,
  description: null,
  score: null,
  raw: '',
}

describe('Hikvision writes no camera motion slice (D696)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('registering the motion cap seeds no slice', () => {
    const h = makeSubject(async () => null)
    HikvisionCamera.prototype['registerMotionCap'].call(h.subject)
    expect(h.setCapSlice).not.toHaveBeenCalled()
  })

  it('a VMD rise and its inactivity clear write no slice', () => {
    const h = makeSubject(async () => null)
    HikvisionCamera.prototype['handleMotionEvent'].call(h.subject, VMD, 'native:main')
    vi.advanceTimersByTime(3_001)
    expect(h.setCapSlice).not.toHaveBeenCalled()
  })

  it('isDetected answers from the hub slice', async () => {
    const h = makeSubject(async () => ({
      detected: true,
      lastDetectedAt: 1,
      autoClearAfterMs: 15_000,
    }))
    HikvisionCamera.prototype['registerMotionCap'].call(h.subject)
    await expect(h.motionProvider().isDetected({ deviceId: ID })).resolves.toBe(true)
    expect(h.subject.ctx.api.deviceState.getCapSlice.query).toHaveBeenCalledWith({
      deviceId: ID,
      capName: 'motion',
    })
  })

  it('isDetected on an unreadable hub, or an unpublished slice, fails — never false', async () => {
    const down = makeSubject(async () => {
      throw new Error('hub down')
    })
    HikvisionCamera.prototype['registerMotionCap'].call(down.subject)
    await expect(down.motionProvider().isDetected({ deviceId: ID })).rejects.toThrow(/unreadable/)
    const cold = makeSubject(async () => null)
    HikvisionCamera.prototype['registerMotionCap'].call(cold.subject)
    await expect(cold.motionProvider().isDetected({ deviceId: ID })).rejects.toThrow(
      /not published/,
    )
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
    HikvisionCamera.prototype['registerMotionCap'].call(on.subject)
    await expect(on.motionProvider().getStatus({ deviceId: ID })).resolves.toEqual(slice)
    const cold = makeSubject(async () => null)
    HikvisionCamera.prototype['registerMotionCap'].call(cold.subject)
    await expect(cold.motionProvider().getStatus({ deviceId: ID })).resolves.toBeNull()
    const down = makeSubject(async () => {
      throw new Error('hub down')
    })
    HikvisionCamera.prototype['registerMotionCap'].call(down.subject)
    await expect(down.motionProvider().getStatus({ deviceId: ID })).rejects.toThrow(/unreadable/)
  })
})
