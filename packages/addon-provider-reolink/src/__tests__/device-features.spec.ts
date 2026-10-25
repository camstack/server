import { DeviceFeature } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { deriveReolinkCameraFeatures } from '../device-features.js'

/**
 * `battery-operated` must survive a camera that has NEVER answered a
 * feature probe.
 *
 * Live root cause (2026-08-15, device 106 "Baby monitor", Argus 3E):
 *   - `deviceCache.deviceType === 'battery-cam'` → the driver set
 *     `isBattery = true` in its constructor and registered the `battery` cap;
 *   - `battery` runtime slice: `{ percentage: 14, sleeping: true }`;
 *   - `feature-probe` runtime slice: ABSENT — every probe since the camera
 *     went to sleep died on `BCUDP discovery timeout after 15000ms`;
 *   - `deviceManager.getDevice(106).features` → `['native-snapshot',
 *     'rebootable']`.
 *
 * So the viewer drew an awake, non-battery camera, and the snapshot
 * wrapper's sleep gate (which asks `features.includes(BatteryOperated)`)
 * was disabled — waking the camera hourly for a thumbnail at 14% charge.
 */
describe('deriveReolinkCameraFeatures', () => {
  it('reports battery-operated from the driver discriminator when the probe never ran', () => {
    const features = deriveReolinkCameraFeatures({
      probe: {},
      isBattery: true,
    })
    expect(features).toContain(DeviceFeature.BatteryOperated)
  })

  it('reports battery-operated when the probe says so even if the driver has not flagged it yet', () => {
    const features = deriveReolinkCameraFeatures({
      probe: { hasBattery: true },
      isBattery: false,
    })
    expect(features).toContain(DeviceFeature.BatteryOperated)
  })

  it('does NOT invent battery-operated for a wired camera', () => {
    const features = deriveReolinkCameraFeatures({
      probe: { hasPtz: true },
      isBattery: false,
    })
    expect(features).not.toContain(DeviceFeature.BatteryOperated)
    expect(features).toContain(DeviceFeature.PanTiltZoom)
  })

  it('keeps battery-operated when a half-awake probe answers hasBattery:false', () => {
    // The ability table read through an NVR (or against a camera that is
    // waking) routinely omits the battery leaf. `applyProbe` already keeps the
    // flag sticky-true; the derivation must not undo that via `isBattery`.
    const features = deriveReolinkCameraFeatures({
      probe: { hasBattery: false },
      isBattery: true,
    })
    expect(features).toContain(DeviceFeature.BatteryOperated)
  })

  it('always carries the two unconditional Reolink features', () => {
    const features = deriveReolinkCameraFeatures({
      probe: {},
      isBattery: false,
    })
    expect(features).toEqual([DeviceFeature.NativeSnapshot, DeviceFeature.Rebootable])
  })

  it('maps every optional probe flag to its feature', () => {
    const features = deriveReolinkCameraFeatures({
      probe: {
        hasPtz: true,
        hasAutotrack: true,
        hasIntercom: true,
        hasDoorbell: true,
      },
      isBattery: false,
    })
    expect(features).toEqual([
      DeviceFeature.NativeSnapshot,
      DeviceFeature.Rebootable,
      DeviceFeature.PanTiltZoom,
      DeviceFeature.PtzAutotrack,
      DeviceFeature.TwoWayAudio,
      DeviceFeature.DoorbellButton,
    ])
  })
})
