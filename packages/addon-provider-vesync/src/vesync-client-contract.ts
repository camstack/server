/**
 * The minimal contract the VeSync client library is adapted to. The library is **`tsvesync`**
 * (MIT, TypeScript-native); its adapter is `vesync-tsvesync-client.ts`, the default
 * `makeClient` of {@link VeSyncIntegrationManager}. The names map onto `tsvesync` thinly:
 *   - `login()`                 → `VeSync.login(1, 0)` (one attempt; a failure is a typed error)
 *   - `listDevices()`           → `VeSync.getDevices()` + each purifier's `getDetails()`
 *   - `setPower(on)`            → device `turnOn()` / `turnOff()`
 *   - `setFanSpeed(pct)`        → device `changeFanSpeed(level)`
 *   - `setMode(mode)`           → device `setMode('sleep' | 'manual' | 'auto')`
 *   - `setChildLock(on)`        → device `setChildLock(on)`
 *   - `setDisplay(on)`          → device `setDisplay(on)`
 *   - `setTargetHumidity(pct)`  → humidifier `setHumidity(pct)`
 *   - `refreshDevice(id)`       → that one device's `getDetails()` (after a command)
 *   - (`nightLight` — tsvesync `setNightLight(mode)` — is deferred; it maps to the
 *      HA `night_light_level` select and needs a new `select-control` cap first)
 *
 * VeSync is a CLOUD ACCOUNT integration (unlike the local-gateway Velux / Ecowitt
 * pattern): the client logs in with an email / password / region against the
 * VeSync API, lists the account's devices, and drives + polls each one over
 * HTTPS. There is no local push channel, so the account is POLLED.
 */

/**
 * Immutable snapshot of one VeSync air purifier at a point in time. The device
 * layer maps these fields onto the Dominevo cap slices:
 *   - `power`            → `switch` (main on/off) on the Fan device
 *   - `speedPercent` / `preset` / `availablePresets` / `percentageStep`
 *                        → `fan-control` on the Fan device
 *   - `childLock`        → a `DeviceType.Switch` accessory child (`switch`)
 *   - `display`          → a `DeviceType.Switch` accessory child (`switch`)
 *   - `airQuality`       → an `air-quality-sensor` accessory Sensor child
 *   - `filterLifePercent`→ a `numeric-sensor` (unit `%`) accessory Sensor child
 */
export interface VeSyncPurifierSnapshot {
  readonly kind: 'purifier'
  /** VeSync device `cid` — stable across reboots; the purifier native id. */
  readonly nativeId: string
  /** Operator-assigned device name from the VeSync account. */
  readonly name: string
  /** VeSync device model string (e.g. `Core300S`), when reported. */
  readonly model?: string
  /** The device MAC (`macID` of the device list), when reported. */
  readonly mac?: string
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

/**
 * Immutable snapshot of one VeSync humidifier (the tsvesync `VeSyncHumidifier`,
 * `VeSyncHumid200S`, `VeSyncWarmHumidifier`, `VeSyncHumid1000S` and
 * `VeSyncSuperior6000S` classes). The device layer maps it onto:
 *   - `power` / `currentHumidity` / `targetHumidity` / `mode` / `availableModes` /
 *     `minHumidity` / `maxHumidity` → `humidifier` on the Humidifier device
 *   - `display`         → a `DeviceType.Switch` accessory child (`switch`)
 *   - `currentHumidity` → a `humidity-sensor` accessory Sensor child
 *   - `waterLacks`      → a `binary` accessory Sensor child (tank empty)
 */
export interface VeSyncHumidifierSnapshot {
  readonly kind: 'humidifier'
  /** VeSync device `cid`. */
  readonly nativeId: string
  readonly name: string
  readonly model?: string
  readonly mac?: string
  readonly power: boolean
  /** Measured relative humidity 0..100; null when the device did not report one. */
  readonly currentHumidity: number | null
  /** Humidity setpoint 0..100; null when the device did not report one. */
  readonly targetHumidity: number | null
  /** Active mode (`auto` / `manual` / `sleep` / …); empty when not reported. */
  readonly mode: string
  readonly availableModes: readonly string[]
  /** The setpoint range the library accepts; null when it does not say. */
  readonly minHumidity: number | null
  readonly maxHumidity: number | null
  /** Front-panel display state. */
  readonly display: boolean
  /** Whether the water tank is empty; null when the model does not report it. */
  readonly waterLacks: boolean | null
  readonly online: boolean
}

/** Any VeSync device the integration drives, discriminated on `kind`. */
export type VeSyncDeviceSnapshot = VeSyncPurifierSnapshot | VeSyncHumidifierSnapshot

/**
 * A VeSync cloud session — what a sign-in mints. `token` is a credential: it is kept in the
 * keychain (never plain settings, env, argv or a log line). Times are epoch SECONDS, as the
 * token's own JWT `iat` / `exp` carry them; null when the token does not say.
 */
export interface VeSyncSession {
  readonly token: string
  readonly accountId: string
  readonly countryCode: string | null
  readonly region: string
  readonly apiBaseUrl: string
  readonly authFlowUsed: 'legacy' | 'new' | null
  /**
   * The terminal the token was minted for. VeSync binds a token to it and mails the account a
   * "new login" for every terminal it has not seen, so it is kept and presented again. Null for a
   * session stored before it was kept.
   */
  readonly terminalId: string | null
  readonly issuedAt: number | null
  readonly expiresAt: number | null
}

/**
 * The cloud refused the session a client was restored with (expired / revoked token, or the
 * library could not adopt it). A fresh {@link VeSyncClient.login} is the remedy; any other
 * failure (network, a refused re-authentication) is a different error.
 */
export class VeSyncSessionRejectedError extends Error {
  constructor(words: string) {
    super(`vesync: stored session refused: ${words}`)
    this.name = 'VeSyncSessionRejectedError'
  }
}

/** The live client the addon drives one VeSync account with. */
export interface VeSyncClient {
  /** Authenticate with the VeSync cloud (email / password / region). */
  login(): Promise<void>
  /**
   * Adopt a session minted earlier instead of signing in. Nothing is sent: the next call
   * either works or throws {@link VeSyncSessionRejectedError}.
   */
  restoreSession(session: VeSyncSession): void
  /** Drop the session / tokens. */
  logout(): Promise<void>
  /** Enumerate the account's purifiers and humidifiers, each refreshed. */
  listDevices(): Promise<readonly VeSyncDeviceSnapshot[]>
  /**
   * Re-read ONE device (its `getDetails()`), nothing else, and answer its fresh snapshot — null
   * when it is not on the last device list. A refused read throws.
   */
  refreshDevice(nativeId: string): Promise<VeSyncDeviceSnapshot | null>
  /** Resolve one device by its native id from the last-known list, or null. */
  getDevice(nativeId: string): VeSyncDeviceSnapshot | null
  /** Turn a purifier or humidifier on / off (tsvesync `turnOn()` / `turnOff()`). */
  setPower(nativeId: string, on: boolean): Promise<void>
  /** Drive a purifier fan speed (0..100 percent → tsvesync `changeFanSpeed`). */
  setFanSpeed(nativeId: string, percent: number): Promise<void>
  /** Select a mode (`manual`, `sleep`, `auto`, … → tsvesync `setMode`). */
  setMode(nativeId: string, mode: string): Promise<void>
  /** Toggle the physical child lock (tsvesync `setChildLock`). */
  setChildLock(nativeId: string, on: boolean): Promise<void>
  /** Toggle the front-panel display (tsvesync `setDisplay`). */
  setDisplay(nativeId: string, on: boolean): Promise<void>
  /** Set a humidifier's humidity setpoint, percent (tsvesync `setHumidity`). */
  setTargetHumidity(nativeId: string, percent: number): Promise<void>
}

/** Region the VeSync account is homed in — drives the API endpoint. */
export type VeSyncRegion = 'US' | 'EU'

/** Factory seam: build a live {@link VeSyncClient} for a set of credentials. */
export type VeSyncClientFactory = (input: {
  readonly email: string
  readonly password: string
  readonly region: VeSyncRegion
  /** ISO-3166 alpha-2 country the account signs in as; absent = the library default (`US`). */
  readonly countryCode?: string
  /**
   * The terminal id to present to VeSync on sign-in (one per integration, kept across restarts);
   * absent lets the library make one up, which VeSync treats as a new device.
   */
  readonly terminalId?: string
  /**
   * Told every time the client holds a NEW session — after `login()`, and after the library
   * re-authenticated on its own when the cloud refused a token mid-run. The caller persists it.
   */
  readonly onSession?: (session: VeSyncSession) => void
}) => VeSyncClient
