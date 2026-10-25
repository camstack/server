/**
 * The smart device picker's decisions — search, groups, per-group bulk
 * actions, the chip overflow and the bounded render — with no UI in it.
 *
 * One picker replaces every long device checklist in the notification editors
 * (a rule's devices, a system rule's include/exclude, the timelapse and digest
 * cameras, the alarm's non-blocking openings). A checklist of 293 rows on the
 * admin, and of every camera on a phone, took the whole screen to say "two
 * devices"; the picker shows the selection as chips and opens a searchable,
 * grouped list only to change it.
 *
 * Since D637 the same model also serves the system family's node and package
 * pickers, keyed by string: every item and function is generic over
 * {@link PickerId}, and a device picker is simply `PickerItem<number>`.
 *
 * It has to hold at HUNDREDS of devices of ONE type (a fleet of HA sensors),
 * which is what shapes it:
 *
 *  - search is a debounced, case-insensitive AND over name, room, type,
 *    container and id — "sala temp" finds the living-room thermometer among
 *    nine "Temperatura";
 *  - the DEVICE picker groups by what the operator chose at the top of the
 *    list — site zone (default), location, or nothing
 *    ({@link groupPickerDevicesBy}); the node and package pickers keep
 *    (type, liveness) groups;
 *  - (type, room) groups, where they are still used — and any group bigger than
 *    {@link PICKER_GROUP_COLLAPSE_AT} starts COLLAPSED unless a search is
 *    running or it holds a selected device — a collapsed header still says how
 *    many it holds and offers select-all / clear;
 *  - the list is rendered in bounded pieces ({@link pageRows} for a capped
 *    render with "show N more"; a virtualised list sizes itself from
 *    {@link PICKER_WINDOW});
 *  - the list can be NARROWED by search plus Type / Zone / Location filters
 *    ({@link applyPickerFilters}); "Reset filters" clears those and leaves
 *    "Group by" alone ({@link resetPickerFilters}, D697);
 *  - the chips show at most {@link PICKER_CHIP_LIMIT} and a "+N more".
 *
 * It reads NOTHING. It filters the list the caller already holds; an id the
 * list lacks is the caller's to resolve (`device-selection.ts`), which is also
 * where D315 and D49 live.
 *
 * TWO BYTE-IDENTICAL COPIES: `camstack/src/components/notifications/
 * device-picker-model.ts` (viewer) and `packages/addon-admin-ui/src/pages/
 * system/device-picker-model.ts` (admin), for the reason `device-selection.ts`
 * has two. `scripts/check-device-selection-in-sync.ts` fails the commit when
 * they differ. No `toSorted` here: the viewer runs on Hermes.
 */

/** What a picker item is keyed by: a device id, or a node id / package name (D637). */
export type PickerId = number | string

/** One item as the picker lists it. */
export interface PickerItem<Id extends PickerId> {
  readonly id: Id
  readonly name: string
  /** Groups by this (`DeviceType`, node role, package kind); absent groups under "no type". */
  readonly type?: string
  /** The second grouping axis (room, liveness); absent or null groups under "none". */
  readonly location?: string | null
  /**
   * A second line — the container a child device belongs to, a node's id, a
   * version. When unset and {@link parentDeviceId} is set, the picker fills
   * this with `in <parent>` from the same listing.
   */
  readonly detail?: string
  /**
   * Hub/container this device is attached to. Number ids only; the picker
   * resolves the name from the same `devices` list (see `device-parent.ts`).
   */
  readonly parentDeviceId?: number | null
}

/** One device as the picker lists it. */
export type PickerDevice = PickerItem<number>

/** Numbers numerically, anything else by its text — the name tie-break. */
function compareIds(a: PickerId, b: PickerId): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

/** How long the search waits after the last keystroke. */
export const PICKER_SEARCH_DEBOUNCE_MS = 200
/** A group with more devices than this starts collapsed (unless searching). */
export const PICKER_GROUP_COLLAPSE_AT = 8
/** How many selected chips are drawn before "+N more". */
export const PICKER_CHIP_LIMIT = 6
/** Rows a capped render draws per "show more". */
export const PICKER_PAGE_SIZE = 60
/** Rows a virtualised list renders per batch and initially. */
export const PICKER_WINDOW = 30

/** Everything a query can match on, lower-cased. */
export function pickerSearchText(device: PickerItem<PickerId>): string {
  const parts = [device.name, device.location ?? '', device.type ?? '', device.detail ?? '']
  return `${parts.join(' ')} ${String(device.id)}`.toLowerCase()
}

/** The query's tokens; empty for a blank query. */
export function pickerQueryTokens(query: string): readonly string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0)
}

/** Devices matching EVERY token. A blank query keeps the list as it is. */
export function filterPickerDevices<Id extends PickerId>(
  devices: readonly PickerItem<Id>[],
  query: string,
): readonly PickerItem<Id>[] {
  const tokens = pickerQueryTokens(query)
  if (tokens.length === 0) return devices
  return devices.filter((device) => {
    const hay = pickerSearchText(device)
    return tokens.every((token) => hay.includes(token))
  })
}

/**
 * What a "Group by" group is named after. Absent on the (type, room) groups
 * the node and package pickers still use.
 */
export type PickerGroupHeading =
  | { readonly kind: 'zone'; readonly label: string }
  | { readonly kind: 'location'; readonly label: string }
  | { readonly kind: 'no-zone' }
  | { readonly kind: 'no-location' }

/** One (type, room) group — or, under "Group by", one zone or location. */
export interface PickerGroup<Id extends PickerId = number> {
  readonly key: string
  readonly type: string | null
  readonly location: string | null
  readonly devices: readonly PickerItem<Id>[]
  readonly selectedCount: number
  readonly heading?: PickerGroupHeading
}

function compareNullableLast(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a.localeCompare(b)
}

function blankToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.trim() === '' ? null : value
}

/** The key a group is remembered by (collapsed / expanded). */
export function pickerGroupKey(type: string | null, location: string | null): string {
  return `${type ?? ''}|${location ?? ''}`
}

/** A group while it is being filled. */
interface PickerBucket<Id extends PickerId> {
  readonly type: string | null
  readonly location: string | null
  readonly devices: PickerItem<Id>[]
}

/** Group by type, then room; both ascending, "none" last; devices by name. */
export function groupPickerDevices<Id extends PickerId>(
  devices: readonly PickerItem<Id>[],
  selected: readonly Id[],
): readonly PickerGroup<Id>[] {
  const picked = new Set<Id>(selected)
  const buckets = new Map<string, PickerBucket<Id>>()
  for (const device of devices) {
    const type = blankToNull(device.type)
    const location = blankToNull(device.location)
    const key = pickerGroupKey(type, location)
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, { type, location, devices: [device] })
    else bucket.devices.push(device)
  }
  const groups: PickerGroup<Id>[] = []
  for (const [key, bucket] of buckets) {
    const sorted = [...bucket.devices].sort(
      (a, b) => a.name.localeCompare(b.name) || compareIds(a.id, b.id),
    )
    groups.push({
      key,
      type: bucket.type,
      location: bucket.location,
      devices: sorted,
      selectedCount: sorted.filter((device) => picked.has(device.id)).length,
    })
  }
  return groups.sort(
    (a, b) => compareNullableLast(a.type, b.type) || compareNullableLast(a.location, b.location),
  )
}

/**
 * Whether a group is open. The operator's own toggle wins; otherwise a small
 * group is open, a big one is closed — unless a search is running (the result
 * IS what they asked to see) or it holds a selected device.
 */
export function isGroupExpanded<Id extends PickerId>(
  group: PickerGroup<Id>,
  toggles: ReadonlyMap<string, boolean>,
  searching: boolean,
): boolean {
  const own = toggles.get(group.key)
  if (own !== undefined) return own
  if (searching || group.selectedCount > 0) return true
  return group.devices.length <= PICKER_GROUP_COLLAPSE_AT
}

/** One row of the flattened list: a group header, or a device under it. */
export type PickerRow<Id extends PickerId = number> =
  | {
      readonly kind: 'header'
      readonly key: string
      readonly group: PickerGroup<Id>
      readonly expanded: boolean
    }
  | {
      readonly kind: 'device'
      readonly key: string
      readonly device: PickerItem<Id>
      readonly groupKey: string
      readonly selected: boolean
    }

/** The groups as ONE list of rows — what a virtualised list renders. */
export function flattenPickerRows<Id extends PickerId>(
  groups: readonly PickerGroup<Id>[],
  selected: readonly Id[],
  toggles: ReadonlyMap<string, boolean>,
  searching: boolean,
): readonly PickerRow<Id>[] {
  const picked = new Set<Id>(selected)
  const rows: PickerRow<Id>[] = []
  for (const group of groups) {
    const expanded = isGroupExpanded(group, toggles, searching)
    rows.push({ kind: 'header', key: `h:${group.key}`, group, expanded })
    if (!expanded) continue
    for (const device of group.devices) {
      rows.push({
        kind: 'device',
        key: `d:${String(device.id)}`,
        device,
        groupKey: group.key,
        selected: picked.has(device.id),
      })
    }
  }
  return rows
}

/** Tick or untick one id. The order of the rest is kept. */
export function togglePickerDevice<Id extends PickerId>(value: readonly Id[], id: Id): Id[] {
  return value.includes(id) ? value.filter((v) => v !== id) : [...value, id]
}

/** Add every device of the group (only the ones the current search shows). */
export function selectPickerGroup<Id extends PickerId>(
  value: readonly Id[],
  group: PickerGroup<Id>,
): Id[] {
  const next = [...value]
  const have = new Set<Id>(value)
  for (const device of group.devices) {
    if (!have.has(device.id)) next.push(device.id)
  }
  return next
}

/** Remove every device of the group; ids outside it are untouched. */
export function clearPickerGroup<Id extends PickerId>(
  value: readonly Id[],
  group: PickerGroup<Id>,
): Id[] {
  const drop = new Set<Id>(group.devices.map((device) => device.id))
  return value.filter((id) => !drop.has(id))
}

/** The chips to draw, and how many are behind "+N more". */
export interface ChipOverflow<T> {
  readonly shown: readonly T[]
  readonly hidden: number
}

export function chipOverflow<T>(items: readonly T[], expanded: boolean): ChipOverflow<T> {
  if (expanded || items.length <= PICKER_CHIP_LIMIT) return { shown: items, hidden: 0 }
  return { shown: items.slice(0, PICKER_CHIP_LIMIT), hidden: items.length - PICKER_CHIP_LIMIT }
}

/** A capped render: the first `shown` rows, and how many are left. */
export interface PickerPage<Id extends PickerId = number> {
  readonly rows: readonly PickerRow<Id>[]
  readonly remaining: number
}

export function pageRows<Id extends PickerId>(
  rows: readonly PickerRow<Id>[],
  shown: number,
): PickerPage<Id> {
  const count = Math.max(0, Math.min(rows.length, shown))
  return { rows: rows.slice(0, count), remaining: rows.length - count }
}

// ── Group by: Zone (default) / Location / None — the DEVICE picker only ──────
//
// A site zone is a named set of locations ("Night zone" holds the bedrooms); a
// device reaches one through its location's FOLDED key — the fold the zone's
// `locationKeys` use (`siteZoneKey` / `locationIconKey`: trimmed, lower-cased).
// The node and package pickers keep their own (type, liveness) groups and have
// no "Group by" at all.

/** How the device picker groups its list. */
export type PickerGroupBy = 'zone' | 'location' | 'none'

/** The modes, in the order the control draws them. */
export const PICKER_GROUP_BY_MODES: readonly PickerGroupBy[] = ['zone', 'location', 'none']

/** What an operator who never chose gets. */
export const PICKER_DEFAULT_GROUP_BY: PickerGroupBy = 'zone'

/** A stored choice; anything unreadable is the default. */
export function parsePickerGroupBy(raw: unknown): PickerGroupBy {
  return raw === 'zone' || raw === 'location' || raw === 'none' ? raw : PICKER_DEFAULT_GROUP_BY
}

/** One site zone as the picker groups by it. */
export interface PickerZone {
  readonly zoneKey: string
  readonly label: string
  readonly locationKeys: readonly string[]
}

/** The zone read, with whether it ANSWERED (D315). */
export type PickerZonesRead =
  | { readonly state: 'answered'; readonly zones: readonly PickerZone[] }
  | { readonly state: 'pending' }
  | { readonly state: 'failed' }

/** Why Zone mode is grouping by location instead. */
export type PickerZonesFallback = 'pending' | 'failed'

/** The folded key a location label joins a zone by — `siteZoneKey`'s fold. */
export function pickerLocationKey(label: string): string {
  return label.trim().toLowerCase()
}

/** The picker's groups under one "Group by" mode. */
export interface PickerGrouping<Id extends PickerId = number> {
  /** The mode the groups ARE — `location` when Zone could not be honoured. */
  readonly groupBy: PickerGroupBy
  /** Set when Zone mode fell back to location: the zone read had not answered. */
  readonly fallback: PickerZonesFallback | null
  /** One headerless list (None): no group to expand, select or clear. */
  readonly flat: boolean
  readonly groups: readonly PickerGroup<Id>[]
}

/** A "Group by" group while it is being filled. */
interface HeadedBucket<Id extends PickerId> {
  readonly heading: PickerGroupHeading
  /** Where the group sorts: named groups by label, then the "no" groups. */
  readonly rank: number
  readonly devices: PickerItem<Id>[]
}

const NO_ZONE_RANK = 1
const NO_LOCATION_RANK = 2

function byName<Id extends PickerId>(a: PickerItem<Id>, b: PickerItem<Id>): number {
  return a.name.localeCompare(b.name) || compareIds(a.id, b.id)
}

function headingLabel(heading: PickerGroupHeading): string {
  return heading.kind === 'zone' || heading.kind === 'location' ? heading.label : ''
}

/** The bucket a device falls in, and the key it is remembered by. */
interface Placement {
  readonly key: string
  readonly heading: PickerGroupHeading
  readonly rank: number
}

const NO_LOCATION: Placement = {
  key: '-location',
  heading: { kind: 'no-location' },
  rank: NO_LOCATION_RANK,
}
const NO_ZONE: Placement = { key: '-zone', heading: { kind: 'no-zone' }, rank: NO_ZONE_RANK }

/** Every zone by the folded location keys it holds; the first zone wins a key. */
function zoneByLocation(zones: readonly PickerZone[]): ReadonlyMap<string, PickerZone> {
  const out = new Map<string, PickerZone>()
  for (const zone of zones) {
    for (const key of zone.locationKeys) {
      const folded = pickerLocationKey(key)
      if (!out.has(folded)) out.set(folded, zone)
    }
  }
  return out
}

function placeByLocation(location: string | null): Placement {
  if (location === null) return NO_LOCATION
  return {
    key: `l:${pickerLocationKey(location)}`,
    heading: { kind: 'location', label: location.trim() },
    rank: 0,
  }
}

function placeByZone(location: string | null, zones: ReadonlyMap<string, PickerZone>): Placement {
  if (location === null) return NO_LOCATION
  const zone = zones.get(pickerLocationKey(location))
  if (zone === undefined) return NO_ZONE
  return { key: `z:${zone.zoneKey}`, heading: { kind: 'zone', label: zone.label }, rank: 0 }
}

/**
 * Group the list by zone, location or nothing.
 *
 * Zone: a group per site zone that holds a listed device (by label), then
 * "No zone" (a location no zone holds), then "No location". Location: a group
 * per location (folded; named after the first device's trimmed spelling), then "No
 * location". None: one flat list by name, then id.
 *
 * A zone read that is pending or failed can NOT say a location is in no zone
 * (D315), so Zone mode then groups by location and returns the reason as
 * {@link PickerGrouping.fallback} for the UI's one-line note.
 */
export function groupPickerDevicesBy<Id extends PickerId>(
  devices: readonly PickerItem<Id>[],
  selected: readonly Id[],
  groupBy: PickerGroupBy,
  zones: PickerZonesRead,
): PickerGrouping<Id> {
  const picked = new Set<Id>(selected)
  const sorted = [...devices].sort(byName)
  const count = (list: readonly PickerItem<Id>[]): number =>
    list.filter((device) => picked.has(device.id)).length
  if (groupBy === 'none') {
    const group: PickerGroup<Id> = {
      key: 'all',
      type: null,
      location: null,
      devices: sorted,
      selectedCount: count(sorted),
    }
    return { groupBy, fallback: null, flat: true, groups: [group] }
  }
  const fallback: PickerZonesFallback | null =
    groupBy === 'zone' && zones.state !== 'answered' ? zones.state : null
  const effective: PickerGroupBy = fallback === null ? groupBy : 'location'
  const zoneMap =
    zones.state === 'answered' ? zoneByLocation(zones.zones) : new Map<string, PickerZone>()
  const buckets = new Map<string, HeadedBucket<Id>>()
  for (const device of sorted) {
    const location = blankToNull(device.location)
    const place = effective === 'zone' ? placeByZone(location, zoneMap) : placeByLocation(location)
    const bucket = buckets.get(place.key)
    if (bucket === undefined) {
      buckets.set(place.key, { heading: place.heading, rank: place.rank, devices: [device] })
    } else bucket.devices.push(device)
  }
  const ordered = [...buckets].sort(
    ([, a], [, b]) =>
      a.rank - b.rank || headingLabel(a.heading).localeCompare(headingLabel(b.heading)),
  )
  const groups = ordered.map(
    ([key, bucket]): PickerGroup<Id> => ({
      key,
      type: null,
      location: bucket.heading.kind === 'location' ? bucket.heading.label : null,
      devices: bucket.devices,
      selectedCount: count(bucket.devices),
      heading: bucket.heading,
    }),
  )
  return { groupBy: effective, fallback, flat: false, groups }
}

/** The grouping as rows: a flat grouping draws no header and is always open. */
export function flattenPickerGrouping<Id extends PickerId>(
  grouping: PickerGrouping<Id>,
  selected: readonly Id[],
  toggles: ReadonlyMap<string, boolean>,
  searching: boolean,
): readonly PickerRow<Id>[] {
  if (!grouping.flat) return flattenPickerRows(grouping.groups, selected, toggles, searching)
  const picked = new Set<Id>(selected)
  const rows: PickerRow<Id>[] = []
  for (const group of grouping.groups) {
    for (const device of group.devices) {
      rows.push({
        kind: 'device',
        key: `d:${String(device.id)}`,
        device,
        groupKey: group.key,
        selected: picked.has(device.id),
      })
    }
  }
  return rows
}

/**
 * What a row's second line adds under "Group by": the device TYPE (it left the
 * group key), and the room wherever the header does not already say it.
 */
export interface PickerRowFacts {
  readonly location: string | null
  readonly type: string | null
}

export function pickerRowFacts<Id extends PickerId>(
  device: PickerItem<Id>,
  groupBy: PickerGroupBy,
): PickerRowFacts {
  return {
    location: groupBy === 'location' ? null : blankToNull(device.location),
    type: blankToNull(device.type),
  }
}

// ── Filters: Type / Zone / Location + Reset (D697) ───────────────────────────
//
// Filters NARROW the list; "Group by" only arranges it, is remembered, and is not a filter —
// Reset leaves it alone. A Zone filter needs the zones read: while that read has not
// ANSWERED it is suspended (not applied) and the UI says so — an unanswered read cannot say
// a device is in no zone (D315).
//
// The Zone and Location facets are provisional (operator answer Q1): removing the
// Zone/Location facets touches only this section.

/** The filter key of an item with no type / no location / no zone. */
export const PICKER_NONE_KEY = '(none)'

export type PickerFacet = 'type' | 'zone' | 'location'

/** One choosable value of a facet, with how many listed items carry it. */
export interface PickerFacetOption {
  readonly key: string
  /** The type, the location (first trimmed spelling seen), the zone label; null for "(none)". */
  readonly label: string | null
  readonly count: number
}

/** What a picker (or the alarm table) narrows by, applied in this order. */
export interface PickerFilters {
  readonly query: string
  readonly types: readonly string[]
  readonly zones: readonly string[]
  readonly locations: readonly string[]
}

export const PICKER_NO_FILTERS: PickerFilters = { query: '', types: [], zones: [], locations: [] }

/** A facet value as an item carries it: its key, and the label to show (null: none). */
interface FacetValue {
  readonly key: string
  readonly label: string | null
}

const NO_FACET_VALUE: FacetValue = { key: PICKER_NONE_KEY, label: null }

function facetValue<Id extends PickerId>(
  item: PickerItem<Id>,
  facet: PickerFacet,
  zones: PickerZonesRead,
): FacetValue {
  if (facet === 'type') {
    const type = blankToNull(item.type)
    return type === null ? NO_FACET_VALUE : { key: type, label: type }
  }
  const location = blankToNull(item.location)
  if (location === null) return NO_FACET_VALUE
  if (facet === 'location') {
    return { key: pickerLocationKey(location), label: location.trim() }
  }
  if (zones.state !== 'answered') return NO_FACET_VALUE
  const zone = zoneByLocation(zones.zones).get(pickerLocationKey(location))
  return zone === undefined ? NO_FACET_VALUE : { key: zone.zoneKey, label: zone.label }
}

/** The key an item filters by under one facet; `(none)` when it has no such value. */
export function pickerFacetKey<Id extends PickerId>(
  item: PickerItem<Id>,
  facet: PickerFacet,
  zones: PickerZonesRead,
): string {
  return facetValue(item, facet, zones).key
}

function compareFacetOptions(a: PickerFacetOption, b: PickerFacetOption): number {
  if (a.key === PICKER_NONE_KEY || b.key === PICKER_NONE_KEY) {
    return a.key === b.key ? 0 : a.key === PICKER_NONE_KEY ? 1 : -1
  }
  return (a.label ?? '').localeCompare(b.label ?? '')
}

/** Every value of a facet the list holds (plus chosen ones it no longer holds, at 0). */
export function pickerFacetOptions<Id extends PickerId>(
  items: readonly PickerItem<Id>[],
  facet: PickerFacet,
  chosen: readonly string[],
  zones: PickerZonesRead,
): readonly PickerFacetOption[] {
  if (facet === 'zone' && zones.state !== 'answered') return []
  const byKey = new Map<string, { label: string | null; count: number }>()
  for (const item of items) {
    const value = facetValue(item, facet, zones)
    const have = byKey.get(value.key)
    if (have === undefined) byKey.set(value.key, { label: value.label, count: 1 })
    else have.count++
  }
  for (const key of chosen) {
    if (!byKey.has(key)) byKey.set(key, { label: key === PICKER_NONE_KEY ? null : key, count: 0 })
  }
  const options: PickerFacetOption[] = []
  for (const [key, entry] of byKey) options.push({ key, label: entry.label, count: entry.count })
  return options.sort(compareFacetOptions)
}

/** A zone filter is chosen but the zones read has not answered: it is paused, not applied. */
export function pickerZoneFilterSuspended(filters: PickerFilters, zones: PickerZonesRead): boolean {
  return filters.zones.length > 0 && zones.state !== 'answered'
}

function keepFacet<Id extends PickerId>(
  items: readonly PickerItem<Id>[],
  facet: PickerFacet,
  chosen: readonly string[],
  zones: PickerZonesRead,
): readonly PickerItem<Id>[] {
  if (chosen.length === 0) return items
  return items.filter((item) => chosen.includes(pickerFacetKey(item, facet, zones)))
}

/** Search, then Type, Zone (only from an answered read), Location. No filter: the list itself. */
export function applyPickerFilters<Id extends PickerId>(
  items: readonly PickerItem<Id>[],
  filters: PickerFilters,
  zones: PickerZonesRead,
): readonly PickerItem<Id>[] {
  const searched = filterPickerDevices(items, filters.query)
  const typed = keepFacet(searched, 'type', filters.types, zones)
  const zoned = zones.state === 'answered' ? keepFacet(typed, 'zone', filters.zones, zones) : typed
  return keepFacet(zoned, 'location', filters.locations, zones)
}

/** Tick or untick one filter key. */
export function togglePickerKey(chosen: readonly string[], key: string): string[] {
  return chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key]
}

export function pickerFiltersActive(filters: PickerFilters): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.types.length > 0 ||
    filters.zones.length > 0 ||
    filters.locations.length > 0
  )
}

/** Reset clears search, Type, Zone and Location — never "Group by". */
export function resetPickerFilters(): PickerFilters {
  return PICKER_NO_FILTERS
}

/**
 * Selected ids the current filters hide — they stay selected, they are only not listed. Only a
 * LISTED device can be hidden: an id the list does not hold at all (removed, unknown, off-offer)
 * is not "hidden", so it is not counted.
 */
export function pickerHiddenSelectedCount<Id extends PickerId>(
  selected: readonly Id[],
  list: readonly PickerItem<Id>[],
  matches: readonly PickerItem<Id>[],
): number {
  const listed = new Set<Id>(list.map((item) => item.id))
  const shown = new Set<Id>(matches.map((item) => item.id))
  return selected.filter((id) => listed.has(id) && !shown.has(id)).length
}

/** A dropdown is drawn when it can narrow (two values or more) or a key is chosen. */
export function pickerFacetFilterShown(
  options: readonly PickerFacetOption[],
  chosen: readonly string[],
): boolean {
  return options.length >= 2 || chosen.length > 0
}
