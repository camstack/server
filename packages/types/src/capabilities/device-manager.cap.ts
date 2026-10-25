/**
 * Device Manager capability — hub-side singleton that unifies device persistence,
 * live registry access, and all management operations into a single tRPC surface.
 *
 * Replaces:
 *   - `device-persistence` capability (persistence methods absorbed here)
 *   - `device-management.router.ts` (deleted in Phase 2)
 *   - `device-ops.router.ts` (compat layer — deleted; device-provider ops absorbed here)
 *
 * All device provider addons (rtsp, onvif, …) are hub-local: they may
 * fork into separate processes but never run on remote cluster agents. Therefore:
 *   - No nodeId routing needed — this is a pure hub singleton.
 *   - The hub's DeviceRegistry is the single source of truth for all live devices.
 *   - No shadow registry or cross-node aggregation required.
 *
 * Forked workers register devices back to the hub via `ctx.devices`
 * (DeviceManagerApi → ctx.api.deviceManager.registerDevice), same as today.
 */
import { z } from 'zod'
import { CameraSwitchIdSchema } from '../interfaces/camera-switches.js'
import { DEVICE_CHILDREN_BATCH_MAX } from '../device/children-batch-max.js'
import { DeviceType } from '../device/device-type.js'
import { IconKeySchema } from '../device/icon-catalog.js'
import {
  LOCATION_DESCRIPTION_MAX,
  LocationDescriptionAssignmentSchema,
  LocationIconAssignmentSchema,
} from '../device/location-icon.js'
import { SiteZoneSchema } from '../device/site-zone.js'
import { SourceInfoSchema } from '../device/source-info.js'
import { AdoptionJobSchema } from '../interfaces/adoption-job.js'
import { SettingsSchemaWithValuesSchema } from './addon-settings.cap.js'
import { type CapabilityDefinition, method } from './capability-definition.js'
import type { ExtensionSlotDescriptor } from '../device-extension/slot-descriptor.js'
import {
  AdoptInputSchema as AdoptionAdoptInputSchema,
  AdoptResultSchema as AdoptionAdoptResultSchema,
  AdoptionFilterSchema,
  ListCandidatesInputSchema as AdoptionListCandidatesInputSchema,
  ListCandidatesOutputSchema as AdoptionListCandidatesOutputSchema,
  ReleaseInputSchema as AdoptionReleaseInputSchema,
  ResyncInputSchema as AdoptionResyncInputSchema,
  ResyncResultSchema as AdoptionResyncResultSchema,
  AdoptionStatusSchema,
} from './device-adoption.cap.js'
import {
  DeviceSummarySchema,
  DiscoveryCandidateSchema,
  FieldProbeResultSchema,
} from './device-provider.cap.js'
import { StreamSourceEntrySchema } from './schemas/streaming-shared.js'

/**
 * Re-exported so the root barrel's device-manager surface is unchanged. The
 * number itself lives in a schema-free module because the addon-runner needs it
 * too and may not reach this file — see `device/children-batch-max.ts`.
 */
export { DEVICE_CHILDREN_BATCH_MAX }

// ── Output schemas ────────────────────────────────────────────────────────────

/** One child-placement directive on a container's `childLayout`. Structurally
 *  identical to `ChildLayoutEntry` in `device-management.ts` — the cap wire
 *  shape for the same field. The child is identified by its re-sync-stable
 *  accessory `stableIdSuffix` (`childKey`); listed children are grouped into
 *  named accordion sections (with optional intra-section order). */
const ChildLayoutEntrySchema = z.object({
  childKey: z.string(),
  section: z.string(),
  order: z.number().optional(),
  // Section-level default-collapsed hint: when true the accordion section this
  // entry belongs to renders closed by default. The section is treated as
  // collapsed if ANY of its entries sets collapsed:true; consistent values
  // across a section's entries are recommended but not enforced. Absent ⇒ open.
  collapsed: z.boolean().optional(),
})

/** Cap-wire shape of a per-cap display refinement — mirrors
 *  `DeviceCapDisplayOverride` in `device-management.ts`. */
export const DeviceCapDisplayOverrideSchema = z.object({
  unit: z.string().min(1).optional(),
  precision: z.number().int().min(0).max(10).optional(),
})

/** Cap-wire shape of an operator-authored per-device display override —
 *  mirrors `DeviceDisplayOverride` in `device-management.ts`. `precision`
 *  bounds mirror `numeric-sensor.cap.ts` (`int 0-10`). */
export const DeviceDisplayOverrideSchema = z.object({
  icon: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  unit: z.string().min(1).optional(),
  precision: z.number().int().min(0).max(10).optional(),
  hidden: z.boolean().optional(),
  perCap: z.record(z.string(), DeviceCapDisplayOverrideSchema).optional(),
})

/** Cap-wire shape of a per-role display default — mirrors `RoleDisplayDefault`
 *  in `device-management.ts`. Keyed by `DeviceRole` string (role strings cross
 *  the wire as plain strings everywhere else — cf. `DeviceInfoSchema.role`). */
export const RoleDisplayDefaultSchema = z.object({
  unit: z.string().min(1).optional(),
  precision: z.number().int().min(0).max(10).optional(),
  icon: z.string().min(1).optional(),
})

/**
 * Serializable projection of a live IDevice.
 * Returned by listAll, getDevice, getChildren.
 * Live methods (getStreamSources, getConfigSchema) are separate calls.
 */
export const DeviceInfoSchema = z.object({
  /** Progressive, system-wide unique number. Allocated synchronously by
   *  `device-manager.allocateDeviceId` BEFORE the owning `IDevice` is
   *  constructed, so every live device exposes an `id` — no transient
   *  null window. Distinct from `stableId`, which is unique per
   *  integration. Ids are monotonic and never reissued on removal. */
  id: z.number(),
  stableId: z.string(),
  addonId: z.string(),
  type: z.enum(DeviceType),
  name: z.string(),
  /** Operator-organisational location label. `null` when unset. */
  location: z.string().nullable(),
  /** Soft-disabled flag. */
  disabled: z.boolean(),
  parentDeviceId: z.number().nullable(),
  /** Optional semantic role — `DeviceRole` string. null for top-level devices. */
  role: z.string().nullable().optional(),
  online: z.boolean(),
  /** True when the device's initial feature-probe has completed (or it has
   *  no probe) — exported shape is stable; exporters gate advertise on this.
   *  Optional for deploy-order resilience: a record produced by an older
   *  device-manager build omits it, and consumers treat absent as "not ready"
   *  (export gate carries forward, never advertises a partial shape). */
  probed: z.boolean().optional(),
  features: z.array(z.string()),
  /** true when the device has a getStreamSources() method (ICameraDevice) */
  isCamera: z.boolean(),
  /** Current config values — serializable snapshot */
  config: z.record(z.string(), z.unknown()),
  /** Paths inside `config` the device's schema declares secret (D783) —
   *  what the non-admin redaction withholds. Paths, never values. Absent
   *  when the owning runner has not reported them. */
  secretConfigPaths: z.array(z.string()).optional(),
  /** Hardware + identity blob (manufacturer / model / firmware / sn /
   *  uid / mac / …). Populated by drivers; editable via setMetadata. */
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  /** Optional upstream-system identity + rendering envelope. See
   *  `SourceInfo` in `packages/types/src/device/source-info.ts`. */
  sourceInfo: SourceInfoSchema.optional(),
  /** Owning integration id, stamped at create — used by the core to
   *  cascade-delete an integration's devices. Optional: only present
   *  when the device was created through an integration (e.g. HA). */
  integrationId: z.string().optional(),
  linkDeviceId: z.number().nullable().optional(),
  /** Durable primary-child override for a CONTAINER device, keyed on the
   *  chosen child's re-sync/rename-stable `entityId`. Survives a re-sync
   *  that reallocates the child's numeric id. `null` clears the override. */
  primaryChildEntityId: z.string().nullable().optional(),
  /** Container-level layout hint: assigns specific child/accessory devices to
   *  named accordion sections (with optional intra-section order). See
   *  `DeviceMeta.childLayout`. Absent ⇒ no layout declared. */
  childLayout: z.array(ChildLayoutEntrySchema).readonly().optional(),
  /** Operator-authored per-device display override. See `DeviceMeta.display`. */
  display: DeviceDisplayOverrideSchema.optional(),
})

export const ConfigEntrySchema = z.object({
  key: z.string(),
  value: z.unknown(),
  description: z.string().optional(),
})

// ── Linked devices (camera ↔ companion-device association) ───────────────────
//
// A FIRST-CLASS device-manager concept: which non-camera devices "belong to" a
// camera (sensors in the same room, tree children, operator-picked extras).
// Consumed by pipeline-analytics (per-camera sensor event kinds + history) and
// by the camera detail's devices panel (controls for linked devices).
//
// Resolution: device-tree CHILDREN are ALWAYS included, plus the operator's
// persisted pick list (`_linkedDeviceIds`). There is no `auto` mode any more:
// since D356 nothing links itself — devices in the camera's location are only
// SUGGESTED by the picker, and `LinkedDevicesModeSchema` is `manual`-only. A
// container is never a resolved link; it expands to its children. The camera
// itself is excluded; the result is deduped.
//
// CONFIGURATION is the `linked-devices` extension slot declared below, served
// through `device-extension.setSlot` (D648, D655). The per-camera list
// persists as the reserved key `_linkedDeviceIds` in the device config blob,
// the tracked-event opt-in as `_linkedDeviceTrackedIds`, both written by
// `applyLinkedDevicesPatch`; the contract stores nothing of its own. The
// hand-written "Linked devices" settings section that used to write the same
// keys was retired by D655. Only the RESOLVER query lives on this cap.

/**
 * Only `manual` since D356: the operator picks, nothing links itself. The
 * field survives on the wire because a viewer already OTA'd parses it —
 * drop it once no shipped client reads `mode`.
 */
export const LinkedDevicesModeSchema = z.enum(['manual'])
export type LinkedDevicesMode = z.infer<typeof LinkedDevicesModeSchema>

/** One resolved linked device — the compact projection consumers need. */
export const LinkedDeviceSchema = z.object({
  deviceId: z.number(),
  name: z.string(),
  location: z.string().nullable(),
  features: z.array(z.string()),
  /* whether a state change on this linked device materializes a synthetic tracked event on the
   * camera. Optional for version-skew symmetry — consumers default absent → true. */
  producesTrackedEvents: z.boolean().optional(),
})
export type LinkedDevice = z.infer<typeof LinkedDeviceSchema>

/**
 * The `linked-devices` extension slot's editable value (D648): the operator's
 * pick list, exactly what `_linkedDeviceIds` persists. Tree children are NOT
 * in it — they are always linked and are not a pick.
 *
 * `trackedDeviceIds` (D655) is the tracked-event opt-in, exactly what
 * `_linkedDeviceTrackedIds` persists: which linked devices materialize a
 * synthetic tracked event on the camera. A read always carries it AS STORED
 * (an absent key reads as `[]`, which is what the resolver makes of it —
 * NONE). On a write it is optional: absent leaves the opt-in untouched, so a
 * card built before D655 cannot erase it by saving the pick list. A present
 * list REPLACES the opt-in; each id must be a pick, a device the camera links
 * by structure (the row's `impliedSources`: tree children, a picked
 * container's child) or already stored — so what was read can always be
 * written back unchanged, and a NEW opt-in outside the linked set is refused.
 */
export const LinkedDevicesSlotValueSchema = z.object({
  deviceIds: z.array(z.number().int().positive()),
  trackedDeviceIds: z.array(z.number().int().positive()).optional(),
})
export type LinkedDevicesSlotValue = z.infer<typeof LinkedDevicesSlotValueSchema>

/**
 * The `linked-devices` slot — a camera's companion devices, owned by the
 * device manager over `_linkedDeviceIds` (D648, D356). Any device may be a
 * source except a container (its children are picked in its place) and the
 * camera itself.
 */
export const LINKED_DEVICES_SLOT = {
  id: 'linked-devices',
  label: 'Linked devices',
  description:
    'Companion devices of this camera: their controls appear with it, and the ones you ' +
    'opt in produce tracked events on it.',
  shape: 'association',
  hostDeviceTypes: [DeviceType.Camera],
  sourceCaps: 'any',
  cardinality: 'many',
  value: LinkedDevicesSlotValueSchema,
} as const satisfies ExtensionSlotDescriptor

/** One camera's resolved linked set, tagged with the camera it belongs to.
 *  The batch answer needs the tag; the single-device answer already has it
 *  from the input, which is why `getLinkedDevices` keeps the untagged shape. */
export const LinkedDevicesForDeviceSchema = z.object({
  deviceId: z.number(),
  mode: LinkedDevicesModeSchema,
  devices: z.array(LinkedDeviceSchema),
})
export type LinkedDevicesForDevice = z.infer<typeof LinkedDevicesForDeviceSchema>

/** One device's binding map — the shape `getBindings`, `getBindingsBatch` and
 *  `getAllBindings` all answer in. Declared once: three copies of the same
 *  object literal is exactly how the three drift apart. */
export const DeviceBindingsForDeviceSchema = z.object({
  deviceId: z.number(),
  entries: z.array(
    z.object({
      capName: z.string(),
      kind: z.enum(['native', 'wrapped']),
      providerAddonId: z.string(),
      providerNodeId: z.string(),
      nativeAddonId: z.string(),
    }),
  ),
})
export type DeviceBindingsForDevice = z.infer<typeof DeviceBindingsForDeviceSchema>

/**
 * The STORED wrapper activation for one `(device, capability)` pair — the row
 * `setWrapperActive` writes, read back three-way (D675):
 *
 * - `value` — the store answered and holds an activation: the bound wrapper's
 *   addon id, or `null`, the operator's explicit "off" marker (D62);
 * - `missing` — the store answered, its activation map exists, and it holds
 *   nothing for this pair: the operator never activated or deactivated a
 *   wrapper here;
 * - `failed` — the store could not be read, holds no activation map at all
 *   (an empty or unready snapshot, D44), or holds something that is not an
 *   activation. It carries NO information: a consumer must never read it as
 *   `missing` (D315, D393).
 *
 * This is the persisted INPUT, not the derived `getBindings` view — no registry
 * resolution, no `defaultActive` auto-binding, no cluster native-cap folding.
 */
export const WrapperActivationReadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), wrapperAddonId: z.string().nullable() }),
  z.object({ kind: z.literal('missing') }),
  z.object({ kind: z.literal('failed'), error: z.string() }),
])
export type WrapperActivationRead = z.infer<typeof WrapperActivationReadSchema>

export { StreamSourceEntrySchema }

export const SavedDeviceRowSchema = z.object({
  /** Numeric id reserved at allocateDeviceId time. */
  id: z.number(),
  /** External-system identifier — required for the worker's `kernel.devices.create()` call. */
  stableId: z.string(),
  type: z.string(),
  name: z.string(),
  /** Operator-organisational location label. `null` when unset. */
  location: z.string().nullable(),
  /** Soft-disabled flag. */
  disabled: z.boolean(),
  parentDeviceId: z.number().nullable(),
  /** Optional semantic role — stringified `DeviceRole` enum value. null for top-level devices. */
  role: z.string().nullable().optional(),
})

/** Operator-organisational meta surface — populated by the kernel
 *  on `DeviceContext.deviceMeta` so `BaseDevice` can resolve
 *  `name` / `location` / `disabled` without subclass schema duplication.
 *  Mirrors `DeviceMeta` in `device-management.ts` for the cap wire shape. */
export const DeviceMetaSchema = z.object({
  id: z.number(),
  stableId: z.string(),
  addonId: z.string(),
  type: z.string(),
  name: z.string(),
  /** True once an operator explicitly renamed the device via `setName`. Drives
   *  reconcile name-precedence (preserve operator name vs adopt fresh provider
   *  name). Absent ⇒ treated as user-named (PRESERVE) for legacy rows. See
   *  `DeviceMeta.userNamed`. */
  userNamed: z.boolean().optional(),
  location: z.string().nullable(),
  disabled: z.boolean(),
  parentDeviceId: z.number().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  /** Optional upstream-system identity + rendering envelope. See
   *  `SourceInfo`. Present when the device has been persisted with a
   *  non-synthetic source identifier (HA entities, vendor MAC, …);
   *  omitted when the synthetic `{ id: stableId, system: addonId }`
   *  fallback is in effect. Persisted under
   *  `DeviceMeta.metadata.sourceInfo` — the field on this schema is
   *  the typed projection callers consume directly. */
  sourceInfo: SourceInfoSchema.optional(),
  /** Owning integration id, stamped at create — used by the core to
   *  cascade-delete an integration's devices. Optional: only present
   *  when the device was created through an integration (e.g. HA). */
  integrationId: z.string().optional(),
  linkDeviceId: z.number().nullable().optional(),
  /** Durable primary-child override for a CONTAINER device, keyed on the
   *  chosen child's re-sync/rename-stable `entityId`. See `DeviceMeta`. */
  primaryChildEntityId: z.string().nullable().optional(),
  /** Container-level layout hint: assigns child/accessory devices to named
   *  accordion sections (with optional intra-section order). See
   *  `DeviceMeta.childLayout`. Absent ⇒ no layout declared. */
  childLayout: z.array(ChildLayoutEntrySchema).readonly().optional(),
  /** Semantic role string (`DeviceRole`) — propagated from the spawn pre-seed.
   *  Optional: only present for accessory children that carry a known role. */
  role: z.string().nullable().optional(),
  /** Operator-authored per-device display override. See `DeviceMeta.display`. */
  display: DeviceDisplayOverrideSchema.optional(),
})

/** ConfigUISchema passed through as unknown — mirrors device-provider's CreationSchemaOutputSchema */
const ConfigUISchemaOutput = z.unknown().nullable()

const StreamProbeResultSchema = z.object({
  streamId: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  codec: z.string().optional(),
  fps: z.number().optional(),
  bitrateKbps: z.number().optional(),
})

// ── Re-export persistence schemas (for DeviceManagerApi / DevicePersistenceAddon consumers) ──

export const DeviceRegisterPayloadSchema = z.object({
  addonId: z.string(),
  stableId: z.string(),
  /** Pre-allocated numeric id from `allocateDeviceId`. The hub persists
   *  it alongside the meta record; callers never invent this value. */
  id: z.number(),
  type: z.string(),
  name: z.string(),
  /** Operator-organisational location label. Optional on register —
   *  the hub seeds `null` when omitted. */
  location: z.string().nullable().optional(),
  /** Soft-disabled flag. Optional on register — the hub seeds `false`. */
  disabled: z.boolean().optional(),
  parentDeviceId: z.number().nullable(),
  /** Optional semantic role — see `DeviceRole`. Driver authors pass this
   *  at register time when the device is an accessory with a known role. */
  role: z.string().nullable().optional(),
  /** Snapshot of `device.features` at registration time. Persisted in
   *  `DeviceMeta` so the hub can answer `getDevice` for forked-worker
   *  devices with the right `DeviceFeature[]` even when the live
   *  instance lives on a remote node. Re-published on every register
   *  call (workers re-register on init), so probe-driven updates
   *  (e.g. PTZ flag flipping after the abilities probe) propagate. */
  features: z.array(z.string()).optional(),
  config: z.record(z.string(), z.unknown()),
  /** Config paths the device's own schema DECLARES secret
   *  (`.meta({ secret: true })` — dotted, `[]` for array items, e.g.
   *  `connection.password`). Re-published on every register; the non-admin
   *  redaction withholds them at any depth (D783). Optional: an older runner
   *  omits it and the keyword backstop applies. */
  secretConfigPaths: z.array(z.string()).optional(),
})

/** One deleted device, kept by device-manager so an addon that missed the
 *  deletion can still learn of it (D865). Written by the delete path ONLY. */
export const DeviceTombstoneSchema = z.object({
  deviceId: z.number().int().positive(),
  /** Epoch ms the device was deleted. */
  deletedAt: z.number(),
  /** The addon that owned the device when it was deleted. */
  providerAddonId: z.string(),
})

export type DeviceTombstone = z.infer<typeof DeviceTombstoneSchema>

/** How long a tombstone stays readable. Past it, a device that was deleted
 *  and never cleaned is only reachable by the admin "clean data of deleted
 *  devices" action. */
export const DEVICE_TOMBSTONE_RETENTION_MS: number = 90 * 24 * 60 * 60 * 1000

/** Data held for one device that device-manager no longer knows. */
export const OrphanDeviceDataSchema = z.object({
  deviceId: z.number().int().positive(),
  /** Rows/files per store (`<addonId>:<store>`). */
  stores: z.record(z.string(), z.number().int().nonnegative()),
})

export type OrphanDeviceData = z.infer<typeof OrphanDeviceDataSchema>

export const CleanupDeletedDevicesResultSchema = z.object({
  /**
   * `skipped` — the absence check could not be trusted (a device-list read
   * failed or the two reads disagreed); nothing was listed or deleted.
   * `dry-run` — `devices` is what a confirmed run would delete.
   * `cleaned` — `devices` is what was deleted.
   */
  status: z.enum(['skipped', 'dry-run', 'cleaned']),
  reason: z.string().nullable(),
  devices: z.array(OrphanDeviceDataSchema),
  /** Implementers that could not be asked (their stores are not in `devices`). */
  unreachable: z.array(z.string()),
})

export type CleanupDeletedDevicesResult = z.infer<typeof CleanupDeletedDevicesResultSchema>

export const DeviceRemovePayloadSchema = z.object({
  deviceId: z.number(),
})

export const DevicePersistConfigPayloadSchema = z.object({
  deviceId: z.number(),
  data: z.record(z.string(), z.unknown()),
  /** The paths the device's schema declares secret (D783), when the caller
   *  knows them — those values are kept in the keychain, not the blob (D787).
   *  Absent: the paths the device last reported at `registerDevice` apply. */
  secretConfigPaths: z.array(z.string()).optional(),
})

// ── Capability definition ─────────────────────────────────────────────────────

/** What a migration actually did, per switch. `unreachable` is a first-class
 *  answer: a camera that could not be asked is not a camera that was silenced. */
export const MigrateSwitchOutcomeSchema = z.enum(['off', 'on', 'not-offered', 'unreachable'])

export const MigrateSwitchReportSchema = z.object({
  deviceId: z.number(),
  switchId: CameraSwitchIdSchema,
  outcome: MigrateSwitchOutcomeSchema,
  detail: z.string().optional(),
})

export const MigrateDeviceResultSchema = z.object({
  sourceId: z.number(),
  targetId: z.number(),
  switches: z.array(MigrateSwitchReportSchema).readonly(),
  /** Switches that could NOT be turned off on the source. Empty is the only
   *  value meaning the replaced hardware is quiet. */
  sourceStillLive: z.array(CameraSwitchIdSchema).readonly(),
  swapped: z.boolean(),
})

/** What happened to ONE switch on ONE device during a migration. */
export type MigrateSwitchOutcome = z.infer<typeof MigrateSwitchOutcomeSchema>
export type MigrateSwitchReport = z.infer<typeof MigrateSwitchReportSchema>
/** The wire shape a `deviceManager.migrateDevice` caller renders. Inferred
 *  rather than restated so a client cannot drift from the report it displays. */
export type MigrateDeviceResult = z.infer<typeof MigrateDeviceResultSchema>

export const deviceManagerCapability = {
  name: 'device-manager',
  scope: 'system',
  mode: 'singleton',
  // The camera's linked devices, as an extension slot (D648) — their only
  // editor since D655; see the module docblock.
  extensionSlots: [LINKED_DEVICES_SLOT],
  methods: {
    // ── Persistence (migrated from device-persistence) ────────────────────────

    /** Reserve (or re-resolve) a progressive numeric id for `(addonId, stableId)`.
     *  Idempotent: returns the existing id if one is already persisted for the
     *  pair. Callers invoke this before `registerDevice` so the live IDevice
     *  can bind `id` at construction time through `DeviceContext.id`. */
    allocateDeviceId: method(
      z.object({ addonId: z.string(), stableId: z.string() }),
      z.object({ id: z.number() }),
      { kind: 'mutation' },
    ),

    /**
     * Replace a camera: the new hardware inherits the number the system knows.
     *
     * Everything general about a camera is keyed on the numeric id and nothing
     * else — the recording path on disk, the hour ledger, the media store, zone
     * ownership, and all four ecosystem exports. So a replacement moves the
     * NUMBER rather than the work, and the operator keeps their footage, their
     * rules and their integrations.
     *
     * Both cameras are switched off first, then the identities are exchanged
     * (children follow their parent), then the target — now answering on the
     * inherited number — is switched back on.
     *
     * **A switch that could not be written is REPORTED, not swallowed.** The
     * source is characteristically broken, and two of the eight switches write
     * the camera itself, so on a dead one they cannot be written at all.
     * `sourceStillLive` names what stayed live; empty is the only value that
     * means the old hardware is quiet. The migration proceeds either way —
     * refusing would refuse the case this exists for.
     *
     * **Safe to retry.** A duplicate call while a migration involving either
     * device is in flight is REFUSED, never queued; a repeat of a swap that
     * already completed (matched against the `addonId`/`stableId` fingerprint
     * the swap left on the rows, within 15 min) is a no-op returning the
     * original report. A blind re-run can no longer silently undo the
     * migration it retried.
     */
    migrateDevice: method(
      z.object({ sourceId: z.number(), targetId: z.number() }),
      MigrateDeviceResultSchema,
      {
        kind: 'mutation',
        auth: 'admin',
        /*
         * A migration is minutes, not seconds, and the forward must wait for
         * it (same reasoning as `server-management.applyServerUpdate`).
         * Measured 2026-09-01: a full cycle ran ~3.5 min under the 60 s
         * default; the caller died with `UND_ERR_HEADERS_TIMEOUT` and its
         * retry ran a SECOND swap — two swaps cancel out, and with different
         * timing two cameras keep each other's identity. Budget for the worst
         * case (dead source camera): 3 switch phases × 7 forwarded writes ×
         * the 15 s per-write bound (`SWITCH_WRITE_TIMEOUT_MS`, ~5.3 min) +
         * 2 broker forgets (≤60 s each) + the two per-device reloads
         * (concurrent, each ≤ the `deviceProvider.reloadDevice` 3 min bound;
         * a reload that fails adds its addon's fallback restart). Keep this
         * ABOVE that sum — a forward that gives up before the handler answers
         * is what turned one migration into two.
         */
        timeoutMs: 12 * 60_000,
      },
    ),

    /** Register a device in the DB + in-memory registry. Called by DeviceManagerApi.register(). */
    registerDevice: method(DeviceRegisterPayloadSchema, z.void(), { kind: 'mutation' }),

    /** Remove a device from the DB + in-memory registry. Called by DeviceManagerApi.remove(). */
    removeDevice: method(DeviceRemovePayloadSchema, z.void(), { kind: 'mutation' }),

    /** Persist device config blob. Called by DeviceConfig.set/setAll(). */
    //
    // `persistConfig` / `loadConfig` / `loadRuntimeState` are the DEVICE
    // RESTORE path — the raw persisted blob, the camera `password` in
    // plaintext included (D634 r3). Only a device provider's `ctx.api` calls
    // them, and that never enters the tRPC router; `getDevice` & co. already
    // redact the same blob for a non-admin, so a `protected` sibling that
    // returns it whole was the same leak through another door.
    persistConfig: method(DevicePersistConfigPayloadSchema, z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /** Load persisted config for a device. Called at restore time. */
    loadConfig: method(z.object({ deviceId: z.number() }), z.record(z.string(), z.unknown()), {
      auth: 'admin',
    }),

    /** Load persisted runtime state. Called at device adopt time. */
    loadRuntimeState: method(
      z.object({ deviceId: z.number() }),
      z.record(z.string(), z.unknown()),
      { auth: 'admin' },
    ),

    /** Load operator-organisational meta surface for a device. Called by
     *  the kernel proxy to populate `DeviceContext.deviceMeta` before
     *  the device class constructor runs. Returns `null` when the id
     *  doesn't resolve to a persisted row. */
    loadMeta: method(z.object({ deviceId: z.number() }), DeviceMetaSchema.nullable()),

    /** Update the operator-edited display name. Persists to the meta
     *  row + emits `EventCategory.DeviceMetaChanged`. */
    setName: method(z.object({ deviceId: z.number(), name: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /** Update the operator-organisational location label. `null`
     *  clears it. */
    setLocation: method(
      z.object({ deviceId: z.number(), location: z.string().nullable() }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Update the device type. Writes the meta row, emits a
     *  `DeviceMetaChanged` event. Used by the kernel to apply
     *  `initialMeta.type` before device construction so the device
     *  constructs with its real type instead of the allocateDeviceId
     *  placeholder `'generic'`. */
    setType: method(z.object({ deviceId: z.number(), type: z.enum(DeviceType) }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /** Stamp (or update) the owning integration id on the device's meta
     *  row. Called by the kernel's `create()` pre-seed path when
     *  `initialMeta.integrationId` is set (analogous to `setName` /
     *  `setType`). Idempotent. */
    setIntegrationId: method(
      z.object({ deviceId: z.number(), integrationId: z.string() }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Stamp (or update) the soft-link device id on the device's meta
     *  row. Called by the kernel `create()` pre-seed when
     *  `initialMeta.linkDeviceId !== undefined`. Idempotent. */
    setLinkDeviceId: method(
      z.object({ deviceId: z.number(), linkDeviceId: z.number().nullable() }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Set (or clear) the durable primary-child override on a CONTAINER
     *  device's meta row, keyed on the chosen child's re-sync/rename-stable
     *  `entityId`. Unlike `setLinkDeviceId` (numeric child id, goes stale on
     *  re-sync), this survives a re-sync that reallocates the child's numeric
     *  id. `null` clears the override → priority default. Idempotent. */
    setPrimaryChildEntityId: method(
      z.object({ deviceId: z.number(), primaryChildEntityId: z.string().nullable() }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Set (or replace) the container-level `childLayout` on a device's meta
     *  row — assigns specific child/accessory devices to named accordion
     *  sections (with optional intra-section order). Mirrors
     *  `setPrimaryChildEntityId`; the layout is parent-only. Persisted,
     *  projected, and preserved across re-register/restore. Idempotent. */
    setChildLayout: method(
      z.object({ deviceId: z.number(), childLayout: z.array(ChildLayoutEntrySchema).readonly() }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Set (or clear) the per-device display override on the meta row. Mirrors
     *  `setChildLayout` persistence; `null` clears the override entirely. The
     *  override unit(s) are normalized (`normalizeUnit`) at write so the render
     *  path's `UNIT_TABLE` lookups always hit canonical spellings. Persisted,
     *  projected, and preserved across re-register/restore. Idempotent. */
    setDisplay: method(
      z.object({ deviceId: z.number(), display: DeviceDisplayOverrideSchema.nullable() }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Read the operator-authored per-role display defaults (unit/precision/
     *  icon), keyed by `DeviceRole` string. Empty record when none set. */
    getRoleDisplayDefaults: method(
      z.object({}),
      z.object({ defaults: z.record(z.string(), RoleDisplayDefaultSchema) }),
      { role: 'viewer', kind: 'query' },
    ),

    /** Replace the per-role display defaults whole-record (full replace — the
     *  caller sends the complete map). Override unit(s) are normalized at write.
     *  Not per-device, so nothing is emitted; the UI invalidates its own query
     *  on mutate. */
    setRoleDisplayDefaults: method(
      z.object({ defaults: z.record(z.string(), RoleDisplayDefaultSchema) }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** The per-cap catalog of readable status-schema fields for one device.
     *  This is the SOURCE PICKER — it outlived the Wiring tab that first
     *  needed it (deleted 2026-08-08) and becomes the picker of a composition
     *  recipe: every field the old tab could target, a composed device can
     *  read. Caps without a status schema are omitted. Item-array caps
     *  (`status.itemArray`, e.g. consumables) also emit their per-item fields
     *  tagged `item: true` plus the cap-level `itemArray` descriptor.
     *  `includeSynthesizable: true` unions in unbound device-scoped caps that
     *  declare `status.empty` and match the device's type. */
    getWireableFields: method(
      z.object({ deviceId: z.number(), includeSynthesizable: z.boolean().optional() }),
      z.object({
        caps: z
          .array(
            z.object({
              cap: z.string(),
              fields: z
                .array(
                  z.object({
                    path: z.string(),
                    kind: z.enum(['string', 'number', 'boolean', 'enum']),
                    enumValues: z.array(z.string()).optional(),
                    item: z.boolean().optional(),
                  }),
                )
                .readonly(),
              itemArray: z.object({ path: z.string(), keyField: z.string() }).optional(),
            }),
          )
          .readonly(),
      }),
      { kind: 'query' },
    ),

    /** Stamp (or update) the semantic role on the device's meta row.
     *  Called by the kernel's `create()` / `spawnAccessoryChild` pre-seed
     *  path when `initialMeta.role` is set (analogous to `setIntegrationId`).
     *  Idempotent. `null` explicitly clears a previous role. */
    setRole: method(z.object({ deviceId: z.number(), role: z.string().nullable() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /** Batched meta pre-seed — applies every provided field to the device's
     *  meta row in ONE settings round-trip (one lock acquisition, one
     *  `deviceMeta` write) and emits one `DeviceMetaChanged` event per field
     *  that was supplied. Each field carries the SAME semantics as its
     *  individual setter (`setName` / `setLocation` / `setType` /
     *  `setIntegrationId` / `setLinkDeviceId` / `setRole`) — omitted fields are
     *  left untouched; `null` clears `location` / `linkDeviceId` / `role`.
     *  Idempotent. Used by the kernel's `spawnAccessoryChild` flow to collapse
     *  the per-child meta pre-seed (4-6 individual setter calls) into one,
     *  which is the dominant cost when reconciling a many-entity container. */
    applyInitialMeta: method(
      z.object({
        deviceId: z.number(),
        name: z.string().optional(),
        location: z.string().nullable().optional(),
        type: z.enum(DeviceType).optional(),
        integrationId: z.string().optional(),
        linkDeviceId: z.number().nullable().optional(),
        role: z.string().nullable().optional(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Patch the device's hardware-identity metadata blob. Merges
     *  `patch` over the current blob (shallow). Value `null` for a
     *  given key removes that key. Drivers populate factual fields
     *  on first probe (model / firmware / mac / sn / uid); operators
     *  can override or augment via the Device Info tab. */
    setMetadata: method(
      z.object({
        deviceId: z.number(),
        patch: z.record(z.string(), z.unknown()),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Operator-curated location registry. Returns the union of:
     *  (1) labels persisted in the registry via `addLocation`, and
     *  (2) labels currently in use on at least one device's
     *      `meta.location` field.
     *  Sorted case-insensitively + deduped + trimmed of empty strings.
     *  Drives the autocomplete in the Device Info location editor. */
    listLocations: method(z.void(), z.array(z.string())),

    /** Add a label to the curated location registry. No-op when the
     *  label (case-insensitive, trimmed) is already present. Empty
     *  / whitespace-only inputs throw. */
    addLocation: method(z.object({ name: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /** Remove a label from the curated registry. Devices that still
     *  reference this label keep their `meta.location` value — the
     *  registry is purely a suggestion list. To purge from devices,
     *  iterate them and call `setLocation(deviceId, null)`
     *  separately (or pass `cascade: true` to do it in one shot).
     *
     *  The room's ICON goes with it, always — a key left behind survives in a
     *  map nobody lists, and a room later re-created under the same name would
     *  silently inherit an icon the operator never chose for it. */
    removeLocation: method(
      z.object({ name: z.string(), cascade: z.boolean().optional() }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Rename a room: replace the label in the registry IN PLACE and move
     *  every device that carried it, as ONE server operation.
     *
     *  The admin UI used to do this as `addLocation(to)` → N ×
     *  `setLocation(device, to)` → `removeLocation(from)` from the browser.
     *  Nothing bound those three together, so a closed tab left the fleet
     *  split across two rooms — one of which the operator believed was gone.
     *
     *  `from` is matched the way the registry matches everywhere else
     *  (trimmed, case-insensitive) and need NOT be registered: the registry is
     *  a suggestion list, and the devices that most need a rename are exactly
     *  the ones carrying a label nobody registered. `to` renames onto an
     *  existing room by MERGING into it, leaving no duplicate label. An empty
     *  `to` throws before anything is written.
     *
     *  The room's ICON travels with the rename, including when `from` was
     *  never registered — otherwise it orphans on a key no location carries
     *  any more. A merge keeps the TARGET's icon when it has one: renaming
     *  "Sala" into "Hall" moves devices into Hall, it does not restyle
     *  it. */
    renameLocation: method(
      z.object({ from: z.string(), to: z.string() }),
      z.object({ moved: z.number() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Every location that carries an ICON, as `(locationKey, icon)` pairs.
     *
     *  ADDITIVE, deliberately: `listLocations` keeps returning `string[]` —
     *  every consumer of it (the Device Info autocomplete, the HA adoption
     *  import, the recorder) reads a list of labels and none of them wants a
     *  shape change. A surface that wants icons asks for them and joins.
     *
     *  Only assignments that EXIST are returned — a location with no icon is
     *  absent, not `map-pin`. The fallback belongs to the renderer
     *  (`resolveIconKey(value, LOCATION_ICON_FALLBACK)`), not to the store, so "the operator chose the
     *  pin" and "the operator chose nothing" stay distinguishable.
     *
     *  The join key is `locationIconKey(label)` (trimmed, lower-cased) — the
     *  same equality the registry uses everywhere. Never the operator's
     *  casing: a case-only rename is a real edit here, and a map keyed on the
     *  displayed spelling would orphan its entry on exactly that edit. */
    listLocationIcons: method(z.void(), z.array(LocationIconAssignmentSchema), { role: 'viewer' }),

    /** Set (or clear) the icon of a location label. `icon: null` removes the
     *  assignment. The label need NOT be registered — the registry is a
     *  suggestion list and devices carry labels nobody registered — but an
     *  empty / whitespace-only label throws. Idempotent.
     *
     *  The icon is a key of the one icon catalog (`IconKeySchema`, D854): any
     *  icon both the admin UI and the viewer can draw. See
     *  `device/location-icon.ts` for what a surface that cannot draw a stored
     *  value must do (fall back to `map-pin`, never a hole). */
    setLocationIcon: method(
      z.object({ location: z.string(), icon: IconKeySchema.nullable() }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Every location that carries a DESCRIPTION — what the place LOOKS like,
     *  in plain words, given to the vision model alongside the pictures so it
     *  knows what it is looking at. A driveway of cobbles between a brick wall
     *  and three parking spaces reads very differently from a back garden.
     *
     *  Same additive shape and same join key as `listLocationIcons`, and that
     *  is the point of it being here at all: this lived in the post-analysis
     *  addon's own settings, keyed by a hand-typed label matched exactly and
     *  case-sensitively, while the icon hung off the location itself. A rename
     *  carried the icon and silently orphaned the description. One location,
     *  one authority, one key.
     *
     *  Absent means nobody wrote one — the digest then tells the model only the
     *  location NAME, exactly as it did before descriptions existed. */
    listLocationDescriptions: method(z.void(), z.array(LocationDescriptionAssignmentSchema)),

    /** Set (or clear) a location's description. `description: null`, or a
     *  blank string, removes it — an empty description and no description are
     *  the same thing to every reader, and storing the first would send an
     *  empty line to the model.
     *
     *  Like `setLocationIcon`, the label need NOT be registered, and an
     *  empty / whitespace-only LABEL throws. */
    setLocationDescription: method(
      z.object({
        location: z.string(),
        description: z.string().max(LOCATION_DESCRIPTION_MAX).nullable(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Every SITE ZONE — a named part of the property that groups locations
     *  ("Night zone" holds the bedrooms). One call answers the whole picture:
     *  key, the label as typed, the icon, and the locations inside.
     *
     *  Together, because a surface that asked for membership separately could
     *  draw a zone whose rooms it has not fetched — and the strip that renders
     *  these puts zones BEFORE locations, so a half-known zone is the first
     *  thing an operator sees.
     *
     *  Nothing here touches a device: a camera's zone is derived from its
     *  location, never stored on the row. Grouping rooms must not rewrite the
     *  fleet. */
    listSiteZones: method(z.void(), z.array(SiteZoneSchema), { role: 'viewer' }),

    /** Create a zone, or set the icon of one that exists. `icon: null` clears
     *  the icon and KEEPS the zone — a zone with no icon is a normal zone, and
     *  conflating "no icon" with "no zone" would delete membership on a
     *  mis-click.
     *
     *  Idempotent, and the label is stored as typed: the key is folded, so
     *  re-running this with different casing re-labels rather than duplicating. */
    setSiteZone: method(
      z.object({ name: z.string(), icon: IconKeySchema.nullable().optional() }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Delete a zone. Its LOCATIONS survive — they simply stop belonging to
     *  anything. Deleting a grouping must never delete what was grouped. */
    removeSiteZone: method(z.object({ name: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /** Rename a zone, carrying its icon AND its membership.
     *
     *  It exists so that renaming is not delete-then-recreate, which would drop
     *  both — the exact orphaning that lost a location's description when the
     *  two hung off different keys. Renaming onto an existing zone MERGES into
     *  it and the target keeps its own icon. */
    renameSiteZone: method(z.object({ from: z.string(), to: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /** Put a location in a zone, or take it out with `zone: null`.
     *
     *  At most one zone per location, by construction: this writes one key, so
     *  there is no state in which a room is in two places at once. The zone
     *  need not exist yet — it is created empty-labelled from this call, the
     *  same way `setLocationIcon` does not require a registered location. */
    setLocationZone: method(
      z.object({ location: z.string(), zone: z.string().nullable() }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Soft-disable / re-enable the device. Drivers consult
     *  `BaseDevice.disabled` to gate lifecycle hooks. */
    setDisabled: method(z.object({ deviceId: z.number(), disabled: z.boolean() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /** List persisted devices for an addon (DB, for restore). */
    listPersistedByAddon: method(z.object({ addonId: z.string() }), z.array(SavedDeviceRowSchema)),

    // ── Query — live registry ─────────────────────────────────────────────────

    /**
     * List all devices (live registry), optionally filtered by addonId.
     *
     * **Ask for `projection: 'slim'` unless you need `config`.** A full listing
     * of 293 devices measured 271 KB, of which `config` was 113 KB and
     * `metadata` 22 KB — half the payload — and the viewer's camera list, the
     * largest consumer, reads 1.8 KB of it. Worse, the persisted branch reads
     * each device's settings row one at a time, so `config` costs a
     * per-device round-trip as well as its bytes.
     */
    listAll: method(
      z.object({
        addonId: z.string().optional(),
        /**
         * `slim` omits `config` (returned `{}`), `metadata` (null) and the
         * `sourceInfo` derived from config — and skips the per-device settings
         * read that produces them. Everything identifying a device (id, name,
         * type, online, features, isCamera, parent/link ids) is unchanged.
         * Do not use it for dispatch routing, which needs `sourceInfo`.
         */
        projection: z.enum(['full', 'slim']).optional(),
        /** Return only camera devices. Filtering server-side instead of
         *  shipping 293 rows to find 12. */
        isCamera: z.boolean().optional(),
        /**
         * Return only these device ids. For the caller that already KNOWS the
         * handful it wants and needs a field the id-bearing answer does not
         * carry — the viewer's linked-devices panel joins `type` and `online`
         * onto ~8 linked ids and, unfiltered, dragged the fleet across to do
         * it: 433 KB slim / 958 KB full for 967 devices, on a query that
         * refetches on the reconcile interval, on a phone.
         *
         * Safe to send at a hub that predates it: Zod STRIPS unknown input
         * keys rather than rejecting them (verified against the live hub
         * 2026-08-25 — 967 rows came back), so an old hub answers exactly what
         * it answers today and the caller filters as it already does.
         */
        deviceIds: z.array(z.number()).optional(),
      }),
      z.array(DeviceInfoSchema),
      // Projected to the caller's devices (DEVICE_ENUMERATION_METHODS).
      { role: 'viewer' },
    ),

    /** Get a single device by numeric deviceId. */
    getDevice: method(z.object({ deviceId: z.number() }), DeviceInfoSchema.nullable()),

    /** List children of a parent device (by parent numeric id). */
    getChildren: method(z.object({ parentDeviceId: z.number() }), z.array(DeviceInfoSchema), {
      role: 'viewer',
    }),

    /**
     * `getChildren` for a NAMED SET of parents, in one call.
     *
     * The accessory reconcile in `device-cap-proxy.ts` asks this question once
     * per registered device — every `BaseDevice` inherits a
     * `getAccessoryChildren()` that returns `[]`, so even a leaf accessory
     * pays a round-trip to learn it has nothing to prune. Measured on the live
     * hub 2026-08-27 over a 120-second boot window, fleet of 1 017 devices:
     * `DeviceRowStore.list < DeviceRowStore.listByParent < getChildren` at
     * **1 024 calls** returning **919 rows in total** — 1 024 RPCs and 1 024
     * indexed scans to move less than one row each. `listByParentMany`
     * collapses the scans; this collapses the RPCs.
     *
     * Keyed by parent id as a STRING — a JSON object cannot key by number
     * (same reason as `getDeviceStatusAggregateBatch`). The per-parent value
     * is exactly what `getChildren` returns for that parent.
     *
     * A parent with no children — or one the fleet does not know — is ABSENT
     * from the record, never an invented empty row: the same contract as
     * `DeviceRowStore.getMany`/`listByParentMany`. An EMPTY `parentDeviceIds`
     * reads nothing at all rather than degrading to "every device".
     *
     * `parentDeviceIds` is capped at {@link DEVICE_CHILDREN_BATCH_MAX} — see
     * that constant for why. A caller with more parents than that sends more
     * than one call; it never sends one pathological one.
     *
     * Version skew: this is a NEW method, not a new field on `getChildren`, so
     * a hub that predates it answers NOT_FOUND rather than silently stripping
     * an unknown input key and answering a DIFFERENT question. The kernel-side
     * loader degrades to per-parent `getChildren` on that error — see
     * `children-batch-loader.ts`.
     */
    getChildrenBatch: method(
      z.object({ parentDeviceIds: z.array(z.number()).max(DEVICE_CHILDREN_BATCH_MAX) }),
      z.record(z.string(), z.array(DeviceInfoSchema)),
    ),

    // ── Linked devices (camera ↔ companion-device association) ───────────────

    /**
     * Resolve the devices LINKED to a camera — the single policy authority
     * both consumers call (viewer devices panel + pipeline-analytics event
     * kinds/ingest). Device-tree children are ALWAYS included, plus the
     * operator's persisted pick list (`mode` is always `manual` since D356:
     * same-location devices are suggested by the picker, never linked on
     * their own). Excludes the camera itself; deduped. The list is written by
     * the `linked-devices` extension slot over `_linkedDeviceIds` (see the
     * module docblock).
     */
    getLinkedDevices: method(
      z.object({ deviceId: z.number() }),
      z.object({ mode: LinkedDevicesModeSchema, devices: z.array(LinkedDeviceSchema) }),
      { role: 'viewer' },
    ),

    /**
     * `getLinkedDevices` for MANY cameras, in one call.
     *
     * Not a convenience wrapper — a cost fix. Resolving one camera's linked set
     * needs the whole fleet as candidates (children ∪ same-location), so the
     * single-device path runs a full `listAll` per call. Asked per camera that
     * is N full-fleet sweeps of device-manager's event loop, and they do not
     * overlap: measured on the live hub 2026-08-25, 30 concurrent
     * `getLinkedDevices` took 4110 ms wall (median 4060 ms each) to return
     * 7260 bytes in total. The batch takes ONE sweep and one settings read per
     * camera.
     *
     * A device id that resolves to nothing still gets a row (`devices: []`) —
     * a caller that asked for thirty and got twenty-eight cannot tell which two
     * are missing, or that any are.
     */
    getLinkedDevicesBatch: method(
      z.object({ deviceIds: z.array(z.number()) }),
      z.array(LinkedDevicesForDeviceSchema),
      { role: 'viewer' },
    ),

    // ── Runtime — live device operations ─────────────────────────────────────

    /** Get stream sources for a camera device. */
    getStreamSources: method(z.object({ deviceId: z.number() }), z.array(StreamSourceEntrySchema)),

    /** Get config entries (key + value + description) for a device. */
    getConfigSchema: method(z.object({ deviceId: z.number() }), z.array(ConfigEntrySchema)),

    /** Get the ConfigUISchema for a device's settings (for admin UI rendering). */
    getSettingsSchema: method(z.object({ deviceId: z.number() }), ConfigUISchemaOutput),

    // ── Mutations — config changes, enable/disable, remove ────────────────────

    /** Update device config values (partial merge). */
    updateConfig: method(
      z.object({
        deviceId: z.number(),
        values: z.record(z.string(), z.unknown()),
      }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Enable a device (writes enabled=true to device config). */
    enable: method(z.object({ deviceId: z.number() }), z.object({ success: z.literal(true) }), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /** Disable a device (writes enabled=false to device config). */
    disable: method(z.object({ deviceId: z.number() }), z.object({ success: z.literal(true) }), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /** Remove a device and all children: calls device.removeDevice() then removes from registry + DB. */
    remove: method(z.object({ deviceId: z.number() }), z.object({ success: z.literal(true) }), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /**
     * The tombstones of devices deleted at or after `sinceMs` (D865). The
     * reconcile feed of every `device-removal-hook` implementer: an addon that
     * was down when a device was deleted asks here at start and periodically.
     * A tombstone exists only for a DELETE — never for a device that is merely
     * unregistered, offline or whose provider is restarting. Tombstones older
     * than `DEVICE_TOMBSTONE_RETENTION_MS` are gone.
     */
    listDeletedSince: method(
      z.object({ sinceMs: z.number() }),
      z.array(DeviceTombstoneSchema).readonly(),
      { auth: 'admin' },
    ),

    /**
     * Admin-triggered clean-up of data that belongs to devices deleted BEFORE
     * tombstones existed (D865). Asks every `device-removal-hook` implementer
     * which device ids it holds data for, keeps those absent from the device
     * list — confirmed by TWO reads of the list, skipped if either fails — and
     * with `confirm: false` only reports the counts per store. `confirm: true`
     * deletes. Never runs on its own.
     */
    cleanupDeletedDevicesData: method(
      z.object({ confirm: z.boolean() }),
      CleanupDeletedDevicesResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Cascade-delete every top-level device whose `integrationId` matches.
     *  Children cascade automatically via the per-parent remove path.
     *  Idempotent: a device whose `integrationId` was never set never matches.
     *  Returns the count of top-level parents actually removed. */
    removeByIntegration: method(
      z.object({ integrationId: z.string() }),
      z.object({ removed: z.number() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    // ── Stream profile map ────────────────────────────────────────────────────

    /** Get quality→streamId mapping for a camera. Derived from profileHint if not explicitly set. */
    getStreamProfileMap: method(
      z.object({ deviceId: z.number() }),
      z.record(z.string(), z.string().nullable()),
    ),

    /** Persist quality→streamId mapping in device config under reserved key _profileMap. */
    setStreamProfileMap: method(
      z.object({
        deviceId: z.number(),
        profileMap: z.record(z.string(), z.string().nullable()),
      }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Run ffprobe on each stream source URL and return metadata. No-op if stream probe unavailable. */
    probeStreams: method(z.object({ deviceId: z.number() }), z.array(StreamProbeResultSchema), {
      kind: 'mutation',
      auth: 'admin',
    }),

    // ── Bindings — per-device capability provider map ────────────────────────

    /**
     * Return the per-capability binding map for a device. Each entry lists the
     * currently-active provider (native or wrapper) + the underlying native
     * addon id, so consumers can decide routing without re-running discovery.
     */
    getBindings: method(z.object({ deviceId: z.number() }), DeviceBindingsForDeviceSchema, {
      role: 'viewer',
    }),

    /**
     * `getBindings` for a NAMED set of devices, in one call.
     *
     * Between `getBindings` (one device) and `getAllBindings` (all 988) there
     * was nothing, so a caller that needs seventy-five either pays
     * seventy-five round-trips or drags the whole fleet across. Measured on
     * the live hub 2026-08-25: 75 concurrent `getBindings` = 1211 ms / 118 KB,
     * `getAllBindings({})` = 511 ms / 679 KB. Neither is the right answer to
     * "these seventy-five".
     *
     * Same resolver, same routing rules, same per-device shape as
     * `getBindings`; ids are deduped and a device with no bindings answers
     * `entries: []` rather than dropping out.
     */
    getBindingsBatch: method(
      z.object({ deviceIds: z.array(z.number()) }),
      z.array(DeviceBindingsForDeviceSchema),
    ),

    /**
     * Return the binding map for every device known to the hub. Used by
     * `SystemManager` warm-boot: a single round-trip resolves the
     * routing for the entire fleet so subsequent `sm.getDeviceById(id)`
     * calls are sync. Bindings change rarely (only on wrapper toggle or
     * device add/remove) — clients invalidate via the
     * `capability.binding-changed` event.
     *
     * "A single round-trip" describes the CLIENT's side and used not to
     * describe the server's: until 2026-08-30 the resolver read the persisted
     * wrapper activations once per device, so answering this cost one
     * settings-door RPC per device — 1 020 on the live 1 019-device hub, and
     * it did not return in 240 s against `SystemMirror.init`'s 15 s budget.
     * The server side is now two reads for the whole fleet. Anything PERIODIC
     * still belongs on `getBindings` / `getBindingsBatch` (D12); this remains
     * a warm seed.
     */
    getAllBindings: method(z.object({}), z.array(DeviceBindingsForDeviceSchema)),

    /**
     * The ids of every device bound to AT LEAST ONE of `capNames` — ids only,
     * ascending (D636).
     *
     * The targeted form of "which devices are openings / carry a battery":
     * before it, the alarm's household scan and the battery section's picker
     * read the whole fleet (~433 KB slim) and then `getBindingsBatch` over
     * ~900 ids in five calls. Same resolver as `getBindings` (so a WRAPPED
     * binding counts exactly as the routing does), walked server-side like
     * `getAllBindings`; only the matching ids cross the wire. Names are the
     * caller's to resolve with the targeted `listAll({ deviceIds })`.
     *
     * Tier: `protected`, like its siblings `getBindings` / `getBindingsBatch` /
     * `getAllBindings` — which devices carry a cap is routing metadata every
     * signed-in client already reads, and it reveals nothing those do not.
     */
    listDeviceIdsByCaps: method(
      z.object({ capNames: z.array(z.string().min(1)).min(1).max(16) }),
      z.array(z.number()),
      { role: 'viewer' },
    ),

    /**
     * Activate (or deactivate) a wrapper addon for a (device, cap) pair — the
     * per-camera function switch's ONE authority (D62).
     *
     * SINGLETON capabilities only. Persists the binding via ctx.settings;
     * `active: false` clears the wrapper (falling back to native if one is
     * registered) by persisting the explicit `{ wrapperAddonId: null }` marker,
     * which is what stops `getBindings` re-binding a `defaultActive` wrapper.
     *
     * **A COLLECTION capability is REFUSED by name.** It briefly took a
     * `sourceId` and wrote a per-device DENY set, so one of an addon's several
     * sources could be switched off without switching off the rest (D556, then
     * D555's re-key by source). The operator removed the whole idea the same
     * day: *"tutti i providers funzionano sempre, non serve
     * disattivarli/attivarli … loro vivono lì"* [all the providers always work, there is no need to deactivate/activate them … they live there] (D557 amended, third). A
     * collection cap's providers are a DERIVED set — every addon that provides
     * the cap for this device type, computed on every read and persisted
     * nowhere — so there is nothing here to activate, and a verb that accepted
     * the call could only write a field the enumeration does not read. That is
     * the D62 shape, and this repo has shipped it four times.
     */
    setWrapperActive: method(
      z.object({
        deviceId: z.number(),
        capName: z.string(),
        wrapperAddonId: z.string(),
        active: z.boolean(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * The STORED wrapper activation for one `(device, capName)` pair, three-way
     * (`value` / `missing` / `failed`, see {@link WrapperActivationReadSchema}).
     *
     * The narrow read of the durable authority behind `getBindings`: a
     * consumer that must know what the operator PERSISTED (before it drops
     * work on the strength of an unbind) asks this instead of pulling device-manager's
     * whole addon store through `addonSettingsRaw.getGlobal` — which answered
     * `{}` on every isolated-engine hub and so never worked (D675). It reads
     * ONE row (the activation map, ~1.6 KB), never the ~625 KB store.
     */
    getWrapperActivation: method(
      z.object({ deviceId: z.number(), capName: z.string().min(1) }),
      WrapperActivationReadSchema,
    ),

    /**
     * Return the addon ids that declared a wrapper provider for `capName`.
     * Backs the device-bindings UI's wrapper-picker dropdown. Entries are
     * sourced from `CapabilityRegistry.wrapperProviders`, populated when
     * the cap definition declares `kind: 'wrapper'`.
     */
    listWrappersForCap: method(z.object({ capName: z.string() }), z.array(z.string())),

    /**
     * Return every device-scoped capability name that applies to a
     * deviceType (scope:'device' + deviceTypes includes the given type),
     * paired with the wrappers that can provide it. Backs the device
     * bindings UI so it can show rows for bindable caps even when no
     * native is registered yet — the user can still activate a wrapper
     * to light the cap up (e.g. snapshot via ffmpeg fallback for a camera
     * without `snapshotUrl`).
     */
    listBindableCapsForDeviceType: method(
      z.object({ deviceType: z.string() }),
      z.array(
        z.object({
          capName: z.string(),
          wrappers: z.array(z.string()),
        }),
      ),
    ),

    // ── Device-details aggregators ───────────────────────────────────────────
    //
    // Single entry point the admin UI calls to render the device-details page.
    // The hub enumerates every provider of `device-settings-contributor` (a
    // `collection` cap) plus its own base section and returns a single
    // `ConfigUISchemaWithValues` with merged tabs/sections.
    //
    // Two endpoints, two cadences:
    //   - `getDeviceSettingsAggregate` — editable fields + static readonly.
    //     Cached on the UI side, invalidated on successful `updateDeviceField`.
    //   - `getDeviceLiveInfoAggregate`  — readonly, dynamic. UI polls at a
    //     short interval (~2-3 s). Fields carry `source: 'live'` so the
    //     renderer knows which query owns the value.
    //
    // Save flow goes through `updateDeviceField` — the aggregator routes the
    // write to `addon-settings.updateDeviceSettings` for the declared
    // `writerAddonId` (or to its own device config store when `writerAddonId`
    // equals the device-manager addon id).

    getDeviceSettingsAggregate: method(
      z.object({ deviceId: z.number() }),
      SettingsSchemaWithValuesSchema.nullable(),
    ),
    getDeviceLiveInfoAggregate: method(
      z.object({ deviceId: z.number() }),
      SettingsSchemaWithValuesSchema.nullable(),
      { role: 'viewer' },
    ),
    /**
     * Unified entry point — returns both settings + live in a single call
     * so the admin UI pulls the whole device-details panel with one round-
     * trip instead of firing two parallel queries. The `live` field is the
     * polled portion; the UI re-fetches the whole aggregate at the live
     * cadence and uses the `settings` slice verbatim until the user
     * writes through `updateDeviceFieldsBatch`.
     */
    getDeviceAggregate: method(
      z.object({ deviceId: z.number() }),
      z.object({
        settings: SettingsSchemaWithValuesSchema.nullable(),
        live: SettingsSchemaWithValuesSchema.nullable(),
      }),
    ),
    runDeviceAction: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        action: z.string().min(1),
        input: z.unknown(),
      }),
      z.unknown(),
      { kind: 'mutation' },
    ),
    updateDeviceField: method(
      z.object({
        deviceId: z.number(),
        writerCapName: z.string(),
        writerAddonId: z.string(),
        key: z.string(),
        value: z.unknown(),
      }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Batched counterpart of `updateDeviceField` — the admin UI groups
     * per-provider changes so a single round-trip triggers at most one
     * `applyDeviceSettingsPatch` per `(capName, addonId)` tuple. Per-patch
     * failures are reported in `failures[]` without aborting the others;
     * consumers inspect the list and surface targeted errors.
     */
    updateDeviceFieldsBatch: method(
      z.object({
        deviceId: z.number(),
        changes: z.array(
          z.object({
            writerCapName: z.string(),
            writerAddonId: z.string(),
            key: z.string(),
            value: z.unknown(),
          }),
        ),
      }),
      z.object({
        success: z.literal(true),
        failures: z.array(
          z.object({
            writerCapName: z.string(),
            writerAddonId: z.string(),
            error: z.string(),
          }),
        ),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    // ── Device-provider operations (routed via CapabilityRegistry) ────────────
    //
    // These methods proxy to the `device-provider` capability collection,
    // routing by addonId. Moving them here from the compat router
    // (`device-ops.router.ts`) allows addon ctx.api callers to reach them
    // through the standard Moleculer-registered cap surface.

    /** Trigger device discovery on a device-provider addon. */
    discoverDevices: method(z.object({ addonId: z.string() }), z.array(DiscoveryCandidateSchema), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /** Adopt a discovered device via the device-provider capability. */
    adoptDevice: method(
      z.object({
        addonId: z.string(),
        candidate: DiscoveryCandidateSchema,
        /** Owning integration id, stamped onto the new device's meta by the
         *  device-manager forwarder so `removeByIntegration` can cascade it.
         *  Optional for back-compat (omitted = no stamp = pre-existing behavior). */
        integrationId: z.string().optional(),
      }),
      DeviceSummarySchema,
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Get the creation form schema (ConfigUISchema) for a device type from a provider.
     * Returns null when the provider does not support manual creation.
     */
    getCreationSchema: method(
      z.object({
        addonId: z.string(),
        type: z.enum(DeviceType),
      }),
      z.unknown().nullable(),
    ),

    /** Create a new device via the device-provider capability. */
    createDevice: method(
      z.object({
        addonId: z.string(),
        type: z.enum(DeviceType),
        config: z.record(z.string(), z.unknown()),
        /** Owning integration id, stamped onto the new device's meta by the
         *  device-manager forwarder so `removeByIntegration` can cascade it.
         *  Optional for back-compat (omitted = no stamp = pre-existing behavior). */
        integrationId: z.string().optional(),
      }),
      DeviceSummarySchema,
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Test a single form field value during device creation (no device
     * exists yet). `formValues` carries the live snapshot of every
     * field in the form so probes that depend on multiple fields (e.g.
     * Reolink autodetect needs host + credentials + UID together) can
     * run without a separate round-trip per field. Optional for
     * backwards compatibility.
     */
    testCreationField: method(
      z.object({
        addonId: z.string(),
        type: z.enum(DeviceType),
        key: z.string(),
        value: z.unknown(),
        formValues: z.record(z.string(), z.unknown()).optional(),
      }),
      FieldProbeResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),

    // ── Device-adoption operations (routed via CapabilityRegistry) ────────────
    //
    // These methods proxy to the `device-adoption` capability for an
    // integration-style addon (Home Assistant, …), routing by addonId —
    // the same hub-side proxy pattern as `discoverDevices`/`adoptDevice`
    // above. The admin UI's generic adopt modal calls them through this
    // singleton so it never needs a direct handle on the addon's
    // `device-adoption` provider.

    // getCandidate is not proxied — the adopt modal expands rows from
    // listCandidates' nested `children`, so a single-candidate fetch is
    // never needed at this layer.

    /** List candidate filter chips for an integration via its device-adoption
     *  provider — addonId-routed via the collection pin. */
    adoptionListCandidateFilters: method(
      z.object({ addonId: z.string(), integrationId: z.string() }),
      z.object({ filters: z.array(AdoptionFilterSchema) }),
      { auth: 'admin' },
    ),

    /** List adoption candidates for an integration via its device-adoption provider. */
    adoptionListCandidates: method(
      AdoptionListCandidatesInputSchema.extend({ addonId: z.string() }),
      AdoptionListCandidatesOutputSchema,
      { auth: 'admin' },
    ),

    /** Trigger a discovery refresh on the integration's device-adoption provider. */
    adoptionRefresh: method(
      z.object({ addonId: z.string(), integrationId: z.string() }),
      AdoptionStatusSchema,
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Adopt one or more discovered candidates via the device-adoption provider. */
    adoptionAdopt: method(
      AdoptionAdoptInputSchema.extend({ addonId: z.string() }),
      AdoptionAdoptResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Release an adopted parent device via the device-adoption provider. */
    adoptionRelease: method(AdoptionReleaseInputSchema.extend({ addonId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),

    // ── Background adoption (the same adopt, without the 60s cliff) ───────────
    //
    // `adoptionAdopt` runs the whole array inside ONE UDS request, so the batch
    // shares one 60s deadline. Measured on the live hub: the kernel spends
    // ~450 ms per device it creates, and an accessory child costs what its
    // parent costs — so 25 candidates averaging 6 children, and equally a
    // SINGLE candidate with 217 children, both blow the deadline. The count
    // that overruns is the source system's fan-out, which the operator neither
    // chooses nor sees; that is why this is a job and not a smaller batch.
    //
    // `adoptionAdopt` is kept exactly as-is for the small case and for every
    // existing caller.

    /**
     * Start a background adoption and return its `jobId` immediately. The job
     * adopts ONE candidate per provider call, so no single request can exceed
     * the transport deadline, and it skips candidates that are already adopted
     * — which makes re-submitting a batch after a timeout safe and silent
     * rather than a wall of duplicate-stableId errors.
     */
    adoptionStartJob: method(
      AdoptionAdoptInputSchema.extend({ addonId: z.string() }),
      z.object({ jobId: z.string() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Adoption jobs for an integration, newest first. This is the answer to
     * "which of my 25 landed?" — `results` carries one entry per candidate,
     * every one of them in a named bucket.
     */
    adoptionListJobs: method(
      z.object({ addonId: z.string(), integrationId: z.string().optional() }),
      z.array(AdoptionJobSchema).readonly(),
      { auth: 'admin' },
    ),

    /** Cooperative cancel: the in-flight candidate finishes, the rest never start. */
    adoptionCancelJob: method(
      z.object({ jobId: z.string() }),
      z.object({ cancelled: z.boolean() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Re-sync a device with its source via the device-adoption provider of the
     * device's OWNING addon (resolved from `camDeviceId`). Unlike the singleton
     * `device-adoption.resync`, this routes to the correct integration so a
     * Dreame / Matter / … device never hits another integration's provider.
     */
    adoptionResync: method(AdoptionResyncInputSchema, AdoptionResyncResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),

    // ── Aggregated network discovery (scan the LAN across ALL providers) ───────
    // Thin coordinator over the EXISTING `device-provider.discoverDevices` surface
    // (the same one the wizard's per-provider DeviceDiscoveryStep + ONVIF use).
    // `discoverAllProviders` fans out across every provider that supportsDiscovery
    // so the admin-ui can show ONE combined "scan network → quick add" modal;
    // adoption of a picked candidate goes through the existing `adoptDevice`.

    /** Addons whose device-provider reports `supportsDiscovery` (for the modal). */
    discoveryProviders: method(
      z.object({}),
      z.object({
        providers: z.array(z.object({ addonId: z.string(), label: z.string() })).readonly(),
      }),
      { auth: 'admin' },
    ),

    /** Scan EVERY discovery-capable provider; returns candidates grouped by addon. */
    discoverAllProviders: method(
      z.object({}),
      z.object({
        groups: z
          .array(
            z.object({
              addonId: z.string(),
              label: z.string(),
              candidates: z.array(DiscoveryCandidateSchema).readonly(),
              error: z.string().nullable(),
            }),
          )
          .readonly(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Scan ONE provider with optional provider-specific params (subnet /
     *  broadcast addr) — the per-integration "Scan network" surface. */
    discoverProvider: method(
      z.object({ addonId: z.string(), params: z.record(z.string(), z.unknown()).optional() }),
      z.object({ candidates: z.array(DiscoveryCandidateSchema).readonly() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** The device type a provider creates via manual add (Camera/Container/Hub),
     *  so the Add-Device dialog uses the right type instead of assuming Camera. */
    providerCreationType: method(
      z.object({ addonId: z.string() }),
      z.object({ deviceType: z.enum(DeviceType).nullable() }),
      { auth: 'admin' },
    ),

    /** A provider's extra per-scan param form (ConfigUISchema) for the
     *  per-integration scan, or null when it takes none. */
    providerDiscoveryParamsSchema: method(z.object({ addonId: z.string() }), z.unknown(), {
      auth: 'admin',
    }),

    /**
     * Test a field value on an existing device (e.g. probe an RTSP URL).
     * Routes through the device-provider for the owning addon.
     */
    testField: method(
      z.object({
        deviceId: z.number(),
        key: z.string(),
        value: z.unknown(),
      }),
      FieldProbeResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Aggregate status snapshot across every cap registered for a
     * device. Returns a flat map `{ capName: status | null }` where
     * `status` is whatever `capDef.status.schema` validates to — or
     * `null` when no provider for that cap is registered on the
     * device, or the provider returned null, or the returned value
     * failed validation.
     *
     * `caps` is a positional tuple of cap names. The runtime only
     * returns entries for caps that are KNOWN to the system (validated
     * against `CAP_NAMES_WITH_STATUS` at call time); unknown names are
     * silently skipped. The client-side hook narrows the return type
     * using `CapStatusTypeMap` so the TS-inferred shape matches the
     * runtime shape.
     *
     * When `caps` is omitted, the server returns status for EVERY
     * registered cap on the device. Use this only for debug / overview
     * pages — it's O(N caps) per call.
     */
    getDeviceStatusAggregate: method(
      z.object({
        deviceId: z.number(),
        caps: z.array(z.string()).readonly().optional(),
      }),
      z.record(z.string(), z.unknown().nullable()),
    ),
    /**
     * The same aggregate, for a LIST of devices in one round-trip.
     *
     * The viewer's camera list is the caller this exists for. Each card asked
     * for its own badges — battery here, recording mode there — so a ten-camera
     * install issued N separate procedures per reconcile, each its own message
     * on the one WebSocket that also carries the WebRTC signalling (the client
     * has no `httpBatchLink`, so there is no transport-level batching to lean
     * on: collapsing has to happen at the procedure level, which is here).
     *
     * Keyed by device id as a STRING — a JSON object cannot key by number, and
     * pretending otherwise is how a record survives the wire only in tests.
     * The per-device value is exactly what `getDeviceStatusAggregate` returns,
     * so a caller can move between the two without reshaping anything.
     *
     * `caps` matters more here than in the single call: a client that needs two
     * caps should not pay for every status-carrying cap × every device.
     */
    getDeviceStatusAggregateBatch: method(
      z.object({
        deviceIds: z.array(z.number()).readonly(),
        caps: z.array(z.string()).readonly().optional(),
      }),
      z.record(z.string(), z.record(z.string(), z.unknown().nullable())),
      { role: 'viewer' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IDeviceManagerProvider = import('./capability-definition.js').InferProvider<
  typeof deviceManagerCapability
>
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>
/** Input shape for `device-manager.applyInitialMeta` — the batched meta
 *  pre-seed the kernel's `spawnAccessoryChild` flow uses to collapse the
 *  per-child meta setters into one round-trip. Inferred from the cap method's
 *  Zod schema so the kernel caller and the addon impl share one source. */
export type DeviceManagerApplyInitialMetaInput = z.infer<
  (typeof deviceManagerCapability)['methods']['applyInitialMeta']['input']
>
