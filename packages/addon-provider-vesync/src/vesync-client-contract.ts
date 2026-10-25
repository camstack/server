/**
 * The minimal contract the VeSync client library is adapted to. The chosen lib
 * is **`tsvesync`** (v1.0.68, MIT, TypeScript-native) — DECLARED as a dependency
 * but its adapter is not wired yet (see `plan-vesync.md`). This interface is the
 * seam the integration manager builds against, so the whole device layer
 * type-checks today. The method / field names below are modelled on `tsvesync`'s
 * real air-purifier API so the future factory is a THIN adapter:
 *   - `login()`                 → `VeSync.login()`
 *   - `listDevices()`           → `VeSync.getDevices()` → `fans` / air-purifier list
 *   - `setPower(on)`            → device `turnOn()` / `turnOff()`
 *   - `setFanSpeed(pct)`        → device `changeFanSpeed(level)`
 *   - `setMode(mode)`           → device `setMode('sleep' | 'manual' | 'auto')`
 *   - `setChildLock(on)`        → device `setChildLock(on)`
 *   - `setDisplay(on)`          → device `setDisplay(on)`
 *   - (`nightLight` — tsvesync `setNightLight(mode)` — is deferred; it maps to the
 *      HA `night_light_level` select and needs a new `select-control` cap first)
 *
 * When the adapter is implemented in {@link VeSyncIntegrationManager}'s
 * `makeClient` factory, the "not wired" default is dropped; NOTHING else in this
 * addon changes.
 *
 * VeSync is a CLOUD ACCOUNT integration (unlike the local-gateway Velux / Ecowitt
 * pattern): the client logs in with an email / password / region against the
 * VeSync API, lists the account's devices, and drives + polls each one over
 * HTTPS. There is no local push channel, so the account is POLLED.
 */

/**
 * Immutable snapshot of one VeSync air purifier at a point in time. The device
 * layer maps these fields onto the CamStack cap slices:
 *   - `power`            → `switch` (main on/off) on the Fan device
 *   - `speedPercent` / `preset` / `availablePresets` / `percentageStep`
 *                        → `fan-control` on the Fan device
 *   - `childLock`        → a `DeviceType.Switch` accessory child (`switch`)
 *   - `display`          → a `DeviceType.Switch` accessory child (`switch`)
 *   - `airQuality`       → an `air-quality-sensor` accessory Sensor child
 *   - `filterLifePercent`→ a `numeric-sensor` (unit `%`) accessory Sensor child
 */
export interface VeSyncPurifierSnapshot {
  /** VeSync device `cid` — stable across reboots; the purifier native id. */
  readonly nativeId: string
  /** Operator-assigned device name from the VeSync account. */
  readonly name: string
  /** VeSync device model string (e.g. `Core300S`), when reported. */
  readonly model?: string
  /** Main power state. */
  readonly power: boolean
  /** Active fan speed as 0..100 inclusive. Null when the device has not yet
   *  reported a speed (or is off). */
  readonly speedPercent: number | null
  /** Speed granularity the device accepts (HA `percentage_step`, e.g. 33.33 for a
   *  3-speed purifier). Absent when unknown. */
  readonly percentageStep?: number
  /** Active preset mode (`sleep`, vendor-specific) — empty string when no preset
   *  is active. */
  readonly preset: string
  /** Preset modes the device accepts (HA `preset_modes`, e.g. `['sleep']`). */
  readonly availablePresets: readonly string[]
  /** Physical child-lock toggle state. */
  readonly childLock: boolean
  /** Front-panel display toggle state. */
  readonly display: boolean
  /** Air-quality reading (PM2.5 in µg/m³ as reported by the purifier's laser
   *  sensor). Absent when the model has no air-quality sensor. */
  readonly airQuality?: number
  /** Remaining filter life as 0..100 percent. Null when not reported. */
  readonly filterLifePercent: number | null
  /** Whether the device is currently reachable through the VeSync cloud. */
  readonly online: boolean
}

/** The live client the addon drives one VeSync account with. */
export interface VeSyncClient {
  /** Authenticate with the VeSync cloud (email / password / region). */
  login(): Promise<void>
  /** Drop the session / tokens. */
  logout(): Promise<void>
  /** Enumerate all air-purifier devices on the account. */
  listDevices(): Promise<readonly VeSyncPurifierSnapshot[]>
  /** Resolve one purifier by its native id from the last-known list, or null. */
  getDevice(nativeId: string): VeSyncPurifierSnapshot | null
  /** Turn a purifier on / off (tsvesync `turnOn()` / `turnOff()`). */
  setPower(nativeId: string, on: boolean): Promise<void>
  /** Drive a purifier fan speed (0..100 percent → tsvesync `changeFanSpeed`). */
  setFanSpeed(nativeId: string, percent: number): Promise<void>
  /** Select a preset mode (`sleep`, … → tsvesync `setMode`). */
  setMode(nativeId: string, mode: string): Promise<void>
  /** Toggle the physical child lock (tsvesync `setChildLock`). */
  setChildLock(nativeId: string, on: boolean): Promise<void>
  /** Toggle the front-panel display (tsvesync `setDisplay`). */
  setDisplay(nativeId: string, on: boolean): Promise<void>
}

/** Region the VeSync account is homed in — drives the API endpoint. */
export type VeSyncRegion = 'US' | 'EU'

/** Factory seam: build a live {@link VeSyncClient} for a set of credentials. */
export type VeSyncClientFactory = (input: {
  readonly email: string
  readonly password: string
  readonly region: VeSyncRegion
}) => VeSyncClient
