/**
 * Shared persistence + contribution wire types for the device-manager addon.
 *
 * Extracted verbatim from `device-manager.addon.ts` so the focused modules
 * (`device-projection`, `device-aggregation-merge`, the bindings store, …)
 * can import the same shapes without depending on the addon class. Types plus
 * the decoders that turn an untyped store read into one of them — nothing that
 * touches a store, a device or an event.
 */
import type {
  ChildLayout,
  DeviceDisplayOverride,
  IconKey,
  RoleDisplayDefault,
} from '@camstack/types'
import { canonicalIconKey, LOCATION_DESCRIPTION_MAX } from '@camstack/types'

/**
 * Wire shape matching `z.infer<typeof SettingsSchemaWithValuesSchema>` —
 * duplicated as a plain interface because importing the Zod schema across
 * package boundaries confuses `tsc` when the types package pins a
 * different `zod` minor than the core package. Keeping the shape local
 * keeps the addon decoupled from the schema's internal type encoding.
 */
export interface ContributionShape {
  tabs?: Array<{ id: string; label: string; icon: string; order?: number }>
  sections: Array<{
    id: string
    title: string
    /** `"<namespace>:<key>"` of the translated `title` (D863). */
    titleKey?: string
    description?: string
    /** `"<namespace>:<key>"` of the translated `description` (D863). */
    descriptionKey?: string
    style?: 'card' | 'accordion'
    defaultCollapsed?: boolean
    columns?: 1 | 2 | 3 | 4
    tab?: string
    /** Where the section renders. Default 'settings' (Config tab); 'top-tab' hoists into the device-detail tab bar via DeviceDetail discovery; 'hero' shows it once directly under the device's hero card (D915). */
    location?: 'settings' | 'top-tab' | 'hero'
    order?: number
    fields: unknown[]
  }>
}

export type AggregateTabDecl = NonNullable<ContributionShape['tabs']>[number]
export type AggregateSection = ContributionShape['sections'][number]

/**
 * Discriminated result from `resolveDriverConfigSchema`:
 *   'ok'          – schema obtained; `schema` field is present.
 *   'none'        – driver has no settings schema (legitimate empty).
 *   'unavailable' – cross-process call failed after retries (transient).
 */
export type DriverConfigSchemaResult =
  | { status: 'ok'; schema: ContributionShape }
  | { status: 'none' }
  | { status: 'unavailable' }

// ── Bindings store types ─────────────────────────────────────────────────────

/**
 * One `(device, capability)` row of the persisted wrapper-activation store —
 * the authority for every per-camera function switch (D62).
 *
 * SINGLETON capabilities only. `wrapperAddonId` is the bound wrapper, or the
 * explicit `null` "operator disabled" marker that stops `getBindings` step 2
 * re-binding a `defaultActive` wrapper; absent means the operator never touched
 * this cap on this device.
 *
 * **A COLLECTION capability has no row here, by design.** Its providers are a
 * SET, and the set is DERIVED from who provides the cap
 * (`device-bindings-store.ts` step 0) — *"tutti i providers funzionano sempre,
 * non serve disattivarli/attivarli … loro vivono lì"* [all the providers always work, there is no need to deactivate/activate them … they live there] (operator, 2026-09-20).
 * Nothing persists it, so nothing has to be back-filled onto a fleet and
 * nothing goes stale when an addon is deployed to a camera later.
 * `setWrapperActive` REFUSES a collection cap rather than writing a field the
 * enumeration does not read — `disabledSourceIds` / `disabledSourceAddonIds`
 * (D556, D555) were exactly that, and
 * `scripts/check-device-selection-authority.ts` now makes it unrepresentable.
 */
export interface DeviceCapBinding {
  readonly wrapperAddonId?: string | null
}

export interface DeviceBindingsStore {
  readonly deviceBindings: Record<
    string /* deviceId */,
    Record<string /* capName */, DeviceCapBinding>
  >
}

export interface PersistedDeviceMeta {
  type: string
  name: string
  /** The owning addon's own identifier for this device (`stableId`) and the
   *  owning addon id (`addonId`). Both are now stored as FIELDS on the record
   *  because the `deviceMeta` map is keyed by the numeric device `id` (not the
   *  former composite `${addonId}:${stableId}` key). They make each row
   *  self-describing — meta lookups resolve `(addonId, stableId)` directly from
   *  the record instead of parsing a composite key. */
  addonId: string
  stableId: string
  /** True once an operator explicitly renamed the device via `setName` (#17).
   *  Drives the `registerDevice` reconcile name-precedence: when set, the
   *  operator's name is PRESERVED; when unset, the fresh provider/construction
   *  name wins so an improved auto-name propagates instead of freezing. Absent on
   *  legacy rows — the reconcile treats a non-placeholder name as user-named for
   *  safety and stamps the resolved decision forward. */
  userNamed?: boolean
  /**
   * Operator-organisational label (room / area / zone). `null` when
   * unset. Mutable through `setLocation` action; surfaced on
   * `IDevice.location` via the kernel-built `DeviceContext.deviceMeta`
   * snapshot. Free-text — providers don't interpret it.
   */
  location: string | null
  /**
   * Soft-disabled flag. When `true`, the device class is still
   * instantiated and visible in the UI (so the operator can flip
   * back on without re-adding) but lifecycle hooks are gated by
   * `BaseDevice.disabled`. Mutable through `setDisabled` action.
   */
  disabled: boolean
  /** Numeric parent id (or null for standalone). The hub resolves the
   *  parent's stableId to its numeric id at registration time, and from
   *  there everything internal references the parent by `parentDeviceId`
   *  — `stableId` only crosses the external boundary (autodiscovery and
   *  `(addonId, stableId)` row lookups). */
  parentDeviceId: number | null
  /** Progressive, system-wide unique id. Allocated through
   *  `allocateDeviceId` before `registerDevice` runs; backfilled at boot
   *  for any legacy meta entry missing it (see init migration below).
   *  Post-init invariant: every persisted device has a numeric id. */
  id: number
  /** Snapshot of `device.features` from the most recent `registerDevice`
   *  call. Used by `getDevice` when the live `IDevice` instance lives
   *  on a forked-worker / remote agent and isn't reachable from the
   *  hub registry. Optional for legacy rows that predate the field —
   *  callers fall back to an empty array. */
  features?: readonly string[]
  /** Stable hash of the device's EXPORT-relevant shape
   *  (`canonicalDeviceFingerprint({ deviceType, features })`). Recomputed on
   *  every `registerDevice`; when it changes, a `DeviceProvisioned` event is
   *  emitted so export adapters reconcile with ONE delta instead of reacting
   *  to the chatty per-cap `DeviceBindingsChanged`. Optional for legacy rows
   *  that predate the field. Spec:
   *  docs/superpowers/specs/2026-06-01-alexa-hap-export-reconciler-design.md */
  exportFingerprint?: string
  /** Owning integration id, stamped at create via `setIntegrationId`. Optional:
   *  only present when the device was adopted through an integration (e.g. HA).
   *  Used by `removeByIntegration` to cascade-delete an integration's fleet. */
  integrationId?: string
  /** Linked device id, stamped at create via `setLinkDeviceId`. Optional:
   *  only present when the device is linked to another device (e.g. HA entity
   *  linked to a parent camera). `null` explicitly clears a previous link. */
  linkDeviceId?: number | null
  /** Durable primary-child override for a CONTAINER device, set via
   *  `setPrimaryChildEntityId`. Keyed on the chosen child's
   *  re-sync/rename-stable `entityId` (its `sourceInfo.id`, falling back to
   *  `stableId`) so it survives a re-sync that reallocates the child's numeric
   *  id — unlike the numeric `linkDeviceId`. `null` clears the override. */
  primaryChildEntityId?: string | null
  /** Container-level layout hint: assigns specific child/accessory devices to
   *  named accordion sections (with optional order). Keyed on each child's
   *  re-sync-stable accessory `stableIdSuffix`. Set at create, preserved across
   *  re-register/restore — same lifecycle as `primaryChildEntityId`. */
  childLayout?: ChildLayout
  /** Semantic role string (`DeviceRole`), stamped at create via `setRole`.
   *  Optional: only present for accessory children that carry a known role
   *  (e.g. 'numeric-sensor', 'binary-sensor'). `null` clears a previous role. */
  role?: string | null
  /** Operator-authored per-device display override (icon/label/unit/precision/
   *  hidden), set via `setDisplay`. Same create/persist/project/restore
   *  lifecycle as `childLayout`. Absent ⇒ no override. Applied at render time
   *  only — storage stays in source units. */
  display?: DeviceDisplayOverride
}

/**
 * The device-manager's own `addon-settings` row set — everything that is NOT a
 * device.
 *
 * The three fleet blobs that used to live here (`deviceMeta`, `deviceMetadata`,
 * `deviceIndex`) are gone: devices are rows in `device-manager:devices`
 * (`device-row-store.ts`). What is left is four small keys, together under a
 * kilobyte on the reference hub — which matters because `writeAddonStore` for a
 * hub builtin is `setAllAddon`, a DELETE + re-INSERT of every key the addon owns.
 */
export interface AddonStore {
  /** Monotonic counter that feeds `PersistedDeviceMeta.id` for every
   *  new device. Incremented exactly once per registerDevice; never
   *  decremented. */
  nextDeviceId?: number
  /**
   * Operator-curated location registry. Each entry is a free-form room/
   * area label (e.g. "Kitchen", "Garage") that drives the
   * autocomplete in the Device Info location editor. Devices reference
   * these as plain strings via `PersistedDeviceMeta.location` — the
   * registry is purely a suggestion list, NOT a foreign key. Removing a
   * location from the registry leaves devices that still reference it
   * intact; `listLocations` returns the union of registered labels +
   * labels currently in use, so nothing disappears from the UI even if
   * the operator forgot to register a label before assigning it.
   */
  locations?: readonly string[]
  /**
   * Icon per location, keyed by `locationIconKey(label)` — trimmed and
   * lower-cased, the same equality the registry itself matches on. Lives HERE,
   * beside `locations`, because that is where a location exists at all: a
   * location is a label, not a row, so there is no record to hang an icon on.
   *
   * Keyed on the folded label rather than the operator's casing on purpose. A
   * case-only rename (`kitchen` → `Kitchen`) is a real edit this repo supports,
   * and a map keyed on the displayed spelling would silently orphan its entry
   * on exactly that edit — the icon would vanish and nothing would say why.
   *
   * A value outside the icon catalog (`canonicalIconKey`) is DROPPED on decode, not trusted: the
   * store is JSON on disk and a renderer handed an unknown id can only draw a
   * hole. Dropping it degrades the location to the fallback pin instead.
   */
  locationIcons?: Readonly<Record<string, IconKey>>
  /**
   * What each location LOOKS like, in the operator's own words, keyed the same
   * way as {@link AddonStore.locationIcons}.
   *
   * Beside the icon and not in the consumer that reads it (the summary AI)
   * because it is a fact about the PLACE, not about the digest. It lived in
   * the post-analysis addon's settings, keyed by a hand-typed label matched
   * exactly and case-sensitively, and the cost was invisible: a rename in the
   * Locations page carried the icon and left the description on a key no
   * location would ever carry again.
   *
   * A value that is not a non-empty string is DROPPED on decode — an empty
   * description costs the model attention and says nothing, so it must never
   * reach it.
   */
  locationDescriptions?: Readonly<Record<string, string>>
  /**
   * SITE ZONES — named parts of the property that group locations, keyed by
   * `siteZoneKey(label)`. The label is stored as the operator typed it; the
   * key is what everything else joins on.
   *
   * Split from {@link AddonStore.locationZones} on purpose: a zone EXISTS
   * independently of anything being in it. Folding the two into one map would
   * make an empty zone unrepresentable, so creating one and then filling it —
   * the obvious order — would be impossible, and clearing the last room would
   * silently delete the zone and its icon.
   */
  siteZones?: Readonly<Record<string, SiteZoneRecord>>
  /**
   * Which zone each location belongs to: `locationKey → zoneKey`.
   *
   * This direction, not `zone → locations`, because it makes "at most one zone
   * per location" true BY CONSTRUCTION rather than by a check somebody has to
   * remember — there is one slot, so a second assignment moves the room
   * instead of duplicating it.
   *
   * Keyed on the folded location label, like the icon and the description, and
   * carried by `renameLocation` / dropped by `removeLocation` for the same
   * reason they are: this repo has already lost an icon to a rename once.
   */
  locationZones?: Readonly<Record<string, string>>
  /** Operator-authored per-role display defaults (unit/precision/icon), keyed
   *  by `DeviceRole` string. Resolution merges these UNDER any per-device
   *  `display` override. Written whole-record by `setRoleDisplayDefaults`
   *  (full replace — no read-modify-write, single writer, so it never
   *  interacts with the device write lock). */
  roleDisplayDefaults?: Record<string, RoleDisplayDefault>
}

/**
 * Decode the raw `ctx.settings.readAddonStore()` record into {@link AddonStore}.
 *
 * A field of the wrong shape reads as ABSENT rather than being trusted through
 * a cast: the store is JSON on disk and a hand-edit or a partial restore must
 * cost the caller its default, never a downstream `TypeError`.
 */
export function decodeAddonStore(raw: Record<string, unknown>): AddonStore {
  const nextDeviceId = raw['nextDeviceId']
  const locations = raw['locations']
  const roleDisplayDefaults = raw['roleDisplayDefaults']
  const locationIcons = decodeLocationIcons(raw['locationIcons'])
  const locationDescriptions = decodeLocationDescriptions(raw['locationDescriptions'])
  const siteZones = decodeSiteZones(raw['siteZones'])
  const locationZones = decodeStringMap(raw['locationZones'])
  return {
    ...(typeof nextDeviceId === 'number' && Number.isFinite(nextDeviceId) ? { nextDeviceId } : {}),
    ...(Array.isArray(locations)
      ? { locations: locations.filter((l): l is string => typeof l === 'string') }
      : {}),
    ...(isRoleDisplayDefaults(roleDisplayDefaults) ? { roleDisplayDefaults } : {}),
    ...(locationIcons !== null ? { locationIcons } : {}),
    ...(locationDescriptions !== null ? { locationDescriptions } : {}),
    ...(siteZones !== null ? { siteZones } : {}),
    ...(locationZones !== null ? { locationZones } : {}),
  }
}

/**
 * Decode the `locationIcons` map, dropping every entry whose value is not a
 * member of the closed vocabulary.
 *
 * Dropping, not passing through: the icon's whole point is that both surfaces
 * can draw it, and an id from a hand-edit or a newer hub is exactly the value
 * that draws nothing. Absent reads as "no icon chosen", which every renderer
 * already degrades to the fallback pin. Returns `null` when the key itself is
 * absent or of the wrong shape, so the field stays OMITTED rather than being
 * written back as an empty object.
 */
function decodeLocationIcons(raw: unknown): Record<string, IconKey> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, IconKey> = {}
  for (const [key, value] of Object.entries(raw)) {
    const icon = canonicalIconKey(value)
    if (icon === undefined) continue
    out[key] = icon
  }
  return out
}

/**
 * Decode the `locationDescriptions` map, dropping every entry that is not a
 * non-blank string.
 *
 * Same posture as the icons: a blank description and a missing one are the
 * same instruction to every reader, and storing the first would send an empty
 * line to a vision model. Over-long text is TRUNCATED rather than dropped —
 * losing the whole description because a hand-edit ran long is a worse answer
 * than losing its tail.
 */
function decodeLocationDescriptions(raw: unknown): Record<string, string> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (text.length === 0) continue
    out[key] = text.slice(0, LOCATION_DESCRIPTION_MAX)
  }
  return out
}

/**
 * One zone on disk. The icon is OPTIONAL and absent means "nobody chose one" —
 * never the fallback pin, which is the renderer's business.
 */
export interface SiteZoneRecord {
  readonly label: string
  readonly icon?: IconKey
}

/**
 * Decode the zone registry, dropping any entry without a usable label.
 *
 * A zone whose label did not survive a hand-edit cannot be shown or renamed —
 * it would be a row the operator can see the effects of and never name. An
 * icon outside the vocabulary is dropped on its own, leaving the zone: losing
 * a glyph is a smaller loss than losing the grouping.
 */
function decodeSiteZones(raw: unknown): Record<string, SiteZoneRecord> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, SiteZoneRecord> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const rec = value as Record<string, unknown>
    const label = typeof rec['label'] === 'string' ? rec['label'].trim() : ''
    if (label.length === 0) continue
    const icon = canonicalIconKey(rec['icon'])
    out[key] = icon === undefined ? { label } : { label, icon }
  }
  return out
}

/** Decode a plain `string → string` map, dropping anything else. */
function decodeStringMap(raw: unknown): Record<string, string> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || value.trim().length === 0) continue
    out[key] = value
  }
  return out
}

function isRoleDisplayDefaults(value: unknown): value is Record<string, RoleDisplayDefault> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
