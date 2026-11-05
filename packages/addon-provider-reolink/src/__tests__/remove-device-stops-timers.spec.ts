/**
 * A removed camera must stop every timer it armed, at once — not after the
 * awaited broker retraction — and must not re-arm any afterwards. A deleted
 * battery camera kept refreshing on its hourly tick (`setCapSlice: unknown
 * device id`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReolinkCamera } from '../reolink-camera.js'

function makeCamera() {
  const camera = Object.create(ReolinkCamera.prototype)
  const refreshTick = vi.fn(async () => undefined)
  Object.defineProperties(camera, {
    id: { value: 5483 },
    stableId: { value: 'cam-5483' },
    isBattery: { value: true, writable: true },
    publishedStreamIds: { value: new Set(['main']) },
    reachability: { value: { dispose: vi.fn() } },
    ctx: {
      value: {
        logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
        // Retraction never settles: everything must already be stopped.
        api: { streamBroker: { retractCameraStream: { mutate: () => new Promise(() => {}) } } },
      },
    },
    detachFromHubSession: { value: vi.fn() },
    isHubChild: { value: () => false },
    config: { value: { get: () => undefined } },
    state: { value: { battery: {} } },
    runBatteryUpdate: { value: refreshTick },
    disconnectAll: { value: vi.fn(async () => undefined) },
  })
  return { camera, refreshTick }
}

const arm = (camera: object, method: string): void => {
  const fn: unknown = Reflect.get(camera, method)
  if (typeof fn !== 'function') throw new Error(`no ${method}`)
  fn.call(camera)
}

afterEach(() => vi.useRealTimers())

describe('ReolinkCamera.removeDevice', () => {
  it('stops the battery refresh tick immediately, before the broker retraction settles', async () => {
    vi.useFakeTimers()
    const { camera, refreshTick } = makeCamera()
    arm(camera, 'startBatteryUpdatePolling')
    void camera.removeDevice()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(refreshTick).not.toHaveBeenCalled()
  })

  it('does not re-arm the battery refresh after removal', async () => {
    vi.useFakeTimers()
    const { camera, refreshTick } = makeCamera()
    void camera.removeDevice()
    arm(camera, 'startBatteryUpdatePolling')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(refreshTick).not.toHaveBeenCalled()
  })
})
