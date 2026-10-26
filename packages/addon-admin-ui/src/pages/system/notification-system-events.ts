/**
 * The SYSTEM-EVENT vocabulary and value logic for notification rules.
 *
 * A `system-event` rule answers a different question from every other trigger:
 * not "what did a camera see" but "what happened to the installation" — a
 * camera dropping off, a node going away, an update landing. The rules ENGINE
 * has shipped that trigger (kinds + optional device/node/package filters);
 * this file is the operator-facing half of it, kept pure so the labels, the
 * filter visibility and the list summaries are unit-testable without a DOM.
 *
 * ONE FAMILY PER RULE (D637). A rule authors device events, system, or alarm —
 * `systemEventKindGroupsFor`, `systemEventFilterVisibilityFor`, and a toggle
 * that never removes the last kind nor adds another family's. The per-kind
 * `systemEventFilterVisibility` stays: the scope guard compares it to the engine.
 *
 * VOCABULARY IS SHARED, DELIBERATELY. The kinds, their labels and the
 * filter-visibility rule are the same on the admin UI and in the viewer
 * (`camstack/src/components/notifications/rule-editor.ts` +
 * `locales/{en,it}.json` → `v2.nc.rules.editor.systemKinds`). Two surfaces that
 * name the same event differently is how an operator concludes they are two
 * different features. The kind list itself is guarded against
 * `NcSystemEventKindSchema` in the spec, so a ninth kind added server-side
 * fails a test here instead of silently rendering seven of eight.
 */

import type {
  NcSystemEventCondition,
  NcSystemEventFamily,
  NcSystemEventKind,
} from '@camstack/types'
import {
  DeviceType,
  NC_AUTHORABLE_SYSTEM_EVENT_KINDS,
  NC_LEGACY_SYSTEM_EVENT_KINDS,
  NC_BATTERY_CONSUMABLE_SYSTEM_EVENT_KINDS,
  NC_CONSUMABLE_LOW_PERCENT_MAX,
  NC_SYSTEM_EVENT_FAMILY_FILTERS,
  NC_SYSTEM_EVENT_KIND_GROUP_SPECS,
  ruleSeedForSection,
  systemEventClassKinds,
  systemEventClassOf,
  systemEventFilterAppliesToAnyKind,
} from '@camstack/types'
import i18n from '../../i18n/index'

/** One selectable system-event kind. */
export interface NcSystemEventKindOption {
  readonly value: NcSystemEventKind
  readonly label: string
}

/**
 * A themed set of kinds inside ONE family (D637), so the multi-select reads as
 * a few short questions ("are my devices up?", "is a battery flat?") rather
 * than one list of strings. Which groups exist, in which family and in which
 * order is `NC_SYSTEM_EVENT_KIND_GROUP_SPECS` (shared with the viewer); the
 * English labels and hints are this editor's.
 */
export interface NcSystemEventKindGroup {
  readonly id: string
  readonly family: NcSystemEventFamily
  readonly label: string
  /** One-line explanation of what the group's events mean. */
  readonly hint: string
  readonly kinds: readonly NcSystemEventKindOption[]
}

/** A kind an operator may author: every kind but the legacy camera tail. */
export type NcAuthorableSystemEventKind = Exclude<
  NcSystemEventKind,
  (typeof NC_LEGACY_SYSTEM_EVENT_KINDS)[number]
>

/**
 * Every authorable kind's English label, in ONE table. Total over the
 * authorable kinds: a kind added to the cap without a label fails tsc here.
 * Word for word the viewer's (`v2.nc.rules.editor.systemKinds`).
 */
const NC_SYSTEM_EVENT_KIND_LABELS: Readonly<Record<NcAuthorableSystemEventKind, string>> = {
  'device-offline': 'Device offline',
  'device-online': 'Device online',
  'device-disabled': 'Device switched off',
  'device-enabled': 'Device switched on',
  'stream-offline': 'Stream offline',
  'stream-online': 'Stream online',
  'device-battery-low': 'Battery low',
  'device-battery-normal': 'Battery back to normal',
  'device-consumable-low': 'Consumable low',
  'device-consumable-normal': 'Consumable back to normal',
  'detection-blind': 'Camera detecting nothing',
  'motion-noisy': 'Camera motion constant, no subject',
  'motion-calm': 'Camera motion calm again',
  'package-llm-silent': 'Package confirm not answering',
  'package-llm-answered': 'Package confirm answering again',
  'recording-stalled': 'Recording stalled',
  'recording-healthy': 'Recording healthy again',
  'recording-degraded': 'Recording degraded (restart storm)',
  'device-attention-required': 'Device needs attention',
  'device-attention-resolved': 'Device attention resolved',
  'storage-location-low': 'Storage location low',
  'storage-location-critical': 'Storage location critical',
  'storage-location-ok': 'Storage location ok again',
  'node-offline': 'Node offline',
  'node-online': 'Node online',
  'node-restarting': 'Node restarting',
  'node-updating': 'Node updating (restart imminent)',
  'node-inference-unavailable': 'Node has no usable inference device',
  'addon-crash-loop': 'Addon stopped after repeated crashes',
  'addon-update-available': 'Addon update available',
  'addon-updated': 'Addons updated',
  'server-update-available': 'Server update available',
  'server-updated': 'Server updated',
  'wrapper-update-available': 'Container / app update available',
  'export-completed': 'Export completed',
  'backup-completed': 'Backup completed',
  'alert-critical': 'Critical alert raised',
  'alert-error': 'Error alert raised',
  'alert-critical-resolved': 'Critical alert resolved',
  'rule-broken': 'Notification rule broken',
  'rule-repaired': 'Notification rule repaired',
  'alarm-arm-refused': 'Alarm arm refused (something is open)',
  'alarm-check-failed': 'Alarm check failed (armed anyway)',
  'alarm-arming': 'Alarm arming (exit delay)',
  'alarm-armed': 'Alarm armed',
  'alarm-pending': 'Alarm entry delay started',
  'alarm-triggered': 'Alarm triggered',
  'alarm-rearmed': 'Alarm re-armed after siren',
  'alarm-sensor-bypass': 'Alarm sensor bypass',
  'alarm-disarmed': 'Alarm disarmed',
}

/** Read by NAME so a legacy kind simply has no label — no cast. */
const LABEL_BY_KIND: ReadonlyMap<string, string> = new Map(
  Object.entries(NC_SYSTEM_EVENT_KIND_LABELS),
)

function labelOfAuthorable(kind: NcSystemEventKind): string | undefined {
  return LABEL_BY_KIND.get(kind)
}

/** Each group's one-line hint, keyed by the shared group id. */
const NC_SYSTEM_EVENT_GROUP_HINTS: Readonly<Record<string, string>> = {
  // Liveness covers EVERY device type — a camera, a plug, a sensor; the "which
  // ones" question is the device-type filter, not the kind. The switch is a
  // DIFFERENT question from liveness (D62): mixing the two is how an operator
  // reads "switched off" as "broken", so the hint says which is which.
  'device-state':
    'A device the hub can no longer reach, or that came back. Switched off / on is a device an operator turned off or back on — not a fault, a choice.',
  streams: 'A stream that stopped or came back.',
  // Its OWN group: a flat battery is a sustained state rather than a moment,
  // it says itself again on an interval, and its threshold + reminder +
  // recovery switch are cluster settings rather than fields of the rule.
  battery:
    'A battery below the cluster threshold, and (optionally) its return to normal. Devices with a binary low-battery indicator are judged by the indicator, not by the percentage.',
  // Beside battery, not inside it: a filter or a brush is a different physical
  // thing to replace, and a device may report one as a percentage and the
  // other as a plain "replace me". Its threshold is THIS rule's (D642).
  consumables:
    'A consumable — filter, brush, bag, supply or waste tank — at or below this rule’s threshold, or that the device reports as due for replacement, and (optionally) its return to normal after a change. A device that only says "replace" is judged by that, not by a percentage.',
  // Not liveness: the camera is decoding and the offline rules stay quiet —
  // which is exactly why this failure went unnoticed for 1h43.
  'detection-blind':
    'A camera that MOVED — at least 10 minutes of motion over 3 sessions — was analysed, and whose detector produced nothing at all, not even a candidate under the confidence floor.',
  // Not blind: the motion source fires on nothing (D907).
  'motion-noise':
    'A camera whose motion fires constantly with no subject for an hour — a quarter of the time in motion, or 40 sessions — and (optionally) its return to calm. The detector is fine; tune the motion zones or sensitivity.',
  recording:
    'A camera whose recording is on but no footage is landing (stall), a writer that burned its restart budget (degraded), and (optionally) the return to healthy writing.',
  'device-attention':
    'A device whose own addon raised a critical alert because it needs the operator (a missing or rejected PIN), and the return to normal.',
  // The node half of the old "Up but producing nothing" group sits with the
  // nodes: an online node whose accelerators all went away.
  nodes:
    'An agent or worker node joining or leaving the cluster, or an online node whose inference devices all went away.',
  // Two groups since D708: a crash and an update are acted on by different
  // people at different moments, and a summary sends each group on its own.
  addons: 'An addon the hub has stopped restarting after repeated crashes.',
  'addon-updates': 'A newer version of an addon, or an addon update that just finished.',
  updates:
    'A newer version of the server itself, or of the container / app the node runs inside, is available — or a server update just finished.',
  'backups-exports':
    'A scheduled or manual backup of the hub finished, or a footage export finished rendering.',
  // The alert centre sends nothing of its own: these rules are the only way a
  // critical (or error) alert reaches a phone.
  alerts:
    'A critical or error alert opening — a runner that failed or was refused, a recording location out of space, an expired sign-in — and (optionally) a critical alert resolving. One notification per alert episode.',
  storage:
    'A storage location running low or critical on free space — or whose capacity probe failed — and (optionally) its return to ok.',
  // D905: a rule that silently stopped working is the one failure no other
  // rule can report — it is the rule.
  'rule-health':
    'A notification rule that cannot work — it no longer loads, or still names a device or destination that was deleted — and (optionally) its repair.',
  // The panel is a device and its lifecycle an installation fact. In
  // LIFECYCLE order (`NC_ALARM_SYSTEM_EVENT_KINDS`): `alarm-arm-refused` first
  // because it happens INSTEAD of the rest, `alarm-check-failed` next (D49 —
  // unknown never blocks, but the operator must hear it while there is time).
  alarm:
    'The alarm panel refusing to arm, arming, armed, counting down to a siren, going off, re-arming, excluding an open sensor, or being disarmed.',
}

export const NC_SYSTEM_EVENT_KIND_GROUPS: readonly NcSystemEventKindGroup[] =
  NC_SYSTEM_EVENT_KIND_GROUP_SPECS.map((spec) => ({
    id: spec.id,
    family: spec.family,
    label: spec.label,
    hint: NC_SYSTEM_EVENT_GROUP_HINTS[spec.id] ?? '',
    kinds: spec.kinds.flatMap((kind) => {
      const label = labelOfAuthorable(kind)
      return label === undefined ? [] : [{ value: kind, label }]
    }),
  }))

/** The groups ONE family's editor offers (D637). */
export function systemEventKindGroupsFor(
  family: NcSystemEventFamily,
): readonly NcSystemEventKindGroup[] {
  return NC_SYSTEM_EVENT_KIND_GROUPS.filter((g) => g.family === family)
}

/**
 * The kinds a new rule of this family opens with — the section seed, so a
 * rule is never authored without kinds (which would classify it `mixed`).
 */
export function seedSystemEventForFamily(family: NcSystemEventFamily): NcSystemEventCondition {
  const seeded = ruleSeedForSection(family).conditions.systemEvent
  return seeded !== undefined
    ? { ...seeded, kinds: [...seeded.kinds] }
    : { kinds: (systemEventKindGroupsFor(family)[0]?.kinds ?? []).map((k) => k.value) }
}

/** Every kind in authoring order (flattened from the groups — one source). */
export const NC_SYSTEM_EVENT_KIND_OPTIONS: readonly NcSystemEventKindOption[] =
  NC_SYSTEM_EVENT_KIND_GROUPS.flatMap((group) => group.kinds)

/** Human label for a kind; falls back to the raw value for an unknown one. */
export function systemEventKindLabel(kind: string): string {
  return NC_SYSTEM_EVENT_KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind
}

/**
 * Narrow a raw string to a known kind (no cast — same discipline as
 * `parseDelivery`). Unknown returns undefined so a stray value is IGNORED
 * rather than written into the rule.
 */
export function parseSystemEventKind(value: string): NcSystemEventKind | undefined {
  return NC_SYSTEM_EVENT_KIND_OPTIONS.find((o) => o.value === value)?.value
}

/** Which optional narrowing filters are meaningful for the selected kinds. */
export interface NcSystemEventFilterVisibility {
  readonly devices: boolean
  /** The device-TYPE filter — only liveness/switch kinds can be narrowed by
   *  it (a stream belongs to a camera by construction). */
  readonly deviceTypes: boolean
  readonly nodes: boolean
  readonly packages: boolean
  /** The rule's consumable threshold (D642) — only with a consumable kind. */
  readonly consumableThreshold: boolean
}

/**
 * Which filters this kind selection can actually be narrowed by.
 *
 * DERIVED, not restated. The scoping used to live here as four `kinds.some(…)`
 * predicates, in the viewer as a second copy of them, and NOT AT ALL in the
 * engine — which applied every filter to every kind and failed nine of the
 * operator's eleven selected kinds closed. There is now one statement of it
 * (`systemEventFilterApplies` in `@camstack/types`), the engine reads it, and
 * `scripts/check-nc-system-filter-scope.ts` refuses a future hand-rolled copy.
 *
 * A filter that cannot narrow the selected kinds is HIDDEN rather than shown
 * empty: a node-id box on a rule that only watches cameras reads as "leave it
 * blank and it matches all nodes", which is a promise this rule never makes.
 */
export function systemEventFilterVisibility(
  kinds: readonly NcSystemEventKind[],
): NcSystemEventFilterVisibility {
  return {
    devices: systemEventFilterAppliesToAnyKind(kinds, 'deviceIds'),
    deviceTypes: systemEventFilterAppliesToAnyKind(kinds, 'deviceTypes'),
    nodes: systemEventFilterAppliesToAnyKind(kinds, 'nodeIds'),
    packages: systemEventFilterAppliesToAnyKind(kinds, 'packageNames'),
    consumableThreshold: systemEventFilterAppliesToAnyKind(kinds, 'consumableLowPercent'),
  }
}

/** The family editor's visibility: the per-kind one, inside the family's filters. */
export interface NcSystemEventFamilyFilterVisibility extends NcSystemEventFilterVisibility {
  /** The "never these devices" list — a device-events filter only. */
  readonly excludeDevices: boolean
}

/**
 * Which filters a rule of this FAMILY, with these kinds, may show (D637).
 *
 * Composes the per-kind scoping with the family's allowed filters. For alarm,
 * `deviceIds` applies only to `alarm-triggered` (`systemEventFilterApplies`),
 * so "the camera filter only with alarm-triggered" falls out of the shared
 * predicate — no second rule.
 */
export function systemEventFilterVisibilityFor(
  family: NcSystemEventFamily,
  kinds: readonly NcSystemEventKind[],
): NcSystemEventFamilyFilterVisibility {
  const allowed = NC_SYSTEM_EVENT_FAMILY_FILTERS[family]
  const byKind = systemEventFilterVisibility(kinds)
  return {
    devices: allowed.includes('deviceIds') && byKind.devices,
    excludeDevices: allowed.includes('excludeDeviceIds') && byKind.devices,
    deviceTypes: allowed.includes('deviceTypes') && byKind.deviceTypes,
    nodes: allowed.includes('nodeIds') && byKind.nodes,
    packages: allowed.includes('packageNames') && byKind.packages,
    consumableThreshold: allowed.includes('consumableLowPercent') && byKind.consumableThreshold,
  }
}

/**
 * The device types a liveness rule can be narrowed to, in one alphabetical
 * list built from the schema's own enum — a type added server-side appears
 * here without an edit, which is the property the kind list has too.
 */
export const NC_DEVICE_TYPE_OPTIONS: readonly { readonly value: string; readonly label: string }[] =
  Object.values(DeviceType)
    .map((type) => ({ value: type, label: deviceTypeLabel(type) }))
    .toSorted((a, b) => a.label.localeCompare(b.label))

/** "media-player" → "Media player". The enum value IS the vocabulary; this
 *  only makes it readable. */
function deviceTypeLabel(type: string): string {
  const spaced = type.replaceAll('-', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * One checkbox of a kind group (D906): a paired CLASS — a "went bad" and a
 * "came back" edge of one condition — or a single one-edge kind.
 *
 * On an instant rule a class writes BOTH edges. On a scheduled STATE SUMMARY a
 * class means the bad state at the scheduled time, so it writes the bad edges
 * only and is labelled as a snapshot; a class the summary has no state source
 * for is flagged `noSnapshot` (it would report nothing).
 */
export interface NcSystemEventGroupOption {
  readonly key: string
  readonly label: string
  /** The kinds the checkbox writes when ticked. */
  readonly kinds: readonly NcSystemEventKind[]
  /** The kinds the checkbox clears when unticked (a class clears both edges). */
  readonly clears: readonly NcSystemEventKind[]
  readonly classId?: string
  readonly noSnapshot?: boolean
}

/** The checkboxes of one group, in authoring order — one per class, one per single kind. */
export function systemEventGroupOptions(
  group: NcSystemEventKindGroup,
  summary: boolean,
): readonly NcSystemEventGroupOption[] {
  const options: NcSystemEventGroupOption[] = []
  const emitted = new Set<string>()
  for (const option of group.kinds) {
    const spec = systemEventClassOf(option.value)
    if (spec === undefined) {
      options.push({
        key: option.value,
        label: option.label,
        kinds: [option.value],
        clears: [option.value],
      })
      continue
    }
    if (emitted.has(spec.id)) continue
    emitted.add(spec.id)
    options.push({
      key: `class:${spec.id}`,
      label: summary ? spec.snapshotLabel : spec.label,
      kinds: summary ? [...spec.bad] : systemEventClassKinds(spec),
      clears: systemEventClassKinds(spec),
      classId: spec.id,
      ...(summary && spec.snapshotSection === null ? { noSnapshot: true } : {}),
    })
  }
  return options
}

/** Is a checkbox ticked: does the rule carry any of the kinds it stands for? */
export function systemEventOptionSelected(
  kinds: readonly NcSystemEventKind[],
  option: NcSystemEventGroupOption,
): boolean {
  return option.clears.some((kind) => kinds.includes(kind))
}

/**
 * Tick or untick one checkbox (a class or a single kind). Same refusals as
 * {@link toggleSystemEventKind}: never the last kind, never another family's.
 */
export function toggleSystemEventOption(
  value: NcSystemEventCondition | undefined,
  option: NcSystemEventGroupOption,
  family: NcSystemEventFamily,
): NcSystemEventCondition | undefined {
  const offered = systemEventKindGroupsFor(family).some((g) =>
    g.kinds.some((k) => option.kinds.includes(k.value)),
  )
  if (!offered) return value
  const current = value?.kinds ?? []
  if (systemEventOptionSelected(current, option)) {
    const next = current.filter((kind) => !option.clears.includes(kind))
    if (next.length === 0) return value
    return withKinds(value, next, family)
  }
  const next = NC_SYSTEM_EVENT_KIND_OPTIONS.filter(
    (o) => option.kinds.includes(o.value) || current.includes(o.value),
  ).map((o) => o.value)
  return withKinds(value, next, family)
}

/**
 * Add/remove one kind of THIS family, returning the new condition.
 *
 * Refuses (returns `value` unchanged) to remove the LAST kind: `kinds` is the
 * engine's required gate (`.min(1)`), and a rule with no kinds classifies
 * `mixed` (D637) — the family would flip mid-edit. Refuses a kind of another
 * family for the same reason. Kind order follows the authoring order so a rule
 * saved twice does not churn.
 */
export function toggleSystemEventKind(
  value: NcSystemEventCondition | undefined,
  kind: NcSystemEventKind,
  family: NcSystemEventFamily,
): NcSystemEventCondition | undefined {
  const offered = systemEventKindGroupsFor(family).some((g) =>
    g.kinds.some((k) => k.value === kind),
  )
  if (!offered) return value
  const current = value?.kinds ?? []
  if (current.length === 1 && current[0] === kind) return value
  const next = current.includes(kind)
    ? current.filter((k) => k !== kind)
    : NC_SYSTEM_EVENT_KIND_OPTIONS.filter((o) => o.value === kind || current.includes(o.value)).map(
        (o) => o.value,
      )
  return withKinds(value, next, family)
}

/**
 * The condition as it is SAVED: the filters the family does not carry are
 * dropped, and so is one its kinds no longer use — an alarm rule without
 * `alarm-triggered` loses its camera filter. The hub refuses an out-of-family
 * filter (D637), and a filter the editor stopped showing is a restriction the
 * operator cannot see.
 */
export function pruneSystemEventForSave(
  family: NcSystemEventFamily,
  value: NcSystemEventCondition | undefined,
): NcSystemEventCondition | undefined {
  return value === undefined ? undefined : withKinds(value, value.kinds, family)
}

/** The optional narrowing filters, each `undefined` = unrestricted. */
export interface NcSystemEventFilterPatch {
  readonly deviceIds?: readonly number[] | undefined
  /** Devices never spoken about — include first, then exclude (D636). */
  readonly excludeDeviceIds?: readonly number[] | undefined
  readonly deviceTypes?: readonly string[] | undefined
  readonly nodeIds?: readonly string[] | undefined
  readonly packageNames?: readonly string[] | undefined
  /** The rule's consumable threshold (D642); `undefined` = the default. */
  readonly consumableLowPercent?: number | undefined
}

/** The list-valued filters of {@link NcSystemEventFilterPatch}. */
type NcSystemEventListFilterKey = Exclude<keyof NcSystemEventFilterPatch, 'consumableLowPercent'>

/**
 * Patch one filter list. An empty list is written as ABSENT: the schema's
 * `.min(1)` would reject `[]`, and "no restriction" is exactly what absent
 * means — so clearing a filter can never save a rule that matches nothing.
 *
 * Returns `undefined` (drop the condition) when no kind is selected, because a
 * filter without a kind gate is not a condition the engine accepts.
 */
export function patchSystemEventFilters(
  value: NcSystemEventCondition | undefined,
  patch: NcSystemEventFilterPatch,
): NcSystemEventCondition | undefined {
  const kinds = value?.kinds ?? []
  if (kinds.length === 0) return undefined
  const deviceIds = pick(patch, 'deviceIds', value?.deviceIds)
  const excludeDeviceIds = pick(patch, 'excludeDeviceIds', value?.excludeDeviceIds)
  const deviceTypes = pick(patch, 'deviceTypes', value?.deviceTypes)
  const nodeIds = pick(patch, 'nodeIds', value?.nodeIds)
  const packageNames = pick(patch, 'packageNames', value?.packageNames)
  const consumableLowPercent = Object.prototype.hasOwnProperty.call(patch, 'consumableLowPercent')
    ? patch.consumableLowPercent
    : value?.consumableLowPercent
  return {
    kinds: [...kinds],
    ...(deviceIds !== undefined ? { deviceIds: [...deviceIds] } : {}),
    ...(excludeDeviceIds !== undefined ? { excludeDeviceIds: [...excludeDeviceIds] } : {}),
    ...(deviceTypes !== undefined ? { deviceTypes: [...deviceTypes] } : {}),
    ...(nodeIds !== undefined ? { nodeIds: [...nodeIds] } : {}),
    ...(packageNames !== undefined ? { packageNames: [...packageNames] } : {}),
    ...(consumableLowPercent !== undefined ? { consumableLowPercent } : {}),
  }
}

/** Read a patched key when present (even as `undefined` = clear), else keep. */
function pick<K extends NcSystemEventListFilterKey>(
  patch: NcSystemEventFilterPatch,
  key: K,
  fallback: NcSystemEventFilterPatch[K],
): NcSystemEventFilterPatch[K] {
  const supplied = Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : fallback
  return supplied !== undefined && supplied.length === 0 ? undefined : supplied
}

/**
 * Re-seat the kinds while DROPPING the filters that no longer narrow anything.
 *
 * Deselecting `alarm-triggered` must not leave a camera list on the rule: the
 * editor stops showing it, so an operator cannot see it, and a rule nobody can
 * see the whole of is how a rule silently stops firing.
 */
function withKinds(
  value: NcSystemEventCondition | undefined,
  kinds: readonly NcSystemEventKind[],
  family: NcSystemEventFamily,
): NcSystemEventCondition {
  const visible = systemEventFilterVisibilityFor(family, kinds)
  const deviceIds = visible.devices ? value?.deviceIds : undefined
  const excludeDeviceIds = visible.excludeDevices ? value?.excludeDeviceIds : undefined
  const deviceTypes = visible.deviceTypes ? value?.deviceTypes : undefined
  const nodeIds = visible.nodes ? value?.nodeIds : undefined
  const packageNames = visible.packages ? value?.packageNames : undefined
  const consumableLowPercent = visible.consumableThreshold ? value?.consumableLowPercent : undefined
  return {
    kinds: [...kinds],
    ...(deviceIds && deviceIds.length > 0 ? { deviceIds: [...deviceIds] } : {}),
    ...(excludeDeviceIds && excludeDeviceIds.length > 0
      ? { excludeDeviceIds: [...excludeDeviceIds] }
      : {}),
    ...(deviceTypes && deviceTypes.length > 0 ? { deviceTypes: [...deviceTypes] } : {}),
    ...(nodeIds && nodeIds.length > 0 ? { nodeIds: [...nodeIds] } : {}),
    ...(packageNames && packageNames.length > 0 ? { packageNames: [...packageNames] } : {}),
    ...(consumableLowPercent !== undefined ? { consumableLowPercent } : {}),
  }
}

/** The bounds the hub's schema holds a consumable threshold to (D642). */
export const NC_CONSUMABLE_THRESHOLD_MIN = 1
export const NC_CONSUMABLE_THRESHOLD_MAX = NC_CONSUMABLE_LOW_PERCENT_MAX

/** What the threshold box's text means: clear it, set it, or nothing yet. */
export type NcConsumableThresholdInput =
  | { readonly kind: 'clear' }
  | { readonly kind: 'set'; readonly value: number }
  | { readonly kind: 'invalid' }

/**
 * Read the threshold box. Empty is `clear` (the rule judges at the default);
 * a whole number in 1–95 is `set`; anything else is `invalid` and is never
 * written — the hub would refuse the save, and a half-typed number is not a
 * decision.
 */
export function parseConsumableThreshold(raw: string): NcConsumableThresholdInput {
  const text = raw.trim()
  if (text === '') return { kind: 'clear' }
  const value = Number(text)
  return Number.isInteger(value) &&
    value >= NC_CONSUMABLE_THRESHOLD_MIN &&
    value <= NC_CONSUMABLE_THRESHOLD_MAX
    ? { kind: 'set', value }
    : { kind: 'invalid' }
}

// ── List-row summaries ──────────────────────────────────────────────

/**
 * "Camera offline, Node offline +4" — the Events column of the system section.
 * Names the first `max` kinds and counts the rest, so a rule watching six kinds
 * still says WHICH ones it leads with.
 */
export function summariseSystemEventKinds(kinds: readonly string[] | undefined, max = 2): string {
  if (kinds === undefined || kinds.length === 0)
    return i18n.t('helpers.notificationSystemEvents.noneSelected')
  const named = kinds.slice(0, max).map(systemEventKindLabel).join(', ')
  const rest = kinds.length - Math.min(max, kinds.length)
  return rest > 0 ? `${named} +${rest}` : named
}

/**
 * "Everything" / "2 cameras · 1 node" — what the rule is narrowed to.
 *
 * Absent filters are stated as "Everything" rather than left blank: blank reads
 * as unknown, and the difference between "all cameras" and "one camera" is the
 * whole reason an operator opens this column.
 */
export function summariseSystemEventScope(condition: NcSystemEventCondition | undefined): string {
  if (condition === undefined) return '—'
  const parts: string[] = []
  const devices = condition.deviceIds?.length ?? 0
  const types = condition.deviceTypes?.length ?? 0
  const nodes = condition.nodeIds?.length ?? 0
  const packages = condition.packageNames?.length ?? 0
  const excluded = condition.excludeDeviceIds?.length ?? 0
  if (types > 0) parts.push(condition.deviceTypes?.map(deviceTypeLabel).join(', ') ?? '')
  if (devices > 0) parts.push(`${devices} device${devices === 1 ? '' : 's'}`)
  if (nodes > 0) parts.push(`${nodes} node${nodes === 1 ? '' : 's'}`)
  if (packages > 0) parts.push(`${packages} package${packages === 1 ? '' : 's'}`)
  const except = excluded > 0 ? `except ${excluded} device${excluded === 1 ? '' : 's'}` : null
  const threshold =
    condition.consumableLowPercent !== undefined
      ? [`consumables at ${condition.consumableLowPercent}%`]
      : []
  if (parts.length === 0) {
    return [except === null ? 'Everything' : `Everything ${except}`, ...threshold].join(' · ')
  }
  return [...parts, ...(except === null ? [] : [except]), ...threshold].join(' · ')
}

/**
 * Every kind a rule may be AUTHORED with — the guard the spec compares against.
 *
 * Not `NcSystemEventKindSchema.options`: that enum also carries the legacy
 * camera-worded tail, which exists only so a durable row and an unmigrated
 * rule still PARSE. Offering those would let an operator author a rule that
 * can never fire.
 */
export const NC_SYSTEM_EVENT_SCHEMA_KINDS: readonly NcSystemEventKind[] =
  NC_AUTHORABLE_SYSTEM_EVENT_KINDS

/**
 * Does this condition put a BATTERY or CONSUMABLE kind behind a device-type
 * filter?
 *
 * The live outage (D636): "Eventi di sistema" carried the four kinds under
 * `deviceTypes: ['camera']` — a filter meant for liveness — and every battery
 * and consumable on the hub belongs to a sensor, a container, a vacuum or a
 * lawn mower. Nothing was delivered for two weeks and the only signal was an
 * INFO line. The editors warn whenever the two meet; the viewer's dedicated
 * battery section makes it rare.
 */
export function batteryKindsNarrowedByType(condition: NcSystemEventCondition | undefined): boolean {
  if (condition === undefined || (condition.deviceTypes?.length ?? 0) === 0) return false
  return condition.kinds.some((kind) => NC_BATTERY_CONSUMABLE_SYSTEM_EVENT_KINDS.includes(kind))
}
