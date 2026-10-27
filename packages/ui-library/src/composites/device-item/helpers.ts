/**
 * Shared types + helpers for the DeviceItem composite. Lives outside
 * the orchestrator file so every sub-component can import without
 * cycles.
 *
 *   - `DeviceItemDevice` / `DeviceItemParent` / `DeviceItemKind` —
 *     wire-shape mirrors of the `DeviceInfo` row.
 *   - `DeviceItemVariant` + `VariantDefaults` + `DEFAULTS` +
 *     `resolveFlags` — the variant→flags resolution pipeline.
 *   - `deviceLeadIcon` — icon resolution for the row's lead icon
 *     (delegated to the exhaustive `device-meta` maps).
 *   - `FEATURE_ICON_MAP` / `FEATURE_LABEL_MAP` — for the features
 *     popover (NEW in Phase 1).
 *   - Capability gates: `maySupportSwitch`, `isAccessoryChild`,
 *     `hasMotionTriggerFeature`.
 *   - `shortStableId` — display-token for stableId tail.
 */

import {
  type ChildLayout,
  type DeviceDisplayOverride,
  DeviceType,
  type RoleDisplayDefault,
  type SourceInfo,
  canonicalIconKey,
} from '@camstack/types'
import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  Battery,
  Crosshair,
  DoorOpen,
  Image as ImageIcon,
  LocateFixed,
  Mic,
  RotateCw,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'
import { resolveContainerPrimary } from '../device-controls/container-primary'
import { deviceRoleMetaOf, deviceTypeMetaOf } from '../device-meta'
import { defaultUiText, type UiTextFn } from '../../contexts/ui-text'
import { resolveDisplayIcon } from '../icon-glyphs'

// ── Public types ────────────────────────────────────────────────────

/**
 * Mirror of the canonical `DeviceInfo` wire shape (see
 * `packages/types/src/capabilities/device-manager.cap.ts`). Every
 * `deviceManager.listAll` / `getDevice` / `getChildren` row is
 * already this exact shape — call sites pass the raw row through
 * without remapping. Lives here as a structural type (not an
 * import) so this composite stays decoupled from `@camstack/types`.
 */
export interface DeviceItemDevice {
  readonly id: number
  readonly stableId: string
  readonly addonId: string
  readonly type: string
  readonly name: string
  readonly online: boolean
  /** Soft-disable flag — `true` dims the row + skips live fetches.
   *  Matches `DeviceInfo.disabled` so the wire row passes through. */
  readonly disabled: boolean
  readonly parentDeviceId: number | null
  /** The integration that CREATED this device — may differ from `addonId`,
   *  the addon that owns and SERVES it (e.g. a composed device is created
   *  under the "Blocks" integration but served by the `composer` addon).
   *  Mirrors `DeviceInfo.integrationId` so the wire row passes through. */
  readonly integrationId?: string | null
  /** Optional `DeviceRole` string. Present ⇒ this is an accessory. */
  readonly role?: string | null
  /** DeviceFeature strings — gates BatteryBadge etc. */
  readonly features?: readonly string[]
  /** True for ICameraDevice instances — gates snapshot popover. */
  readonly isCamera?: boolean
  /** Upstream-system identity (dispatch key + system tag + optional uniqueId).
   *  Flows from `DeviceInfo.sourceInfo` via structural cast / parse;
   *  optional so rows from providers that pre-date SourceInfo still work.
   *  Live rendering hints (unit, precision) come from the cap STATUS SLICE for
   *  generic numeric-sensor, or canonical constants in ROLE_DESCRIPTOR for typed
   *  roles; an operator's per-device customization rides `display` (below). */
  readonly sourceInfo?: SourceInfo
  /** Operator-authored per-device display override (icon/label/unit/precision/
   *  hidden). Mirrors `DeviceInfo.display` so the wire row passes through. The
   *  renderers resolve it via `resolveSensorDisplay` (unit/precision, render-time
   *  conversion) + `displayRoleLabel` / `deviceLeadIcon` (label/icon); `hidden`
   *  filters the row out of list surfaces. Absent ⇒ role/slice defaults. */
  readonly display?: DeviceDisplayOverride
  /** Soft-link to another device id. For a CONTAINER device this is the
   *  LEGACY picker-chosen primary child (numeric id); the row/hero resolve the
   *  primary child via `resolveContainerPrimary(children, linkDeviceId)`.
   *  Nullable: an explicit null means "no override → priority default".
   *  Mirrors `DeviceInfo.linkDeviceId` so the wire row passes through. */
  readonly linkDeviceId?: number | null
  /** Durable primary-child override for a CONTAINER device, keyed on the
   *  chosen child's re-sync/rename-stable `entityId`. Preferred over the
   *  numeric `linkDeviceId` in `resolveContainerPrimary` (survives a re-sync
   *  that reallocates the child's numeric id). Mirrors
   *  `DeviceInfo.primaryChildEntityId`. */
  readonly primaryChildEntityId?: string | null
  /** Container-level layout hint: assigns specific accessory children to named
   *  accordion sections (with optional intra-section order). Each entry's
   *  `childKey` is the child's re-sync-stable accessory `stableIdSuffix`; a child
   *  matches when `child.stableId === ${this.stableId}-${childKey}`. Mirrors
   *  `DeviceInfo.childLayout` so the wire row passes through. Absent ⇒ no layout
   *  declared (all children render in the plain list). Consumed by
   *  `groupChildrenByLayout` for the device-detail list + the table row
   *  expansion. */
  readonly childLayout?: ChildLayout
  /** Hardware + identity blob (manufacturer / model / firmware / sn / uid /
   *  mac / …). Driver-populated; keys are free-form and values arbitrary, so
   *  consumers MUST treat them defensively (string-coerce for display, skip
   *  non-string/empty). Mirrors `DeviceInfo.metadata` so the wire row passes
   *  through unchanged. Absent/null ⇒ no identity info advertised. */
  readonly metadata?: Readonly<Record<string, unknown>> | null
}

export interface DeviceItemParent {
  readonly id: number
  readonly name: string
  /**
   * Type of the parent device. Optional — when provided, callers can
   * distinguish "adopted under a hub/nvr" (renders with extra indent in
   * the table view) from a generic accessory parent.
   */
  readonly type?: string
}

export type DeviceItemKind = 'top-level' | 'adopted' | 'accessory'

export function deriveDeviceKind(
  device: Pick<DeviceItemDevice, 'parentDeviceId' | 'role'>,
): DeviceItemKind {
  if (device.parentDeviceId === null) return 'top-level'
  if (device.role) return 'accessory'
  return 'adopted'
}

export type DeviceItemVariant = 'minimal' | 'compact' | 'expanded'

export type DeviceItemView = 'card' | 'table'

export interface DeviceItemProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly device: DeviceItemDevice
  readonly variant?: DeviceItemVariant
  /**
   * Render mode. `'card'` (default) = flex row + optional accordion
   * below. `'table'` = `<tr>` with one `<td>` per logical column.
   * Phase 2's `<DeviceList>` wrapper drives this prop; Phase 1
   * scaffolds both branches with no current consumer using table.
   */
  readonly view?: DeviceItemView
  /**
   * When true, the row is rendered as an accessory of a parent (Phase 2
   * nested-only mode). Adds a subtle background tint + indent on the
   * first cell. Has no effect on `view='card'`. Caller provides `true`
   * only for the accessory passes inside <DeviceList>.
   */
  readonly isAccessoryRow?: boolean
  /**
   * Indent level for the `<td>` first cell in `view='table'`. Controls
   * `pl-N` on the name cell so adopted-under-hub rows can be visually
   * nested below their parent without forcing the accessory tint.
   *
   *   0 → `pl-2`  (top-level, no parent)
   *   1 → `pl-6`  (adopted under a hub/nvr — visual hierarchy hint)
   *   2 → `pl-8`  (accessory under any parent — strongest indent)
   *
   * When omitted, the orchestrator derives `2` from `isAccessoryRow` and
   * otherwise defaults to `0`. Caller may override (e.g. <DeviceList>
   * promoting "adopted-under-hub" rows from 0 → 1).
   */
  readonly indentLevel?: 0 | 1 | 2
  /**
   * Controlled expand state for the children-accordion chevron. When
   * BOTH `expanded` and `onToggleExpand` are passed, DeviceItem becomes
   * fully controlled; otherwise it falls back to internal state. Used
   * by `<TableRowGroup>` to lift expand state to the parent so the
   * accessory `<tr>` rows can render based on the same flag the chevron
   * flips.
   */
  readonly expanded?: boolean
  readonly onToggleExpand?: () => void
  readonly integrationIcon?: ReactNode
  readonly parent?: DeviceItemParent | null
  readonly showIntegrationIcon?: boolean
  readonly showParentBadge?: boolean
  readonly showSnapshot?: boolean
  readonly showBattery?: boolean
  readonly showStableId?: boolean
  readonly showId?: boolean
  readonly showSwitchToggle?: boolean
  readonly showChildrenAccordion?: boolean
  readonly children?: readonly DeviceItemDevice[]
  readonly onNavigate?: (deviceId: number) => void
  readonly className?: string
  /**
   * Optional trailing per-row control rendered alongside the built-in
   * `<DeviceItemActions>` (both card + table views). Lets a caller
   * inject a context-specific affordance — e.g. the device-export
   * panel's per-row Expose/Exposed toggle — without the composite
   * knowing anything about that domain. Omitted ⇒ no extra control,
   * so every existing call site renders unchanged.
   */
  readonly renderRowAction?: (device: DeviceItemDevice) => ReactNode
  /**
   * Built-in confirmed delete (TABLE feature). When provided, the merged
   * previewActions cell renders a red trash button that opens the shared
   * centered confirm dialog and calls `onDelete(device)` only on confirm.
   * Cap/feature-agnostic — delete is generic. Context gating is "consumer
   * passes the handler or not": omitted ⇒ no trash, zero layout change.
   * No effect on `view='card'` (card delete is a deliberate follow-up).
   */
  readonly onDelete?: (device: DeviceItemDevice) => void
  /**
   * When provided, renders a leading checkbox for row selection.
   * Only passed to top-level rows (accessory sub-rows omit it).
   * Omitted ⇒ no checkbox, zero layout change for existing callers.
   */
  readonly selection?: {
    readonly selected: boolean
    readonly onToggle: () => void
  }
  /**
   * When `true` (and `selection` is provided), a click anywhere on the
   * row's primary body toggles selection instead of navigating — the
   * batch-mode interaction (spec §6). The row also gains an accessible
   * pressed affordance (`role="button"` + `aria-pressed`). When omitted
   * or `false`, the row navigates on click as usual; the leading
   * checkbox remains the only selection surface. The checkbox always
   * toggles regardless of this flag (and never bubbles to navigate).
   */
  readonly rowClickSelects?: boolean
  /**
   * Table-view column gates (context-configured). Default `true` so every
   * existing call site renders all cells. When `false`, the corresponding
   * `<td>` is omitted entirely (the matching `<th>` is gated in the parent
   * `TableLayout`, so header + cells stay in lock-step). No effect on
   * `view='card'`.
   */
  readonly showTypeCell?: boolean
  /** Render the Hardware (manufacturer/model) `<td>` (context-gated). Default
   *  `true` so existing call sites render it; the parent `TableLayout` gates the
   *  matching `<th>` so header + cell stay in lock-step. No effect on `'card'`. */
  readonly showManufacturerCell?: boolean
  readonly showFeaturesCell?: boolean
}

// ── Variant defaults ────────────────────────────────────────────────

export interface VariantDefaults {
  readonly showIntegrationIcon: boolean
  readonly showParentBadge: boolean
  readonly showSnapshot: boolean
  readonly showBattery: boolean
  readonly showStableId: boolean
  readonly showId: boolean
  readonly showSwitchToggle: boolean
  readonly showChildrenAccordion: boolean
}

const DEFAULTS: Readonly<Record<DeviceItemVariant, VariantDefaults>> = {
  minimal: {
    showIntegrationIcon: false,
    showParentBadge: false,
    showSnapshot: false,
    showBattery: false,
    showStableId: false,
    showId: false,
    showSwitchToggle: true,
    showChildrenAccordion: false,
  },
  compact: {
    showIntegrationIcon: true,
    showParentBadge: true,
    showSnapshot: true,
    showBattery: true,
    showStableId: false,
    showId: false,
    showSwitchToggle: true,
    showChildrenAccordion: true,
  },
  expanded: {
    showIntegrationIcon: false,
    showParentBadge: true,
    showSnapshot: true,
    showBattery: true,
    showStableId: true,
    showId: true,
    showSwitchToggle: true,
    showChildrenAccordion: true,
  },
}

export function resolveFlags(props: DeviceItemProps): VariantDefaults {
  const d = DEFAULTS[props.variant ?? 'compact']
  return {
    showIntegrationIcon: props.showIntegrationIcon ?? d.showIntegrationIcon,
    showParentBadge: props.showParentBadge ?? d.showParentBadge,
    showSnapshot: props.showSnapshot ?? d.showSnapshot,
    showBattery: props.showBattery ?? d.showBattery,
    showStableId: props.showStableId ?? d.showStableId,
    showId: props.showId ?? d.showId,
    showSwitchToggle: props.showSwitchToggle ?? d.showSwitchToggle,
    showChildrenAccordion: props.showChildrenAccordion ?? d.showChildrenAccordion,
  }
}

// ── Icon resolution ─────────────────────────────────────────────────

/**
 * The row's lead icon — the ONE resolution order, the same one
 * `resolveSensorDisplay` applies to unit and precision:
 *
 *   device override → operator role default → built-in role glyph → type glyph
 *
 * `roleDefaults` is what the nearest `RoleDisplayDefaultsProvider` publishes;
 * callers outside a provider pass nothing and the second level is skipped.
 * Each level FALLS THROUGH when it names a glyph the registry cannot draw —
 * an unknown key at any level must never leave the row without an icon, and
 * must never shadow a lower level that would have drawn one.
 *
 * "Set as default for all X sensors" writes the second level. It was written
 * for a year and read by nothing: this function went straight from the device
 * override to `DEVICE_ROLE_META`.
 */
export function deviceLeadIcon(
  device: DeviceItemDevice,
  roleDefaults?: Readonly<Record<string, RoleDisplayDefault>>,
): LucideIcon {
  if (device.display?.icon) {
    const overridden = resolveDisplayIcon(device.display.icon)
    if (overridden) return overridden
  }
  if (device.role) {
    const roleDefaultKey = roleDefaults?.[device.role]?.icon
    if (roleDefaultKey !== undefined) {
      const fromRoleDefault = resolveDisplayIcon(roleDefaultKey)
      if (fromRoleDefault) return fromRoleDefault
    }
    return deviceRoleMetaOf(device.role).icon
  }
  return deviceTypeMetaOf(device.type).icon
}

/**
 * Role label for a device row, honouring an operator's per-device `display.label`
 * override (falls back to the `DEVICE_ROLE_META` label). NOT the device name —
 * this is the small secondary role caption on accessory/sensor rows.
 */
export function displayRoleLabel(device: DeviceItemDevice, t: UiTextFn = defaultUiText): string {
  if (device.display?.label) return device.display.label
  return device.role
    ? deviceRoleMetaOf(device.role, t).label
    : deviceTypeMetaOf(device.type, t).label
}

// ── Child list display-name (parent-prefix strip) ───────────────────

/**
 * Strip a redundant parent-name prefix from a child device's name. Providers
 * name container children fully-qualified so the entity reads cleanly on its
 * own detail page / exports / Alexa / the parent badge — Dreame joins with a
 * plain space (`"<Parent> <Label>"`), Ecowitt with an em-dash
 * (`"<Parent> — <Label>"`). Under the parent row that prefix is noise, so this
 * trims it for the in-list label ONLY; the underlying `device.name` is never
 * mutated.
 *
 * The `" — "` separator is tried BEFORE the plain space so an Ecowitt child
 * (`"Ecowitt Gateway — gateway"`) yields `"gateway"` rather than `"— gateway"`.
 * A missing parent name, or a name that doesn't carry the prefix, is returned
 * verbatim.
 */
const CHILD_NAME_SEPARATORS: readonly string[] = [' — ', ' ']

export function stripParentNamePrefix(name: string, parentName: string): string {
  if (parentName.length === 0) return name
  for (const sep of CHILD_NAME_SEPARATORS) {
    const prefix = `${parentName}${sep}`
    if (name.startsWith(prefix)) return name.slice(prefix.length)
  }
  return name
}

/**
 * Display name for a child device rendered UNDER its container/parent row.
 * Precedence: an operator's explicit per-device `display.label` wins over the
 * auto-strip (mirrors {@link displayRoleLabel}); otherwise the parent-name
 * prefix is stripped via {@link stripParentNamePrefix}. Shared by the
 * device-detail children list AND the devices list-table so both surfaces
 * render the bare child label identically.
 */
export function childListName(
  child: Pick<DeviceItemDevice, 'name' | 'display'>,
  parentName: string,
): string {
  if (child.display?.label) return child.display.label
  return stripParentNamePrefix(child.name, parentName)
}

// ── Feature icon + label maps (NEW in Phase 1) ──────────────────────

/**
 * Icon for each `DeviceFeature` advertised on a device row. Used by
 * the features popover (`<DeviceItemFeatures>`) to render compact
 * feature chips. Keys mirror `DeviceFeature` enum string values from
 * `@camstack/types/device/device-type.ts`.
 */
export const FEATURE_ICON_MAP: Readonly<Record<string, LucideIcon>> = {
  'native-snapshot': ImageIcon,
  'two-way-audio': Mic,
  'pan-tilt-zoom': Crosshair,
  'ptz-autotrack': LocateFixed,
  'doorbell-button': DoorOpen,
  'motion-trigger': Activity,
  'battery-operated': Battery,
  rebootable: RotateCw,
}

export const FEATURE_LABEL_MAP: Readonly<Record<string, string>> = {
  'native-snapshot': 'Native snapshot',
  'two-way-audio': 'Two-way audio',
  'pan-tilt-zoom': 'Pan-Tilt-Zoom',
  'ptz-autotrack': 'PTZ autotrack',
  'doorbell-button': 'Doorbell button',
  'motion-trigger': 'Motion trigger',
  'battery-operated': 'Battery operated',
  rebootable: 'Rebootable',
}

/**
 * Maps a wire-level `DeviceFeature` string to the cap name registered
 * in `deviceManager.getBindings` entries. A feature with NO entry here
 * is a pure informational marker (no cap to interrogate) — render but
 * without a native/enhanced label.
 *
 * Source of truth: live `getBindings` capNames observed against a
 * Reolink camera (snapshot, reboot, ptz, ptz-autotrack, intercom,
 * motion-trigger). Cap-name strings cross-checked against the
 * `name:` fields in `packages/types/src/capabilities/*.cap.ts`. When
 * a new feature ↔ cap pairing goes live, add the row here so the
 * popover picks it up.
 *
 * Pure markers (no cap to bind, intentionally absent):
 *   - `battery-operated` — exposed as a plain `device.features` flag;
 *     the runtime-state slice lives under the `battery` cap which has
 *     its own dedicated reactive surface (`useDeviceBattery`).
 *   - `doorbell-button` — UI marker only; the actual press events
 *     flow through the `doorbell` cap which is already exercised by
 *     `useDoorbellEvents`. Distinct from the marker.
 */
export const FEATURE_TO_CAP_NAME: Readonly<Record<string, string>> = {
  'native-snapshot': 'snapshot',
  rebootable: 'reboot',
  'pan-tilt-zoom': 'ptz',
  'ptz-autotrack': 'ptz-autotrack',
  'two-way-audio': 'intercom',
  'motion-trigger': 'motion-trigger',
}

// ── Capability gates ────────────────────────────────────────────────

const FIRST_CLASS_TYPES: ReadonlySet<string> = new Set(['camera', 'hub', 'nvr'])

export function maySupportSwitch(device: DeviceItemDevice): boolean {
  return !FIRST_CLASS_TYPES.has(device.type.toLowerCase())
}

export function isAccessoryChild(device: DeviceItemDevice): boolean {
  if (device.role) return true
  return !FIRST_CLASS_TYPES.has(device.type.toLowerCase())
}

export function hasMotionTriggerFeature(device: DeviceItemDevice): boolean {
  return (device.features ?? []).includes('motion-trigger')
}

// ── Container reachability ──────────────────────────────────────────

/**
 * Effective online state for a device row's status dot.
 *
 * A CONTAINER device renders AS its PRIMARY child (same row control via
 * `ContainerPrimaryInline`, same hero via `ContainerPrimaryHero`). Its
 * reachability dot should therefore follow that primary child's `online`,
 * NOT "any child online" — so the dot and the control gate agree (the
 * control is bound to the same primary child via `resolveContainerPrimary`).
 *
 * Resolution reuses the SAME `resolveContainerPrimary(children, linkDeviceId)`
 * helper the row control uses, then reads the resolved child row's `online`.
 * Degrades gracefully: a non-container, a container with no children, or a
 * container with no resolvable primary child falls back to `device.online`
 * (never crashes, never forces offline).
 */
export function effectiveOnline(
  device: DeviceItemDevice,
  containerChildren: readonly DeviceItemDevice[] | undefined,
): boolean {
  if (device.type !== DeviceType.Container) return device.online
  const children = containerChildren ?? []
  if (children.length === 0) return device.online
  const primary = resolveContainerPrimary(
    children,
    device.linkDeviceId,
    device.primaryChildEntityId,
  )
  if (primary === null) return device.online
  const primaryChild = children.find((c) => c.id === primary.id)
  return primaryChild === undefined ? device.online : primaryChild.online
}

/**
 * The type a CONTAINER should DISPLAY as (and be FILTERED by): its primary
 * child's type, since a container renders as that child (a vacuum container
 * should read + filter as `vacuum`, not the structural `container`). Mirrors
 * {@link effectiveOnline} — same primary-child resolution. Non-containers, and
 * containers with no resolvable primary child, fall back to `device.type`.
 */
export function effectiveType(
  device: DeviceItemDevice,
  containerChildren: readonly DeviceItemDevice[] | undefined,
): string {
  if (device.type !== DeviceType.Container) return device.type
  const children = containerChildren ?? []
  if (children.length === 0) return device.type
  const primary = resolveContainerPrimary(
    children,
    device.linkDeviceId,
    device.primaryChildEntityId,
  )
  if (primary === null) return device.type
  const primaryChild = children.find((c) => c.id === primary.id)
  return primaryChild === undefined ? device.type : primaryChild.type
}

/**
 * The device whose lead ICON a row should display: a Container shows its
 * primary CHILD's icon (the child's type + role drive the glyph, e.g. a vacuum
 * rather than the generic container box). Mirrors {@link effectiveType}, but
 * returns the resolved device so {@link deviceLeadIcon} also picks up the
 * child's role. Falls back to the device itself for non-containers / no primary.
 */
export function effectiveIconDevice(
  device: DeviceItemDevice,
  containerChildren: readonly DeviceItemDevice[] | undefined,
): DeviceItemDevice {
  if (device.type !== DeviceType.Container) return device
  // The operator's override on the CONTAINER itself outranks the primary-child
  // rule. Without this line the admin UI's icon picker wrote a value this
  // function never looked at — the child replaced the device BEFORE
  // `deviceLeadIcon` got to read `display.icon` — and the one device an
  // operator most wants to re-glyph (a container whose primary child chose
  // the wrong face, see D356's shutters) was the one device that ignored it.
  if (device.display?.icon !== undefined && canonicalIconKey(device.display.icon) !== undefined) {
    return device
  }
  const children = containerChildren ?? []
  if (children.length === 0) return device
  const primary = resolveContainerPrimary(
    children,
    device.linkDeviceId,
    device.primaryChildEntityId,
  )
  if (primary === null) return device
  const primaryChild = children.find((c) => c.id === primary.id)
  return primaryChild ?? device
}

// ── stableId display helper ─────────────────────────────────────────

export function shortStableId(stableId: string): string {
  if (stableId.length <= 24) return stableId
  // Prefer the last segment after the LAST separator (':' wins over
  // '-' to keep stableIds like `provider-reolink-…:cam-9527…` visible
  // as `cam-9527…` rather than just `9527…`). Fall back to the last
  // 18 chars when no separator yields a useful tail.
  const colonAt = stableId.lastIndexOf(':')
  if (colonAt >= 0 && colonAt < stableId.length - 4) {
    return stableId.slice(colonAt + 1)
  }
  // For dash-segmented ids, take the last 2 segments to keep some
  // structure visible (`reolink-1777874716804-cam-9527…` → `cam-9527…`).
  const parts = stableId.split('-')
  if (parts.length > 2) {
    const tail = parts.slice(-2).join('-')
    if (tail.length >= 6) return tail
  }
  // Last resort — raw character clamp.
  return `…${stableId.slice(-18)}`
}
