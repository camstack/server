import {
  type ConfigOption,
  type DeviceSelectFilter,
  DeviceType,
  resolveContainerPrimaryChild,
} from '@camstack/types'

/**
 * Pure, render-free helpers backing the `device-select` / `device-multiselect`
 * form fields. The field declares only a {@link DeviceSelectFilter}; the
 * renderer fetches EVERY system device via `deviceManager.listAll` and narrows
 * the list CLIENT-SIDE with these functions — there is no server-computed
 * option list.
 *
 * Kept separate from the React component so the match/label/search logic is
 * unit-testable without mounting a tree or mocking tRPC.
 */

/**
 * The minimal projection of a `deviceManager.listAll` row these helpers read.
 * A structural subset of `DeviceInfo` so a stubbed device (in a test) or the
 * full wire shape both satisfy it.
 */
export interface DeviceSelectCandidate {
  readonly id: number
  readonly type: string
  readonly name: string
  readonly location?: string | null
  readonly features?: readonly string[]
  /** Name of the container this device lives in, when it has one. */
  readonly parentName?: string | null
}

/** A picker option that still knows where its device is. */
export interface DeviceOption extends ConfigOption {
  readonly location: string | null
}

/** True when two string lists share at least one member. */
function intersects(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  const set = new Set(a)
  return b.some((v) => set.has(v))
}

/**
 * Does a device satisfy the filter?
 *
 * Union match: with an empty/absent filter every device passes; otherwise the
 * device passes when ANY provided clause matches — its `features` intersect
 * `caps`, OR its `type` is in `types`. `excludeDeviceId` is subtracted last
 * (it always drops the device regardless of the other clauses).
 */
export function deviceMatchesFilter(
  device: DeviceSelectCandidate,
  filter?: DeviceSelectFilter,
): boolean {
  if (filter?.excludeDeviceId !== undefined && device.id === filter.excludeDeviceId) return false
  if (filter?.excludeTypes !== undefined && filter.excludeTypes.includes(device.type)) return false
  const hasCaps = filter?.caps !== undefined && filter.caps.length > 0
  const hasTypes = filter?.types !== undefined && filter.types.length > 0
  // No positive clause → match everything (still honouring excludeDeviceId).
  if (!hasCaps && !hasTypes) return true
  if (hasCaps && intersects(device.features ?? [], filter!.caps!)) return true
  if (hasTypes && filter!.types!.includes(device.type)) return true
  return false
}

/** Human label for a device option: `Name (Location)` when a location is set. */
export function deviceOptionLabel(device: DeviceSelectCandidate): string {
  return typeof device.location === 'string' && device.location.length > 0
    ? `${device.name} (${device.location})`
    : device.name
}

/**
 * Filter a device list and project it into sorted `{ value, label }` options
 * (value = the device id as a string). Sorted case-insensitively by label so
 * the picker order is stable.
 */
/** `Location · type · in Container` — the parts a name alone does not say. */
export function deviceOptionDescription(device: DeviceSelectCandidate): string {
  const parts: string[] = []
  if (typeof device.location === 'string' && device.location.length > 0) parts.push(device.location)
  parts.push(device.type)
  if (typeof device.parentName === 'string' && device.parentName.length > 0) {
    parts.push(`in ${device.parentName}`)
  }
  return parts.join(' · ')
}

export function devicesToOptions(
  devices: readonly DeviceSelectCandidate[],
  filter?: DeviceSelectFilter,
): DeviceOption[] {
  return devices
    .filter((d) => deviceMatchesFilter(d, filter))
    .map(
      (d): DeviceOption => ({
        value: String(d.id),
        label: deviceOptionLabel(d),
        description: deviceOptionDescription(d),
        location: typeof d.location === 'string' && d.location.length > 0 ? d.location : null,
      }),
    )
    .toSorted((a, b) => a.label.localeCompare(b.label))
}

export interface DeviceFacets {
  readonly locations: readonly string[]
  readonly types: readonly string[]
}

/** The distinct locations and types on offer — the chips above the search. */
export function deviceFacets(devices: readonly DeviceSelectCandidate[]): DeviceFacets {
  const locations = new Set<string>()
  const types = new Set<string>()
  for (const d of devices) {
    if (typeof d.location === 'string' && d.location.length > 0) locations.add(d.location)
    types.add(d.type)
  }
  return {
    locations: [...locations].toSorted((a, b) => a.localeCompare(b)),
    types: [...types].toSorted((a, b) => a.localeCompare(b)),
  }
}

/** Each facet is a SET of chosen values: any of them matches, none = all. */
export interface FacetSelection {
  readonly locations: readonly string[]
  readonly types: readonly string[]
}

export const NO_FACETS: FacetSelection = { locations: [], types: [] }

/** Every facet with a choice must match one of its values. */
export function matchesFacets(device: DeviceSelectCandidate, facets: FacetSelection): boolean {
  if (facets.locations.length > 0) {
    if (typeof device.location !== 'string' || !facets.locations.includes(device.location)) {
      return false
    }
  }
  if (facets.types.length > 0 && !facets.types.includes(device.type)) return false
  return true
}

export interface SuggestedPartition<T> {
  readonly suggested: readonly T[]
  readonly others: readonly T[]
}

/**
 * Split `items` into the suggested ones (first, in their order) and the rest.
 * Suggested is a presentation, never a pick: nothing here selects anything
 * (D356).
 */
export function partitionSuggested<T>(
  items: readonly T[],
  suggested: ReadonlySet<number>,
  idOf: (item: T) => number,
): SuggestedPartition<T> {
  return {
    suggested: items.filter((item) => suggested.has(idOf(item))),
    others: items.filter((item) => !suggested.has(idOf(item))),
  }
}

/**
 * The fleet row {@link sameLocationSuggestions} reads. Every field is a column
 * of the `slim` `listAll` projection, so no caller needs a wider read.
 */
export interface SuggestionFleetDevice {
  readonly id: number
  readonly type: string
  readonly name: string
  readonly stableId: string
  readonly location?: string | null
  readonly parentDeviceId?: number | null
  /** A container's stored primary-child pick (the child's `stableId`). */
  readonly primaryChildEntityId?: string | null
  readonly role?: string | null
}

function hasLocation(device: SuggestionFleetDevice, location: string): boolean {
  return device.location === location
}

/** The child a container stands for — the shared resolver, keyed as the server keys it. */
function primaryChildId(
  container: SuggestionFleetDevice,
  children: readonly SuggestionFleetDevice[],
): number | null {
  const primary = resolveContainerPrimaryChild(
    children.map((c) => ({
      id: c.id,
      stableId: c.stableId,
      type: c.type,
      ...(c.role !== undefined && c.role !== null ? { role: c.role } : {}),
      name: c.name,
    })),
    container.primaryChildEntityId,
    container.name,
  )
  return primary === null ? null : primary.id
}

/**
 * Which devices are SUGGESTED to a device in `location` — the one rule every
 * picker that suggests by room applies (D356, D749):
 *
 *  - a device sharing the location is suggested;
 *  - a CONTAINER is never suggested itself. A container family that is in the
 *    location (the container or any of its children) contributes ONE device:
 *    the child the container stands for — the operator's stored pick, else
 *    the automatic one (`resolveContainerPrimaryChild`, role → namesake →
 *    type). Its other children are not suggested; they stay pickable.
 *  - a container with no child (nothing to stand for) contributes nothing.
 *
 * Validity for the card (kind, capability, already assigned, the host itself)
 * is the CALLER's filter: intersect, never widen.
 */
export function sameLocationSuggestions(
  fleet: readonly SuggestionFleetDevice[],
  location: string | null | undefined,
): ReadonlySet<number> {
  if (location === null || location === undefined || location.length === 0) return new Set()
  const byId = new Map(fleet.map((d) => [d.id, d]))
  const childrenOf = new Map<number, SuggestionFleetDevice[]>()
  for (const d of fleet) {
    if (d.parentDeviceId === null || d.parentDeviceId === undefined) continue
    childrenOf.set(d.parentDeviceId, [...(childrenOf.get(d.parentDeviceId) ?? []), d])
  }
  const isContainer = (d: SuggestionFleetDevice | undefined): boolean =>
    d !== undefined && d.type === DeviceType.Container
  const containersInRoom = new Set<number>()
  const out = new Set<number>()
  for (const d of fleet) {
    if (isContainer(d)) {
      if (hasLocation(d, location)) containersInRoom.add(d.id)
      continue
    }
    if (!hasLocation(d, location)) continue
    const parent =
      d.parentDeviceId === null || d.parentDeviceId === undefined
        ? undefined
        : byId.get(d.parentDeviceId)
    if (parent !== undefined && isContainer(parent)) containersInRoom.add(parent.id)
    else out.add(d.id)
  }
  for (const containerId of containersInRoom) {
    const container = byId.get(containerId)
    if (container === undefined) continue
    const primary = primaryChildId(container, childrenOf.get(containerId) ?? [])
    // A container-of-containers is not a suggestion either.
    if (primary !== null && !isContainer(byId.get(primary))) out.add(primary)
  }
  return out
}

/**
 * Free-text option filter — case-insensitive AND over whitespace tokens, each
 * matched against the option's `value` + `label` (so a device is found by name,
 * id, or location). An empty query returns every option in order.
 */
export function filterDeviceOptions<T extends ConfigOption>(
  options: readonly T[],
  query: string,
): T[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return [...options]
  return options.filter((opt) => {
    const hay = `${opt.value} ${opt.label} ${opt.description ?? ''}`.toLowerCase()
    return tokens.every((t) => hay.includes(t))
  })
}

/**
 * Resolve the currently-selected values into options IN SELECTION ORDER (so
 * chips stay stable while searching). A selected value with no matching option
 * becomes a synthetic `{ value, label: value }` — a stale id still shows as a
 * removable chip rather than silently vanishing.
 */
export function selectedDeviceOptions(
  options: readonly ConfigOption[],
  selected: readonly string[],
): ConfigOption[] {
  const byValue = new Map(options.map((o) => [o.value, o]))
  return selected.map((v) => byValue.get(v) ?? { value: v, label: v })
}
