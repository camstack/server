import { DeviceFeature } from '@camstack/types'

/**
 * Reolink-specific flag bag stored in the `feature-probe` runtime-state
 * slice. Drivers' `getProbeFlags<T>()` casts the open record to this
 * shape — undefined means "the probe didn't fill it" (firmware quirk
 * or pre-probe read).
 */
export type ReolinkProbeFlags = {
  hasBattery?: boolean
  hasPtz?: boolean
  hasIntercom?: boolean
  hasDoorbell?: boolean
  hasFloodlight?: boolean
  hasSiren?: boolean
  hasPirSensor?: boolean
  hasAutotrack?: boolean
} & Record<string, unknown>

/** Inputs `deriveReolinkCameraFeatures` reads. Kept explicit so the rule is
 *  testable without constructing a whole `ReolinkCamera` + `DeviceContext`. */
export interface ReolinkFeatureInputs {
  /** The `feature-probe` runtime-state flag bag. `{}` before the first probe. */
  readonly probe: ReolinkProbeFlags
  /**
   * The driver's own battery discriminator — set in the constructor from
   * `deviceCache.deviceType === 'battery-cam'` / `deviceCache.hasBattery`,
   * and again on `adoptApi` / `getBatteryInfo`. It does NOT need the radio.
   */
  readonly isBattery: boolean
}

/**
 * Derive the device-manager feature set for a Reolink camera.
 *
 * `battery-operated` is derived from the probe flag **OR** the driver's own
 * `isBattery` discriminator — never the probe alone. The probe slice is
 * written only by a SUCCESSFUL `feature-probe` round-trip, and a battery
 * camera that is asleep (or flat, or off-LAN) never answers one: device 106
 * "Baby monitor" held `deviceCache.deviceType === 'battery-cam'`, a
 * `battery` runtime slice reporting `sleeping: true`, and STILL published
 * `features = ['native-snapshot','rebootable']` because the `feature-probe`
 * slice had never been written.
 *
 * That miss is not cosmetic. `DeviceFeature.BatteryOperated` is the gate for:
 *   - the viewer's battery badge + sleeping overlay (`use-cameras.ts` FEATURE
 *     map) — without it the camera is drawn as an ordinary awake camera;
 *   - the snapshot wrapper's sleep gate (`snapshot.addon.ts`
 *     `lookupDeviceMeta().isBattery`) — without it every thumbnail refresh
 *     issues a Baichuan login and WAKES the camera (observed hourly on 106
 *     while it sat at 14%);
 *   - the broker's `preBufferSec = 0` battery rule and its relaxed stall
 *     watchdog.
 *
 * The probe's own `hasBattery` is already sticky-true (`applyProbe` never
 * clears it). This makes the DERIVED answer sticky the same way, for the
 * window before any probe has ever succeeded.
 */
export function deriveReolinkCameraFeatures(inputs: ReolinkFeatureInputs): DeviceFeature[] {
  const { probe, isBattery } = inputs
  const out: DeviceFeature[] = [DeviceFeature.NativeSnapshot, DeviceFeature.Rebootable]
  if (probe.hasBattery === true || isBattery) out.push(DeviceFeature.BatteryOperated)
  if (probe.hasPtz === true) out.push(DeviceFeature.PanTiltZoom)
  if (probe.hasAutotrack === true) out.push(DeviceFeature.PtzAutotrack)
  if (probe.hasIntercom === true) out.push(DeviceFeature.TwoWayAudio)
  if (probe.hasDoorbell === true) out.push(DeviceFeature.DoorbellButton)
  return out
}
