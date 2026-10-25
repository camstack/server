import type { z } from 'zod'
import type { IDevice } from './device.js'
import type { DeviceType } from './device-type.js'
import type { SourceInfo } from './source-info.js'

export interface DeviceManualCreation {
  getChildCreationSchema(type: DeviceType): z.ZodObject<z.core.$ZodLooseShape>
  createDevice(type: DeviceType, config: unknown): Promise<IDevice>
}

export interface DeviceDiscovery {
  discoverDevices(): Promise<readonly DiscoveredDevice[]>
  adoptDiscoveredDevice(candidate: DiscoveredDevice): Promise<IDevice>
}

export interface DiscoveredDevice {
  readonly stableId: string
  readonly type: DeviceType
  readonly suggestedName: string
  readonly prefilledConfig: Record<string, unknown>
  /** Optional upstream-system identity + rendering envelope. See
   *  `SourceInfo`. Providers populate this when discovery already knows
   *  the upstream identity / unit / deviceClass (HA-style discovery). */
  readonly sourceInfo?: SourceInfo
}

export interface SavedDevice {
  /** Numeric id reserved at allocateDeviceId time. */
  readonly id: number
  /** External-system identifier — passed to `kernel.devices.create()`. */
  readonly stableId: string
  readonly type: DeviceType
  readonly name: string
  /**
   * Operator-organisational label (room / location / area). `null`
   * when unset. Free-text — providers don't interpret it; the UI
   * groups devices by this field for "show me all cameras in
   * Kitchen" filters.
   */
  readonly location: string | null
  /**
   * Soft-disabled flag. When `true`, the device class is still
   * instantiated and visible in the UI (so the operator can flip it
   * back on without re-adding) but lifecycle hooks
   * (publishToBroker, alarm-stream subscribe, …) are gated off by
   * BaseDevice. Used for "this camera is in maintenance" without
   * destroying its persisted config + bindings + per-device settings.
   */
  readonly disabled: boolean
  readonly parentDeviceId: number | null
  readonly config: Record<string, unknown>
}

/**
 * Read-only snapshot of the device-meta surface, exposed on
 * `DeviceContext.deviceMeta`. The kernel populates it before the
 * device class constructor runs so `BaseDevice` can resolve
 * `name` / `location` / `disabled` without each subclass
 * duplicating those fields in its config schema.
 *
 * Mutations go through `kernel.devices.{setName,setLocation,
 * setDisabled}` — never through `applySettingsPatch`. The two
 * surfaces are deliberately disjoint: `meta` is operator-organisational
 * (free-text labels, on/off toggle), `config` is hardware-specific
 * (host, port, credentials, debug flags, deviceCache).
 */
/**
 * Free-form device metadata — hardware identity + driver-populated
 * facts the operator can both read and edit. Stored as a single JSON
 * blob so future fields (HA matter id, ONVIF profile token, …) don't
 * require schema changes.
 *
 * Conventional keys (drivers should populate when known):
 *   - `manufacturer`  e.g. 'Reolink'
 *   - `model`         e.g. 'Argus PT Ultra'
 *   - `serialNumber`
 *   - `firmware`      software version
 *   - `hardware`      hardware revision
 *   - `mac`           MAC address
 *   - `uid`           vendor-specific globally-unique id (Reolink, etc.)
 *
 * Anything else the driver knows can land alongside (`onvifProfile`,
 * `ipAddress`, `apiPort`, …). All values must be JSON-serializable.
 */
export type DeviceMetadata = Record<string, unknown>

/** One child-placement directive on a container's `childLayout`. The child is
 *  identified by its accessory `stableIdSuffix` (the key the provider passes to
 *  `getAccessoryChildren()`), which is re-sync stable. Children NOT listed here
 *  render in the plain Overview list as today; listed children are grouped into
 *  collapsible accordion sections in the UI (built in a follow-up task). */
export interface ChildLayoutEntry {
  readonly childKey: string // the child's accessory stableIdSuffix (e.g. 'maint-voltage')
  readonly section: string // accordion section title
  readonly order?: number // sort order within the section (ascending)
  /** Section-level default-collapsed hint: when true, the accordion section this
   *  entry belongs to renders closed by default. The section is treated as
   *  collapsed if ANY of its entries sets `collapsed: true`; consistent values
   *  across a section's entries are recommended but not enforced. Absent ⇒ open
   *  by default. */
  readonly collapsed?: boolean
}
export type ChildLayout = readonly ChildLayoutEntry[]

/** Per-cap display refinement inside a `DeviceDisplayOverride` — unit/precision
 *  only (icon/label/hidden are device-level). Keyed by cap name for devices
 *  carrying several numeric caps (e.g. power-meter). */
export interface DeviceCapDisplayOverride {
  readonly unit?: string
  readonly precision?: number
}

/** Operator-authored per-device display override. Rides the `DeviceMeta`
 *  lifecycle (persist/preserve/project/pre-seed) — deliberately NOT a new
 *  cap/store. All fields optional; an empty object is equivalent to absent.
 *  `unit` triggers render-time conversion when same-dimension as the live
 *  slice unit (storage stays in source units); `precision` applies AFTER
 *  conversion; `hidden` removes the device from list surfaces (distinct from
 *  the HA-only accessories-cap `hiddenChildIds` mechanism). */
export interface DeviceDisplayOverride {
  /** Key into ui-library's display icon registry. */
  readonly icon?: string
  /** Overrides the `DEVICE_ROLE_META` label (NOT the device name). */
  readonly label?: string
  /** Canonical spelling (`normalizeUnit` applied at write). */
  readonly unit?: string
  /** Int 0-10, same contract as the slice `precision` field. */
  readonly precision?: number
  readonly hidden?: boolean
  readonly perCap?: Readonly<Record<string, DeviceCapDisplayOverride>>
}

/** Operator-authored per-role display default (unit/precision/icon), keyed by
 *  `DeviceRole` string. Resolution merges these UNDER any per-device
 *  `DeviceDisplayOverride`. Stored whole-record (full replace) in the
 *  device-manager addon store's `roleDisplayDefaults` key — NOT on any device's
 *  meta row. */
export interface RoleDisplayDefault {
  readonly unit?: string
  readonly precision?: number
  readonly icon?: string
}

export interface DeviceMeta {
  readonly id: number
  readonly stableId: string
  readonly addonId: string
  readonly type: DeviceType
  readonly name: string
  /** True once an operator has explicitly renamed this device via `setName`.
   *  Drives the reconcile name-precedence: when set, a re-registration PRESERVES
   *  the operator's name; when unset, the provider's fresh construction-time name
   *  wins (so an improved auto-name propagates instead of being frozen forever).
   *  Absent ⇒ treated as user-named (PRESERVE) for safety on legacy rows that
   *  predate this flag, so an operator's manual rename is never reset. New
   *  auto-derived children land with the flag unset and self-heal their names. */
  readonly userNamed?: boolean
  readonly location: string | null
  readonly disabled: boolean
  readonly parentDeviceId: number | null
  /** Hardware + identity blob; null when nothing has been populated yet. */
  readonly metadata: DeviceMetadata | null
  /** Optional upstream-system identity + rendering envelope. See
   *  `SourceInfo`. Persisted under `metadata.sourceInfo` — this field
   *  is the typed projection callers consume directly. `BaseDevice`
   *  re-extracts via `extractSourceInfoFromMetadata()` for its own
   *  getter; kernel-side reader populates this from the same path. */
  readonly sourceInfo?: SourceInfo
  /** Owning integration id, stamped at create — used by the core to
   *  cascade-delete an integration's devices. Optional: only present
   *  when the device was created through an integration (e.g. HA). */
  readonly integrationId?: string
  /** Optional soft-link to another device id (peer of integrationId).
   *  Set at create; inert today — reserved for the Container→child
   *  passthrough. Nullable: an explicit null means "unlinked". */
  readonly linkDeviceId?: number | null
  /** Durable primary-child override for a CONTAINER device, keyed on the
   *  chosen child's re-sync/rename-stable `entityId` (its `sourceInfo.id`,
   *  falling back to `stableId`). Unlike the numeric `linkDeviceId`, this
   *  survives a re-sync that reallocates the child's numeric id or renames
   *  its row. `null` explicitly clears the override → priority default.
   *  Absent ⇒ no override has ever been set. */
  readonly primaryChildEntityId?: string | null
  /** Container-level layout hint: assigns specific child/accessory devices to
   *  named accordion sections (with optional intra-section order). Each entry's
   *  `childKey` is the child's re-sync-stable accessory `stableIdSuffix`. Set at
   *  create, persisted, projected, and preserved across re-register/restore —
   *  same lifecycle as `primaryChildEntityId`. Absent ⇒ no layout declared (all
   *  children render in the plain Overview list). */
  readonly childLayout?: ChildLayout
  /** Operator-authored per-device display override (icon/label/unit/precision/
   *  hidden). Same create/persist/project/restore lifecycle as `childLayout`.
   *  Absent ⇒ no override; the renderer falls back to role default → live slice
   *  → canonical unit. Applied at RENDER time only — storage stays in source
   *  units. */
  readonly display?: DeviceDisplayOverride
}

/**
 * Initial meta a provider supplies on `onCreateDevice`. Differs
 * from `DeviceMeta` in that `id` / `stableId` / `addonId` are
 * kernel-allocated, not operator-supplied.
 */
export interface InitialDeviceMeta {
  readonly type: DeviceType
  readonly name: string
  readonly location?: string | null
  /** Semantic role string (`DeviceRole`) — stamped at create for
   *  accessory children (e.g. 'numeric-sensor', 'binary-sensor').
   *  Optional: only set when the device is an accessory with a known role. */
  readonly role?: string
  /** Owning integration id, stamped at create — used by the core to
   *  cascade-delete an integration's devices. Optional: only set when
   *  the device is being created through an integration. */
  readonly integrationId?: string
  /** Optional soft-link to another device id (peer of integrationId).
   *  Set at create; inert today — reserved for the Container→child
   *  passthrough. Nullable: an explicit null means "unlinked". */
  readonly linkDeviceId?: number | null
  /** Container-level layout hint set at create — assigns specific
   *  child/accessory devices to named accordion sections (with optional order).
   *  Mirrors `DeviceMeta.childLayout`; persisted, projected, and preserved
   *  across re-register/restore. Optional: only set for CONTAINER devices that
   *  declare a layout. */
  readonly childLayout?: ChildLayout
  /** Per-device display override set at create. Mirrors `DeviceMeta.display`. */
  readonly display?: DeviceDisplayOverride
}

/**
 * Single-call payload returned by `BaseDeviceProvider.onCreateDevice`.
 * Splits operator-organisational labels (`meta`) from hardware-
 * specific config (`config`) — kernel handles the rest:
 * stableId allocation, persistence, instantiation, register.
 *
 * `onAfterCreate` is the escape hatch for providers that need to
 * inject creation-time-only state into the freshly-built device
 * (e.g. Reolink's autodetect handshake hands a live Baichuan API
 * instance; adoption skips a second login). Fires AFTER `register`
 * + `device.onCreated` + accessory auto-spawn complete — the
 * device is fully alive when the callback runs. Best-effort:
 * failures log but don't unwind the already-registered device.
 */
export interface CreateDeviceSpec {
  readonly meta: InitialDeviceMeta
  readonly config: Record<string, unknown>
  readonly onAfterCreate?: (device: IDevice) => Promise<void> | void
}
