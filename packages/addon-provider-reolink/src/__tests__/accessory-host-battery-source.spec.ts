import { describe, expect, it, vi } from 'vitest'
import { ReolinkCamera } from '../reolink-camera.js'

/**
 * #666 — the accessory sleep gate asks the parent `isBatteryCam()`. That used to
 * read the `feature-probe` slice, which a battery camera asleep at boot never
 * seeds (the parent's `onProbe` skips), so the answer was `false` and every
 * accessory probed straight through the gate. The host answers from `isBattery`,
 * which cap registration derives from the persisted `deviceCache`.
 *
 * The camera is the real class (prototype methods) on a stand-in `this`; the
 * runtime state has NO `feature-probe` slice, as on a camera asleep at boot.
 */
interface DeviceCache {
  readonly deviceType: string
  readonly hasBattery?: boolean
}

interface Host {
  isBatteryCam(): boolean
}

function makeCamera(cache: DeviceCache): Host {
  const camera: Host = Object.create(ReolinkCamera.prototype)
  const unseeded = (): undefined => undefined
  Object.defineProperties(camera, {
    id: { value: 640 },
    isBattery: { value: false, writable: true },
    config: { value: { get: () => cache } },
    runtimeState: { value: { getCapState: unseeded } },
    ctx: { value: { logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } } },
    registerBatteryIfSupported: { value: () => undefined },
    startBatteryUpdatePolling: { value: () => undefined },
  })
  // Cap registration is what derives the flag from the persisted cache.
  const adopt: unknown = Reflect.get(ReolinkCamera.prototype, 'adoptBatteryFromDeviceCache')
  if (typeof adopt !== 'function') throw new Error('adoptBatteryFromDeviceCache is not a method')
  Reflect.apply(adopt, camera, [])
  return camera
}

describe('ReolinkAccessoryHost.isBatteryCam', () => {
  it('is true for a persisted battery-cam with no feature-probe slice', () => {
    expect(makeCamera({ deviceType: 'battery-cam' }).isBatteryCam()).toBe(true)
  })

  it('is true for a hub-adopted battery child (hasBattery)', () => {
    expect(makeCamera({ deviceType: 'camera', hasBattery: true }).isBatteryCam()).toBe(true)
  })

  it('is false for a wired camera', () => {
    expect(makeCamera({ deviceType: 'camera' }).isBatteryCam()).toBe(false)
  })
})
