/**
 * The device → value picker's model: selection, grouping, labels and states.
 *
 * Pure and framework-free — no React, no DOM, no web-only import — so the
 * viewer can copy the file next to its own sheet (it joins
 * `check-device-selection-in-sync` when that copy exists). Everything the
 * component decides that is not drawing lives here and is specced here.
 *
 * Rules it carries (plan "Behaviour"):
 *  - a device with ONE matching value is picked by picking the row; a device
 *    with several opens a second level;
 *  - a picked value renders as `device › value`, the value name only when the
 *    device had several; never a location, never the node;
 *  - a query that FAILED is not an empty answer (D315);
 *  - a picked device the hub does not have stays in the value (D49).
 */
import type {
  DeviceSearchFilters,
  DeviceSearchItem,
  DeviceSearchResult,
  DeviceValueOption,
} from '@camstack/types'

/** One picked value. `cap`/`path` are absent when the field wants only a device. */
export interface PickedValue {
  readonly deviceId: number
  readonly cap?: string
  readonly path?: string
}

/** How a picked row behaves: a device (or its single value) or a drill into several values. */
export type RowMode = 'pick' | 'drill'

/** Chips shown before "+N". */
export const CHIP_LIMIT = 5

export function valueKey(v: PickedValue): string {
  return `${v.deviceId}|${v.cap ?? ''}|${v.path ?? ''}`
}

export function sameValue(a: PickedValue, b: PickedValue): boolean {
  return valueKey(a) === valueKey(b)
}

/** A device-only field: values are shown but a row picks the whole device. */
export type PickKind = 'value' | 'device'

/**
 * `drill` when the device has several matching values AND the field wants a
 * value; everything else is picked straight from the row.
 */
export function rowMode(item: DeviceSearchItem, kind: PickKind): RowMode {
  return kind === 'value' && item.values.length > 1 ? 'drill' : 'pick'
}

/** What picking the row itself selects (never called for a `drill` row). */
export function pickFromRow(item: DeviceSearchItem, kind: PickKind): PickedValue {
  const only = kind === 'value' && item.values.length === 1 ? item.values[0] : undefined
  return only === undefined
    ? { deviceId: item.id }
    : { deviceId: item.id, cap: only.cap, path: only.path }
}

export function pickFromOption(item: DeviceSearchItem, option: DeviceValueOption): PickedValue {
  return { deviceId: item.id, cap: option.cap, path: option.path }
}

export function isPicked(picked: readonly PickedValue[], candidate: PickedValue): boolean {
  return picked.some((p) => sameValue(p, candidate))
}

/** How many of a device's values are picked (the badge on a drill row in multi). */
export function pickedCountOfDevice(picked: readonly PickedValue[], deviceId: number): number {
  return picked.filter((p) => p.deviceId === deviceId).length
}

/** Add the value when absent, drop it when present; never mutates. */
export function toggleValue(
  picked: readonly PickedValue[],
  candidate: PickedValue,
  maxItems?: number,
): readonly PickedValue[] {
  if (isPicked(picked, candidate)) return picked.filter((p) => !sameValue(p, candidate))
  if (maxItems !== undefined && picked.length >= maxItems) return picked
  return [...picked, candidate]
}

export function removeValue(
  picked: readonly PickedValue[],
  candidate: PickedValue,
): readonly PickedValue[] {
  return picked.filter((p) => !sameValue(p, candidate))
}

/** Chips: the first `limit`, and how many collapse into "+N". */
export function splitChips<T>(
  chips: readonly T[],
  limit: number = CHIP_LIMIT,
): { readonly shown: readonly T[]; readonly hidden: number } {
  return chips.length <= limit
    ? { shown: chips, hidden: 0 }
    : { shown: chips.slice(0, limit), hidden: chips.length - limit }
}

// ─── picked values, described ───────────────────────────────────────────

/** `ok`; `gone`: the hub has no such device; `offline`: it has, and it is unreachable. */
export type PickedStatus = 'ok' | 'gone' | 'offline'

export interface PickedDescription {
  readonly deviceId: number
  /** The device's name, or null when it is gone. */
  readonly deviceName: string | null
  /** The value's name — only when the device offers several, else null. */
  readonly valueName: string | null
  /** The live reading; null when unknown or not read (never 0). */
  readonly reading: string | null
  readonly status: PickedStatus
}

/**
 * Describe a picked value against the resolved item. `item` is `undefined`
 * while unresolved or when the device is gone — `missing` tells which: a
 * device is `gone` only when the answered resolve listed its id as missing
 * (D315: not-yet-known never looks like deleted).
 */
export function describePicked(
  picked: PickedValue,
  item: DeviceSearchItem | undefined,
  missing: ReadonlySet<number>,
): PickedDescription {
  if (item === undefined) {
    return {
      deviceId: picked.deviceId,
      deviceName: null,
      valueName: null,
      reading: null,
      status: missing.has(picked.deviceId) ? 'gone' : 'ok',
    }
  }
  const option =
    picked.cap === undefined
      ? undefined
      : item.values.find((v) => v.cap === picked.cap && v.path === picked.path)
  const wantsValueName = option !== undefined && item.values.length > 1
  const sole = item.values.length === 1 ? item.values[0] : undefined
  return {
    deviceId: picked.deviceId,
    deviceName: item.name,
    valueName: wantsValueName ? option.label : null,
    reading: (option ?? sole)?.reading ?? null,
    status: item.online === false ? 'offline' : 'ok',
  }
}

/** Resolve-by-ids answer → lookups for {@link describePicked}. */
export function indexResolved(result: DeviceSearchResult | undefined): {
  readonly byId: ReadonlyMap<number, DeviceSearchItem>
  readonly missing: ReadonlySet<number>
} {
  return {
    byId: new Map((result?.items ?? []).map((i) => [i.id, i])),
    missing: new Set(result?.missingIds ?? []),
  }
}

// ─── facets ─────────────────────────────────────────────────────────────

/** The three generic facets, in rail order. */
export const FACET_KEYS = ['locations', 'integrationIds', 'types'] as const
export type FacetKey = (typeof FACET_KEYS)[number]

export type FacetSelection = Readonly<Record<FacetKey, readonly string[]>>

export const NO_FACETS: FacetSelection = { locations: [], integrationIds: [], types: [] }

export function hasFacets(selection: FacetSelection): boolean {
  return FACET_KEYS.some((k) => selection[k].length > 0)
}

export function toggleFacet(
  selection: FacetSelection,
  key: FacetKey,
  value: string,
): FacetSelection {
  const current = selection[key]
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
  return { ...selection, [key]: next }
}

/** The server filter: the field's fixed `types` narrowed by the operator's type choice. */
export function toSearchFilters(
  selection: FacetSelection,
  fixedTypes?: readonly string[],
): DeviceSearchFilters | undefined {
  const chosenTypes = selection.types
  const types =
    fixedTypes === undefined || fixedTypes.length === 0
      ? chosenTypes
      : chosenTypes.length === 0
        ? fixedTypes
        : chosenTypes.filter((t) => fixedTypes.includes(t))
  const out: {
    locations?: readonly string[]
    integrationIds?: readonly string[]
    types?: readonly string[]
  } = {}
  if (selection.locations.length > 0) out.locations = selection.locations
  if (selection.integrationIds.length > 0) out.integrationIds = selection.integrationIds
  if (types.length > 0) out.types = types
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * What a collapsed facet header shows next to its name: "any", the one
 * choice, or "first +N". `labelOf` maps a raw value to its label.
 */
export function facetSummary(
  chosen: readonly string[],
  any: string,
  labelOf: (value: string) => string = (v) => v,
): string {
  if (chosen.length === 0) return any
  const first = labelOf(chosen[0] ?? '')
  return chosen.length === 1 ? first : `${first} +${chosen.length - 1}`
}

/** A facet's visible options: the top `limit` by count, and how many remain. */
export function topFacetOptions<T extends { readonly count: number }>(
  options: readonly T[],
  limit: number,
  expanded: boolean,
): { readonly shown: readonly T[]; readonly more: number } {
  const sorted = [...options].sort((a, b) => b.count - a.count)
  return expanded || sorted.length <= limit
    ? { shown: sorted, more: 0 }
    : { shown: sorted.slice(0, limit), more: sorted.length - limit }
}

// ─── list: suggestions, recents, grouping ───────────────────────────────

export interface ListSection {
  readonly id: string
  /** `suggested` / `recent` carry a fixed heading; `type` sections are headed by the raw type. */
  readonly kind: 'suggested' | 'recent' | 'type'
  readonly heading: string | null
  readonly items: readonly DeviceSearchItem[]
}

/**
 * Suggestions first (same location as the context device), then recents of
 * this field, then the server's order (type, then name) grouped by type. A
 * device is listed once: in the first section that holds it. Suggestions and
 * recents appear only when no text is typed and nothing is filtered — a
 * search is an answer, not a shortlist.
 */
export function buildSections(input: {
  readonly items: readonly DeviceSearchItem[]
  readonly suggested: readonly DeviceSearchItem[]
  readonly recent: readonly DeviceSearchItem[]
  readonly shortlist: boolean
}): readonly ListSection[] {
  const seen = new Set<number>()
  const take = (list: readonly DeviceSearchItem[]) =>
    list.filter((i) => {
      if (seen.has(i.id)) return false
      seen.add(i.id)
      return true
    })
  const sections: ListSection[] = []
  if (input.shortlist) {
    const suggested = take(input.suggested)
    if (suggested.length > 0) {
      sections.push({ id: 'suggested', kind: 'suggested', heading: null, items: suggested })
    }
    const recent = take(input.recent)
    if (recent.length > 0)
      sections.push({ id: 'recent', kind: 'recent', heading: null, items: recent })
  }
  for (const item of take(input.items)) {
    const last = sections[sections.length - 1]
    if (last !== undefined && last.kind === 'type' && last.heading === item.type) {
      sections[sections.length - 1] = { ...last, items: [...last.items, item] }
    } else {
      sections.push({
        id: `type:${item.type}:${item.id}`,
        kind: 'type',
        heading: item.type,
        items: [item],
      })
    }
  }
  return sections
}

/** Merge pages, dropping a device an earlier page already listed. */
export function mergePages(
  pages: readonly { readonly items: readonly DeviceSearchItem[] }[],
): readonly DeviceSearchItem[] {
  const seen = new Set<number>()
  const out: DeviceSearchItem[] = []
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      out.push(item)
    }
  }
  return out
}

// ─── states ─────────────────────────────────────────────────────────────

export type PickerState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  /** Nothing in the fleet is compatible with the required capability. */
  | { readonly kind: 'empty' }
  /** Compatible devices exist, text or facets leave none. */
  | { readonly kind: 'search-miss' }
  | { readonly kind: 'ready' }

/**
 * Loading, failed, empty and search-miss are four different answers
 * (D315). `empty` is claimed only from an ANSWERED query with no compatible
 * device and no narrowing; a narrowing that leaves nothing is `search-miss`.
 */
export function derivePickerState(input: {
  readonly isPending: boolean
  readonly isError: boolean
  readonly result: DeviceSearchResult | undefined
  readonly itemCount: number
  readonly narrowed: boolean
}): PickerState {
  if (input.isError && input.result === undefined) return { kind: 'failed' }
  if (input.isPending || input.result === undefined) return { kind: 'loading' }
  if (input.itemCount > 0) return { kind: 'ready' }
  return input.narrowed ? { kind: 'search-miss' } : { kind: 'empty' }
}

/** Client-side exclusions the server query cannot express (the host device, containers). */
export function excludeItems(
  items: readonly DeviceSearchItem[],
  exclude: { readonly ids?: readonly number[]; readonly types?: readonly string[] },
): readonly DeviceSearchItem[] {
  const ids = exclude.ids ?? []
  const types = exclude.types ?? []
  if (ids.length === 0 && types.length === 0) return items
  return items.filter((i) => !ids.includes(i.id) && !types.includes(i.type))
}

// ─── recents ────────────────────────────────────────────────────────────

export const RECENT_LIMIT = 5

/** Most recent first, once each, capped. */
export function pushRecent(recent: readonly number[], deviceId: number): readonly number[] {
  return [deviceId, ...recent.filter((id) => id !== deviceId)].slice(0, RECENT_LIMIT)
}

// ─── form fields (device ids as strings) ────────────────────────────────

/** A schema form stores device ids as strings; the picker speaks {@link PickedValue}. */
export function pickedFromDeviceIdString(raw: unknown): PickedValue | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const id = Number(raw)
  return raw === '' || !Number.isInteger(id) ? null : { deviceId: id }
}

export function pickedFromDeviceIdStrings(raw: unknown): readonly PickedValue[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((r) => {
    const v = pickedFromDeviceIdString(r)
    return v === null ? [] : [v]
  })
}

/** Back to the stored shape: ids as strings, each device once. */
export function deviceIdStrings(picked: readonly PickedValue[]): string[] {
  return [...new Set(picked.map((p) => String(p.deviceId)))]
}
