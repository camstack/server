/**
 * Bulk selection for the device-export table (D875): choose by role and by
 * provider, then select or deselect everything the filters leave on screen.
 *
 * Pure functions, so the rules are pinned without a DOM. Nothing here hides a
 * device by default: an empty filter keeps every row (the operator's table is
 * the only filter, D869).
 */
import type { MultiSelectOption } from './device-list/multi-select'

/** The slice of a device row the bulk filters read. */
export interface ExportFilterable {
  readonly id: number
  readonly addonId: string
  readonly role?: string | null
}

export interface ExportBulkFilters {
  /** Keep rows whose role is one of these; empty = no role filter. */
  readonly roles: readonly string[]
  /** Keep rows whose provider addon is one of these; empty = no provider filter. */
  readonly providers: readonly string[]
}

/** The role filter value of a row that has no role. */
export const NO_ROLE_FILTER_ID = '(none)'

export const NO_EXPORT_FILTERS: ExportBulkFilters = { roles: [], providers: [] }

export function roleFilterId(device: ExportFilterable): string {
  const role = device.role
  return role === null || role === undefined || role === '' ? NO_ROLE_FILTER_ID : role
}

/** The rows the role / provider filters leave. */
export function applyExportFilters<T extends ExportFilterable>(
  devices: readonly T[],
  filters: ExportBulkFilters,
): readonly T[] {
  const roles = new Set(filters.roles)
  const providers = new Set(filters.providers)
  return devices.filter(
    (d) =>
      (roles.size === 0 || roles.has(roleFilterId(d))) &&
      (providers.size === 0 || providers.has(d.addonId)),
  )
}

function distinctOptions(values: readonly string[]): readonly MultiSelectOption[] {
  return [...new Set(values)].toSorted().map((id) => ({ id, label: id }))
}

/** Distinct roles present among the rows (a roleless row counts as "(none)"). */
export function roleFilterOptions(
  devices: readonly ExportFilterable[],
): readonly MultiSelectOption[] {
  return distinctOptions(devices.map(roleFilterId))
}

/** Distinct provider addons present among the rows. */
export function providerFilterOptions(
  devices: readonly ExportFilterable[],
): readonly MultiSelectOption[] {
  return distinctOptions(devices.map((d) => d.addonId))
}

/** `current` plus every shown row. */
export function selectShown(
  current: ReadonlySet<string>,
  shown: readonly ExportFilterable[],
): ReadonlySet<string> {
  return new Set([...current, ...shown.map((d) => String(d.id))])
}

/** `current` minus every shown row; selections outside the filter are kept. */
export function deselectShown(
  current: ReadonlySet<string>,
  shown: readonly ExportFilterable[],
): ReadonlySet<string> {
  const drop = new Set(shown.map((d) => String(d.id)))
  return new Set([...current].filter((id) => !drop.has(id)))
}
