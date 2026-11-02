/**
 * Bulk selection for the device-export table (D875): choose by role and by
 * provider, then select or deselect everything the filters leave on screen.
 *
 * Pure functions, so the rules are pinned without a DOM. Nothing here hides a
 * device by default: an empty filter keeps every row (the operator's table is
 * the only filter, D869).
 */
import type { MultiSelectOption } from './device-list/multi-select'
import {
  deviceIntegrationResolver,
  type DeviceIntegrationRef,
} from './device-list/device-integration'

/** The slice of a device row the bulk filters read. */
export interface ExportFilterable {
  readonly id: number
  readonly addonId: string
  readonly role?: string | null
  /** The integration that created the device (`integrations.list` `id`). */
  readonly integrationId?: string | null
}

/** The slice of an `integrations.list` row the provider filter reads. */
export interface ExportIntegration extends DeviceIntegrationRef {
  readonly name: string
}

/** The provider filter value of a device no registered integration claims. */
const UNREGISTERED_PREFIX = 'addon:'

/**
 * The provider filter value of a row: the id of the integration it belongs to,
 * or `addon:<addonId>` when no registered integration claims it (or the list
 * has not answered). The raw id is never shown — `providerFilterOptions` names it.
 */
export function providerFilterId(
  device: ExportFilterable,
  integrations: readonly ExportIntegration[] | null | undefined,
): string {
  const resolved = deviceIntegrationResolver(integrations)(device)
  return resolved.kind === 'resolved'
    ? resolved.integration.id
    : `${UNREGISTERED_PREFIX}${device.addonId}`
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
  integrations?: readonly ExportIntegration[] | null,
): readonly T[] {
  const roles = new Set(filters.roles)
  const providers = new Set(filters.providers)
  return devices.filter(
    (d) =>
      (roles.size === 0 || roles.has(roleFilterId(d))) &&
      (providers.size === 0 || providers.has(providerFilterId(d, integrations))),
  )
}

function sortedByLabel(options: readonly MultiSelectOption[]): readonly MultiSelectOption[] {
  return options.toSorted((a, b) => a.label.localeCompare(b.label))
}

/**
 * Distinct roles present among the rows, named by `labelOf` (a roleless row is
 * `NO_ROLE_FILTER_ID`).
 */
export function roleFilterOptions(
  devices: readonly ExportFilterable[],
  labelOf: (roleId: string) => string = (id) => id,
): readonly MultiSelectOption[] {
  const ids = [...new Set(devices.map(roleFilterId))]
  return sortedByLabel(ids.map((id) => ({ id, label: labelOf(id) })))
}

/**
 * Distinct integrations present among the rows, by NAME. A device no
 * registered integration claims is listed under its addon id.
 */
export function providerFilterOptions(
  devices: readonly ExportFilterable[],
  integrations?: readonly ExportIntegration[] | null,
): readonly MultiSelectOption[] {
  const nameById = new Map((integrations ?? []).map((i) => [i.id, i.name]))
  const options = new Map<string, string>()
  for (const d of devices) {
    const id = providerFilterId(d, integrations)
    if (options.has(id)) continue
    options.set(id, nameById.get(id) ?? d.addonId)
  }
  return sortedByLabel([...options].map(([id, label]) => ({ id, label })))
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
