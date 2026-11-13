/**
 * The siren as an accessory of the camera fixture's `/devices/101`: its row in
 * the Accessories panel. Load it BEFORE `camera` (an earlier fixture wins a
 * path) — `--fixtures hero-siren-child,camera,hero-model,hero-siren,helpers`.
 * The siren's own paths answer here; every other device falls through to the
 * camera fixture.
 */
import camera from './camera'
import { defineFixtures } from './_define'
import siren, { SIREN_DEVICE } from './hero-siren'

const SIREN_ID = SIREN_DEVICE.id

const own =
  (path: string) =>
  (input: { deviceId?: number }): unknown => {
    const ours = siren.handlers[path]
    const theirs = camera.handlers[path]
    const pick = input.deviceId === SIREN_ID ? ours : theirs
    return typeof pick === 'function' ? (pick as (i: unknown) => unknown)(input) : pick
  }

export default defineFixtures({
  area: 'hero-siren-child',
  description: 'Camera 101 carries the siren accessory 591 in its Devices panel',
  handlers: {
    'deviceManager.getChildren': (i: { parentDeviceId?: number }) =>
      i.parentDeviceId === 101 ? [{ ...SIREN_DEVICE, parentDeviceId: 101 }] : [],
    'deviceManager.getBindings': own('deviceManager.getBindings'),
    'deviceManager.getDevice': own('deviceManager.getDevice'),
    'deviceState.getSnapshot': own('deviceState.getSnapshot'),
    'deviceState.getCapSlice': (i: { deviceId?: number; capName?: string }) => {
      const pick = i.deviceId === SIREN_ID ? siren.handlers['deviceState.getCapSlice'] : camera.handlers['deviceState.getCapSlice']
      return typeof pick === 'function' ? (pick as (x: unknown) => unknown)(i) : pick
    },
  },
})
