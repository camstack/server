import { describe, it, expect } from 'vitest'
import { Blinds, Lock, Camera } from 'lucide-react'
import { deviceLeadIcon, effectiveIconDevice, type DeviceItemDevice } from '../helpers'

describe('deviceLeadIcon', () => {
  it('uses the device-meta icon for a cover (not a generic fallback)', () => {
    expect(
      deviceLeadIcon({
        id: 1,
        type: 'cover',
        name: 'Blind',
        stableId: 's1',
        addonId: 'a1',
        online: true,
        disabled: false,
        parentDeviceId: null,
      }),
    ).toBe(Blinds)
  })
  it('uses the device-meta icon for a lock', () => {
    expect(
      deviceLeadIcon({
        id: 2,
        type: 'lock',
        name: 'Door',
        stableId: 's2',
        addonId: 'a2',
        online: true,
        disabled: false,
        parentDeviceId: null,
      }),
    ).toBe(Lock)
  })
  it('uses the device-meta icon for a camera', () => {
    expect(
      deviceLeadIcon({
        id: 3,
        type: 'camera',
        name: 'Cam',
        stableId: 's3',
        addonId: 'a3',
        online: true,
        disabled: false,
        parentDeviceId: null,
      }),
    ).toBe(Camera)
  })
  it('prefers the role icon when a role is set', () => {
    // doorbell role → DoorClosed in DEVICE_ROLE_META
    const icon = deviceLeadIcon({
      id: 4,
      type: 'camera',
      name: 'Bell',
      stableId: 's4',
      addonId: 'a4',
      online: true,
      disabled: false,
      parentDeviceId: null,
      role: 'doorbell',
    })
    expect(icon).not.toBe(Camera)
  })
})

/**
 * The operator's per-device override, through the ONE path the rows use:
 * `deviceLeadIcon(effectiveIconDevice(device, children))`. A container shows
 * its primary child's glyph — unless the operator re-glyphed the CONTAINER,
 * which used to be the one write this chain never read.
 */
describe('display.icon override', () => {
  const base = {
    stableId: 's',
    addonId: 'a',
    online: true,
    disabled: false,
    parentDeviceId: null,
  }
  const shutter: DeviceItemDevice = { ...base, id: 20, type: 'cover', name: 'Tapparella' }
  const battery: DeviceItemDevice = { ...base, id: 21, type: 'sensor', name: 'Batteria' }

  it('a device glyph (not only a sensor glyph) can be chosen for a camera', () => {
    expect(
      deviceLeadIcon({ ...base, id: 10, type: 'camera', name: 'Bell', display: { icon: 'lock' } }),
    ).toBe(Lock)
  })

  it('an unknown key keeps the type glyph — the override is not a free-text field', () => {
    expect(
      deviceLeadIcon({ ...base, id: 11, type: 'camera', name: 'Cam', display: { icon: 'nope' } }),
    ).toBe(Camera)
  })

  it('a container with no override shows its primary child', () => {
    const container: DeviceItemDevice = {
      ...base,
      id: 30,
      type: 'container',
      name: 'Tapparella kitchen',
      linkDeviceId: 20,
    }
    expect(deviceLeadIcon(effectiveIconDevice(container, [shutter, battery]))).toBe(Blinds)
  })

  it("a container's OWN override outranks its primary child", () => {
    const container: DeviceItemDevice = {
      ...base,
      id: 30,
      type: 'container',
      name: 'Tapparella kitchen',
      linkDeviceId: 20,
      display: { icon: 'lock' },
    }
    expect(deviceLeadIcon(effectiveIconDevice(container, [shutter, battery]))).toBe(Lock)
  })

  it("a container's UNKNOWN override still defers to the primary child", () => {
    const container: DeviceItemDevice = {
      ...base,
      id: 30,
      type: 'container',
      name: 'Tapparella kitchen',
      linkDeviceId: 20,
      display: { icon: 'nope' },
    }
    expect(deviceLeadIcon(effectiveIconDevice(container, [shutter, battery]))).toBe(Blinds)
  })
})

/**
 * The second level: the operator's per-ROLE default ("Set as default for all
 * X sensors"). It was written for a year and read by nothing — this chain
 * went straight from the device override to `DEVICE_ROLE_META`.
 *
 *   device override → role default → built-in role glyph → type glyph
 *
 * and a level naming a glyph the registry cannot draw falls THROUGH.
 */
describe('role display default icon', () => {
  const base = {
    stableId: 's',
    addonId: 'a',
    online: true,
    disabled: false,
    parentDeviceId: null,
  }
  const siren: DeviceItemDevice = { ...base, id: 40, type: 'siren', name: 'Sirena', role: 'siren' }

  it('a role default beats the built-in role glyph', () => {
    expect(deviceLeadIcon(siren, { siren: { icon: 'lock' } })).toBe(Lock)
  })

  it('the device override beats the role default', () => {
    expect(
      deviceLeadIcon({ ...siren, display: { icon: 'camera' } }, { siren: { icon: 'lock' } }),
    ).toBe(Camera)
  })

  it('a role default the registry cannot draw falls through to the built-in glyph', () => {
    expect(deviceLeadIcon(siren, { siren: { icon: 'nope' } })).toBe(deviceLeadIcon(siren))
    expect(deviceLeadIcon(siren, { siren: { icon: 'nope' } })).not.toBe(Lock)
  })

  it('a default for another role, or a default with no icon, changes nothing', () => {
    expect(deviceLeadIcon(siren, { floodlight: { icon: 'lock' } })).toBe(deviceLeadIcon(siren))
    expect(deviceLeadIcon(siren, { siren: { unit: '°C' } })).toBe(deviceLeadIcon(siren))
  })

  it('a device with no role never reads a role default', () => {
    const cam: DeviceItemDevice = { ...base, id: 41, type: 'camera', name: 'Cam' }
    expect(deviceLeadIcon(cam, { siren: { icon: 'lock' } })).toBe(Camera)
  })
})
