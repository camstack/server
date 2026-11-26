/**
 * Camera 101 with an accessory (the siren, ungrouped) AND a child its author put
 * in a declared section ("Diagnostics"): the order of the two on the device page.
 * Load it BEFORE the others:
 * `--fixtures child-sections,hero-siren-child,camera,hero-model,hero-siren,helpers`.
 */
import camera from './camera'
import { defineFixtures } from './_define'
import siren, { SIREN_DEVICE } from './hero-siren'

const SECTIONED_CHILD = {
  ...SIREN_DEVICE,
  id: 592,
  name: 'Voltage',
  stableId: 'cam-101-voltage',
  parentDeviceId: 101,
}

export default defineFixtures({
  area: 'child-sections',
  description: 'Camera 101 declares a childLayout section next to an ungrouped accessory',
  handlers: {
    'deviceManager.getChildren': (i: { parentDeviceId?: number }) =>
      i.parentDeviceId === 101 ? [{ ...SIREN_DEVICE, parentDeviceId: 101 }, SECTIONED_CHILD] : [],
    'deviceManager.getDevice': (i: { deviceId?: number }) => {
      const pick =
        i.deviceId === SIREN_DEVICE.id
          ? siren.handlers['deviceManager.getDevice']
          : camera.handlers['deviceManager.getDevice']
      const out = typeof pick === 'function' ? (pick as (x: unknown) => unknown)(i) : pick
      return i.deviceId === 101 && typeof out === 'object' && out !== null
        ? { ...out, childLayout: [{ childKey: 'voltage', section: 'Diagnostics' }] }
        : out
    },
  },
})
