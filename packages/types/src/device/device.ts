import type { z } from 'zod'
import type { DeviceType, DeviceFeature, DeviceRole } from './device-type.js'
import type { DeviceConfig } from './device-config.js'
import type { DeviceContext } from './device-context.js'
import type { ConfigUISchemaWithValues } from '../interfaces/config-ui.js'
import type { RawStateResult } from '../capabilities/device-ops.cap.js'
import type { IDeviceRuntimeState } from './device-runtime-state.js'

export interface IDevice {
  /** Progressive, system-wide unique numeric id. Assigned by the hub's
   *  `device-manager` at `allocateDeviceId` time, injected through
   *  `DeviceContext.id` and read verbatim by `BaseDevice`. Distinct from
   *  `stableId`, which is unique per owning addon. Non-nullable — every
   *  live IDevice has one (the hub allocates before the device is
   *  constructed). Persists across removals: ids are never reissued. */
  readonly id: number
  readonly stableId: string
  readonly type: DeviceType
  readonly name: string
  /**
   * Operator-organisational location label (room / area / zone).
   * `null` when unset. Free-text — providers don't interpret it; the
   * UI groups devices by this for filters like "show me all cameras
   * in Kitchen". Mutated via `kernel.devices.setLocation(id, value)`.
   */
  readonly location: string | null
  /**
   * Soft-disabled flag. When `true`, the device class is still
   * instantiated and visible in the UI (so the operator can flip
   * back on without re-adding) but lifecycle hooks (publishToBroker,
   * alarm-stream subscribe, …) MUST be gated by the driver to skip
   * work. The `BaseDevice` exposes the flag; it doesn't mutate cap
   * behaviour automatically — drivers consult `this.disabled` at
   * the top of their lifecycle methods. Mutated via
   * `kernel.devices.setDisabled(id, value)`.
   */
  readonly disabled: boolean
  /** Numeric id of this device's parent, or null when standalone. The
   *  hub resolves the parent's `stableId` to its numeric id at
   *  registration time so child devices reference parents by numeric id
   *  internally — `stableId` stays at the external boundary. */
  readonly parentDeviceId: number | null
  /**
   * Optional semantic role this device plays within its parent.
   * Driver addons set this when they create accessory devices (siren,
   * floodlight, PIR, chime, doorbell). The admin UI uses it to pick
   * icons, labels, and widgets. Undefined for top-level devices.
   */
  readonly role?: DeviceRole
  /**
   * Device liveness flag. On `BaseDevice` this is a getter+setter pair
   * proxying through the `device-status` runtime-state slice — both
   * `device.online` reads and `device.online = true` writes route
   * through the cap-keyed slice. `markOnline()` is the explicit
   * method form for callers that prefer the imperative shape.
   */
  online: boolean
  readonly features: readonly DeviceFeature[]
  readonly config: DeviceConfig<z.ZodObject<z.core.$ZodLooseShape>>
  readonly ctx: DeviceContext
  /**
   * Kernel-managed per-device runtime-state surface (cap-keyed slices:
   * `device-status`, `feature-probe`, `battery`, …). Present on every
   * `BaseDevice` subclass; optional here because a handful of direct
   * `IDevice` implementors (legacy Onvif camera classes) predate
   * the runtime-state machinery and don't carry one. Consumers that read
   * it (e.g. the device-manager's `probed`-flag derivation) tolerate
   * `undefined` as "no slice".
   */
  readonly runtimeState?: IDeviceRuntimeState

  removeDevice(): Promise<void>

  /**
   * Set the device's online flag. Called by `BaseDeviceProvider` after
   * aggregating per-profile stream-broker health (or by drivers that have
   * provider-side liveness signals). Mutates the `online` field; the
   * field is `readonly` to consumers but writable through this method.
   */
  markOnline(online: boolean): void

  /**
   * Device-authored settings UI. Returns the fully-hydrated schema (fields
   * carry their current values inline) rendered by the admin UI under the
   * device-details Config tab. Drivers with no settings to expose return
   * `{ sections: [] }` — the aggregator drops empty contributions.
   *
   * This is the SINGLE source of truth for device settings UI. There is no
   * auto-generation fallback: if a driver wants its config editable, it
   * declares the shape here. `BaseDevice` provides the empty default so
   * drivers opt in when they have something to show.
   */
  getSettingsUISchema(): ConfigUISchemaWithValues

  /**
   * Write a flat patch coming from the UI (keyed by the `ConfigField.key`
   * the driver emitted in `getSettingsUISchema`) back into storage.
   * Drivers whose UI shape differs from the storage shape reshape the
   * patch here before `config.setAll`. `BaseDevice` defaults to a direct
   * `config.setAll(patch)` so drivers opt in only when they need reshape.
   */
  applySettingsPatch(patch: Record<string, unknown>): Promise<void>

  /**
   * Invoke a device custom action registered via `registerDeviceAction`.
   * Validates input against the action's spec, then runs its handler.
   * Throws on an unknown action. The device equivalent of an addon
   * customAction; dispatched cross-process via `device-ops.runAction`.
   */
  runDeviceAction(action: string, input: unknown): Promise<unknown>

  /**
   * Optional: return this device's RAW upstream state (cached provider
   * values) as a display-safe `{ source, data }` blob, or `null`/absent
   * when none. Surfaced via `device-ops.getRawState` in the State panel.
   */
  getRawState?(): Promise<RawStateResult | null>
}
