/**
 * `deviceManager.search` — the device → value picker's server side.
 *
 * Reuses the two sources that already exist and builds neither again:
 *   - the fleet is `listAll` (slim projection) — one registry, one filter for
 *     which devices the caller sees;
 *   - the values a device can supply for a cap are the `getWireableFields`
 *     derivation (`wireableEntryForDef`), restricted to the device's own
 *     bindings (D12: per-device aggregation walks `getBindings`, never the
 *     global cap list).
 *
 * Everything that costs a read per device (bindings, status) is paid only for
 * what the answer needs: bindings once for the devices that survive the text
 * filter and only when a cap is required, live readings only for the devices
 * actually returned (a page, the suggestions, the resolved ids) — never the
 * fleet.
 */
import type {
  DeviceInfo,
  DeviceSearchFacets,
  DeviceSearchInput,
  DeviceSearchItem,
  DeviceSearchResult,
  DeviceValueOption,
  IScopedLogger,
} from '@camstack/types'
import { DEVICE_SEARCH_DEFAULT_LIMIT, DEVICE_SEARCH_MAX_LIMIT, errMsg } from '@camstack/types'

/** The wireable fields of one capability, as `wireableEntryForDef` derives them. */
export interface SearchCapFields {
  readonly cap: string
  readonly fields: ReadonlyArray<{
    readonly path: string
    readonly item?: boolean
    readonly quantity?: DeviceValueOption['quantity']
  }>
}

/** Everything the search reads, injected so the module owns no registry of its own. */
export interface DeviceSearchDeps {
  /** The caller's fleet (`listAll`, slim). */
  readonly listDevices: () => Promise<readonly DeviceInfo[]>
  /** Capability names bound to each device, wrapper caps already dropped. */
  readonly boundCaps: (
    deviceIds: readonly number[],
  ) => Promise<ReadonlyMap<number, readonly string[]>>
  /** The wireable fields of a cap; `null` when it exposes none (a cap can still make a device compatible). */
  readonly fieldsOf: (cap: string) => SearchCapFields | null
  /** Live status per device id (string key) per cap; a cap that could not be read is `null`. */
  readonly readStatus: (
    deviceIds: readonly number[],
    caps: readonly string[],
  ) => Promise<Readonly<Record<string, Readonly<Record<string, unknown>>>>>
  /** Integration id → display name. */
  readonly integrationLabels: () => Promise<ReadonlyMap<string, string>>
  readonly logger: Pick<IScopedLogger, 'warn'>
}

/** A shortlist, not a second list. */
const SUGGESTED_MAX = 8

interface Candidate {
  readonly device: DeviceInfo
  readonly haystack: string
  readonly integrationId: string | null
  readonly integrationLabel: string | null
  /** Required caps this device holds (empty when nothing is required). */
  matchedCaps: readonly string[]
  compatible: boolean
}

type SortKey = readonly [number, string, string, number]

function sortKeyOf(c: Candidate): SortKey {
  return [c.compatible ? 0 : 1, c.device.type, c.device.name.toLowerCase(), c.device.id]
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (a[0] !== b[0]) return a[0] - b[0]
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1
  return a[3] - b[3]
}

function encodeCursor(key: SortKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): SortKey | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 4) return null
    const c: unknown = parsed[0]
    const t: unknown = parsed[1]
    const n: unknown = parsed[2]
    const i: unknown = parsed[3]
    if (typeof c !== 'number' || typeof t !== 'string' || typeof n !== 'string') return null
    if (typeof i !== 'number') return null
    return [c, t, n, i]
  } catch {
    return null
  }
}

/** `colourTemperature` / `battery_level` → `Colour temperature` / `Battery level`. */
function labelOfPath(path: string): string {
  const last = path.split('.').pop() ?? path
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
  return words.length === 0 ? path : words.charAt(0).toUpperCase() + words.slice(1)
}

function readAtPath(status: unknown, path: string): string | null {
  let cursor: unknown = status
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return null
    cursor = Reflect.get(cursor, segment)
  }
  if (typeof cursor === 'string') return cursor
  if (typeof cursor === 'number' || typeof cursor === 'boolean') return String(cursor)
  return null
}

function matches(selected: readonly string[] | undefined, value: string | null): boolean {
  if (selected === undefined || selected.length === 0) return true
  return value !== null && selected.includes(value)
}

function facetList(counts: ReadonlyMap<string, number>): Array<{ value: string; count: number }> {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
}

function bump(counts: Map<string, number>, key: string | null): void {
  if (key === null) return
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

export async function searchDevices(
  deps: DeviceSearchDeps,
  input: DeviceSearchInput,
): Promise<DeviceSearchResult> {
  const [fleet, labels] = await Promise.all([deps.listDevices(), deps.integrationLabels()])
  const requiredCaps = input.requires?.caps ?? []
  const mode = input.requires?.mode ?? 'any'

  const candidates = fleet.map((device): Candidate => {
    const integrationId = device.integrationId ?? null
    const integrationLabel = integrationId === null ? null : (labels.get(integrationId) ?? null)
    return {
      device,
      integrationId,
      integrationLabel,
      haystack: [
        device.name,
        device.location ?? '',
        device.type,
        integrationId ?? '',
        integrationLabel ?? '',
        String(device.id),
      ]
        .join('\u0000')
        .toLowerCase(),
      matchedCaps: [],
      compatible: requiredCaps.length === 0,
    }
  })

  if (input.ids !== undefined) {
    return resolveIds(deps, input, candidates)
  }

  const needle = (input.text ?? '').trim().toLowerCase()
  const textPass =
    needle === '' ? candidates : candidates.filter((c) => c.haystack.includes(needle))

  if (requiredCaps.length > 0) {
    const bound = await deps.boundCaps(textPass.map((c) => c.device.id))
    for (const c of textPass) {
      const have = new Set(bound.get(c.device.id) ?? [])
      const matched = requiredCaps.filter((cap) => have.has(cap))
      c.matchedCaps = matched
      c.compatible = mode === 'all' ? matched.length === requiredCaps.length : matched.length > 0
    }
  }

  // Faceted search: each facet is counted over the compatible set with the
  // OTHER two facets applied, so choosing a location never zeroes the other
  // locations' counts.
  const locationCounts = new Map<string, number>()
  const integrationCounts = new Map<string, number>()
  const typeCounts = new Map<string, number>()
  const listed: Candidate[] = []
  let compatibleTotal = 0
  let hiddenIncompatible = 0
  const filters = input.filters
  for (const c of textPass) {
    const okLocation = matches(filters?.locations, c.device.location)
    const okIntegration = matches(filters?.integrationIds, c.integrationId)
    const okType = matches(filters?.types, c.device.type)
    if (c.compatible) {
      if (okIntegration && okType) bump(locationCounts, c.device.location)
      if (okLocation && okType) bump(integrationCounts, c.integrationId)
      if (okLocation && okIntegration) bump(typeCounts, c.device.type)
    }
    if (!(okLocation && okIntegration && okType)) continue
    if (c.compatible) {
      compatibleTotal += 1
      listed.push(c)
    } else {
      hiddenIncompatible += 1
      if (input.includeIncompatible === true) listed.push(c)
    }
  }

  const keyed = listed
    .map((c) => ({ c, key: sortKeyOf(c) }))
    .sort((a, b) => compareKeys(a.key, b.key))
  const limit = Math.min(input.limit ?? DEVICE_SEARCH_DEFAULT_LIMIT, DEVICE_SEARCH_MAX_LIMIT)
  let start = 0
  if (input.cursor !== undefined && input.cursor !== null) {
    const after = decodeCursor(input.cursor)
    if (after === null) {
      // An undecodable cursor restarts the list rather than failing a picker
      // mid-scroll; said out loud so a client sending garbage can be found.
      deps.logger.warn('deviceManager.search: undecodable cursor — restarting from the first page')
    } else {
      const next = keyed.findIndex((k) => compareKeys(k.key, after) > 0)
      start = next === -1 ? keyed.length : next
    }
  }
  const page = keyed.slice(start, start + limit).map((k) => k.c)
  const last = keyed[start + limit - 1]
  const nextCursor =
    start + limit < keyed.length && last !== undefined ? encodeCursor(last.key) : null

  const firstPage = start === 0
  const suggestedCandidates = firstPage ? suggestFor(input, keyed, fleet) : []

  const items = await withValues(deps, [...page, ...suggestedCandidates], requiredCaps)
  const byId = new Map(items.map((i) => [i.id, i]))

  const facets: DeviceSearchFacets = {
    locations: facetList(locationCounts),
    integrations: [...integrationCounts.entries()]
      .map(([id, count]) => ({ id, label: labels.get(id) ?? id, count }))
      .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    types: facetList(typeCounts),
  }

  return {
    items: page.map((c) => byId.get(c.device.id)).filter(isItem),
    nextCursor,
    total: listed.length,
    compatibleTotal,
    fleetTotal: fleet.length,
    hiddenIncompatible,
    facets,
    suggested: suggestedCandidates.map((c) => byId.get(c.device.id)).filter(isItem),
    missingIds: [],
  }
}

function isItem(value: DeviceSearchItem | undefined): value is DeviceSearchItem {
  return value !== undefined
}

/** Compatible devices at the context device's location, in list order. */
function suggestFor(
  input: DeviceSearchInput,
  keyed: ReadonlyArray<{ c: Candidate }>,
  fleet: readonly DeviceInfo[],
): Candidate[] {
  if (input.contextDeviceId === undefined) return []
  const context = fleet.find((d) => d.id === input.contextDeviceId)
  if (context === undefined || context.location === null) return []
  return keyed
    .map((k) => k.c)
    .filter(
      (c) => c.compatible && c.device.location === context.location && c.device.id !== context.id,
    )
    .slice(0, SUGGESTED_MAX)
}

async function resolveIds(
  deps: DeviceSearchDeps,
  input: DeviceSearchInput,
  candidates: readonly Candidate[],
): Promise<DeviceSearchResult> {
  const requiredCaps = input.requires?.caps ?? []
  const mode = input.requires?.mode ?? 'any'
  const byId = new Map(candidates.map((c) => [c.device.id, c]))
  const asked = [...new Set(input.ids ?? [])]
  const found: Candidate[] = []
  const missingIds: number[] = []
  for (const id of asked) {
    const c = byId.get(id)
    if (c === undefined) missingIds.push(id)
    else found.push(c)
  }
  if (requiredCaps.length > 0 && found.length > 0) {
    const bound = await deps.boundCaps(found.map((c) => c.device.id))
    for (const c of found) {
      const have = new Set(bound.get(c.device.id) ?? [])
      c.matchedCaps = requiredCaps.filter((cap) => have.has(cap))
      c.compatible =
        mode === 'all' ? c.matchedCaps.length === requiredCaps.length : c.matchedCaps.length > 0
    }
  }
  const items = await withValues(deps, found, requiredCaps)
  return {
    items,
    nextCursor: null,
    total: items.length,
    compatibleTotal: found.filter((c) => c.compatible).length,
    fleetTotal: candidates.length,
    hiddenIncompatible: found.filter((c) => !c.compatible).length,
    facets: { locations: [], integrations: [], types: [] },
    suggested: [],
    missingIds,
  }
}

/**
 * Build the wire items for a set of candidates, reading live status once for
 * the whole set. A failed read is `reading: null` on that value — the device
 * and its values stay listed.
 */
async function withValues(
  deps: DeviceSearchDeps,
  candidates: readonly Candidate[],
  requiredCaps: readonly string[],
): Promise<DeviceSearchItem[]> {
  const unique = [...new Map(candidates.map((c) => [c.device.id, c])).values()]
  let status: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {}
  const needStatus =
    requiredCaps.length > 0 && unique.some((c) => c.compatible && c.matchedCaps.length > 0)
  if (needStatus) {
    try {
      status = await deps.readStatus(
        unique.filter((c) => c.compatible && c.matchedCaps.length > 0).map((c) => c.device.id),
        requiredCaps,
      )
    } catch (err: unknown) {
      deps.logger.warn('deviceManager.search: status read failed — readings left empty', {
        meta: { error: errMsg(err), devices: unique.length },
      })
    }
  }
  return unique.map((c): DeviceSearchItem => {
    const values: DeviceValueOption[] = []
    for (const cap of c.compatible ? c.matchedCaps : []) {
      const fields = deps.fieldsOf(cap)
      if (fields === null) continue
      const capStatus = status[String(c.device.id)]?.[cap]
      for (const f of fields.fields) {
        if (f.item === true) continue
        values.push({
          cap,
          path: f.path,
          label: labelOfPath(f.path),
          reading: readAtPath(capStatus, f.path),
          unit: null,
          ...(f.quantity !== undefined ? { quantity: f.quantity } : {}),
        })
      }
    }
    const d = c.device
    return {
      id: d.id,
      name: d.name,
      type: d.type,
      location: d.location,
      integrationId: c.integrationId,
      integrationLabel: c.integrationLabel,
      online: d.online,
      disabled: d.disabled,
      compatible: c.compatible,
      values,
    }
  })
}
