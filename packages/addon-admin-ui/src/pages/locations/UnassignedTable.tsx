/**
 * Everything with no room, as a TABLE — the shared `DataTable`, not a `<ul>`.
 *
 * Measured on the real fleet: the old flat list rendered 568 rows, 494 of them
 * accessories whose parent is itself unassigned. Those follow their parent
 * through the server's `setLocation` cascade, so this surface shows only the 74
 * top-level rows and tells each one, BEFORE the tap, how many devices go with
 * it ("accessories in tow"). A row that hid the cascade would be a row the
 * operator cannot audit.
 *
 * Two assignment paths on purpose, because there are two jobs:
 *   - the inline select fixes ONE row;
 *   - the checkboxes + selection bar do a first population, which is what the
 *     74 of today actually are.
 *
 * The table filters ITSELF (search + type chips) — the page has no filter of
 * its own, so this one narrows nothing but these rows. And the filter touches
 * only what is DRAWN: the follower count is read from `fleet`, whole, because
 * the server cascade does not know about the search box.
 */
import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  DataTableFilterBar,
  Select,
  TEXT_HINT,
  TEXT_SECTION_LABEL,
  type SelectOption,
  useDataTableFilter,
  type DataColumn,
  type DataTableFilterConfig,
} from '@camstack/ui-library'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { DeviceTypeIcon, StatusDot } from './device-glyphs'
import { cascadeFollowerCount, unregisteredLocationOf, type SiteDevice } from './site-locations'

/** Only the name: the row's id is a link the operator follows, not a term
 *  they type, and the type has its own chips. */
const FILTER: DataTableFilterConfig<SiteDevice> = {
  searchText: (device) => [device.name],
  facetValue: (device) => device.type,
}

export interface UnassignedTableProps {
  /** The rows to render — top-level only (see `topLevelUnassigned`). */
  readonly rows: readonly SiteDevice[]
  /**
   * The WHOLE fleet, unfiltered. The follower count is read from here, never
   * from `rows`: the cascade ignores the operator's search filter, so counting
   * over a filtered slice would understate what a tap moves.
   */
  readonly fleet: readonly SiteDevice[]
  readonly locations: readonly string[]
  readonly busy: boolean
  readonly emptyMessage: string
  /** One call for one row and for a bulk selection alike. */
  readonly onAssign: (deviceIds: readonly number[], location: string) => void
}

export function UnassignedTable({
  rows,
  fleet,
  locations,
  busy,
  emptyMessage,
  onAssign,
}: UnassignedTableProps) {
  const { t } = useTranslation()
  const [selectedIds, setSelectedIds] = useState<readonly number[]>([])
  const [bulkLocation, setBulkLocation] = useState('')

  const filter = useDataTableFilter(rows, FILTER)
  const visible = filter.rows

  const visibleIds = useMemo(() => visible.map((r) => r.id), [visible])
  // A selection that survived a filter change would assign devices the
  // operator can no longer see. Only what is on screen can be acted on.
  const selected = useMemo(
    () => selectedIds.filter((id) => visibleIds.includes(id)),
    [selectedIds, visibleIds],
  )
  const allSelected = visible.length > 0 && selected.length === visible.length

  // Over `rows` (every top-level roomless device) from `fleet` (everything):
  // the filter above is NOT an input here. A count that followed the filter
  // would say 0 for a camera whose siren the search happened to hide, and the
  // tap would still move the siren.
  const followers = useMemo(() => {
    const counts = new Map<number, number>()
    for (const row of rows) counts.set(row.id, cascadeFollowerCount(fleet, row.id))
    return counts
  }, [rows, fleet])

  const selectedFollowers = selected.reduce((sum, id) => sum + (followers.get(id) ?? 0), 0)

  const toggle = (id: number): void =>
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  const toggleAll = (): void => setSelectedIds(allSelected ? [] : visibleIds)

  const commitBulk = (): void => {
    if (bulkLocation.length === 0 || selected.length === 0) return
    onAssign(selected, bulkLocation)
    setSelectedIds([])
    setBulkLocation('')
  }

  const locationOptions: SelectOption[] = locations.map((loc) => ({ value: loc, label: loc }))

  const columns: readonly DataColumn<SiteDevice>[] = [
    {
      key: 'select',
      width: 'w-8',
      headerRender: () => (
        <Checkbox
          checked={allSelected}
          onChange={toggleAll}
          aria-label={
            allSelected
              ? t('locations.unassignedTable.clearSelection', 'Clear selection')
              : t(
                  'locations.unassignedTable.selectAllUnassignedDevices',
                  'Select all unassigned devices',
                )
          }
        />
      ),
      render: (device) => (
        <Checkbox
          checked={selected.includes(device.id)}
          onChange={() => toggle(device.id)}
          aria-label={t('locations.unassignedTable.select', 'Select {{name}}', {
            name: device.name,
          })}
        />
      ),
    },
    {
      key: 'name',
      header: t('locations.unassignedTable.device', 'Device'),
      sortValue: (device) => device.name.toLowerCase(),
      render: (device) => {
        const ghost = unregisteredLocationOf(device, locations)
        return (
          <span className="flex items-center gap-1.5">
            <DeviceTypeIcon type={device.type} />
            <Link
              to={`/devices/${String(device.id)}`}
              className="truncate text-xs text-foreground hover:underline"
            >
              {device.name}
            </Link>
            {ghost !== null && (
              // The room exists on the row and nowhere else — say so instead of
              // letting the device drop off the page.
              <Badge variant="warning">
                {t('locations.unassignedTable.unknownRoom', { room: ghost })}
              </Badge>
            )}
          </span>
        )
      },
    },
    {
      key: 'type',
      header: t('locations.unassignedTable.type', 'Type'),
      sortValue: (device) => device.type,
      render: (device) => <span className="text-xs text-foreground-muted">{device.type}</span>,
    },
    {
      key: 'status',
      header: t('locations.unassignedTable.status', 'Status'),
      sortValue: (device) => (device.online ? 1 : 0),
      render: (device) => (
        <span className="flex items-center gap-1.5">
          <StatusDot online={device.online} deviceName={device.name} />
          <span className="text-xs text-foreground-muted">
            {device.online ? t('common.online') : t('common.offline')}
          </span>
        </span>
      ),
    },
    {
      key: 'followers',
      header: t('locations.unassignedTable.accessoriesInTowCount', 'Accessories in tow'),
      align: 'right',
      sortValue: (device) => followers.get(device.id) ?? 0,
      render: (device) => (
        <span className="tabular-nums text-xs text-foreground-muted">
          {followers.get(device.id) ?? 0}
        </span>
      ),
    },
    {
      key: 'assign',
      header: t('locations.unassignedTable.assignTo', 'Assign to'),
      align: 'right',
      notSortableReason: 'This column is a control, not a value.',
      render: (device) => (
        <Select
          aria-label={t('locations.unassignedTable.locationFor', 'Location for {{name}}', {
            name: device.name,
          })}
          value=""
          disabled={busy || locations.length === 0}
          onChange={(e) => {
            const value = e.target.value
            if (value.length === 0) return
            onAssign([device.id], value)
          }}
          className="max-w-[11rem]"
          options={[{ value: '', label: '—' }, ...locationOptions]}
        />
      ),
    },
  ]

  return (
    <section className="space-y-2">
      <header className="flex flex-wrap items-baseline gap-2">
        <h2 className={TEXT_SECTION_LABEL}>
          {t('locations.unassignedTable.notInARoom', 'Not in a room')}
        </h2>
        <p className={TEXT_HINT}>
          {t(
            'locations.unassignedTable.topLevelDevicesOnlyAccessories',
            'Top-level devices only — accessories move with their parent.',
          )}
        </p>
      </header>

      {rows.length > 0 && (
        <DataTableFilterBar
          state={filter.state}
          facets={filter.facets}
          labels={{
            searchPlaceholder: t('locations.filter.searchPlaceholder'),
            searchLabel: t('locations.unassigned.searchLabel'),
            facetsLabel: t('locations.filter.typesLabel'),
            clearLabel: t('locations.filter.clear'),
          }}
          onSearch={filter.setSearch}
          onToggleFacet={filter.toggleFacet}
          onClear={filter.clear}
        />
      )}

      {selected.length > 0 && (
        <div
          role="group"
          aria-label={t('locations.unassignedTable.bulkAssignment', 'Bulk assignment')}
          className="flex flex-wrap items-center gap-2 rounded border border-primary/40 bg-primary/5 px-2 py-1.5"
        >
          <span className="text-xs text-foreground">
            {t('locations.unassignedTable.selected', { count: selected.length })}
            {selectedFollowers > 0 &&
              ` · ${t('locations.unassignedTable.accessoriesInTowCount', { count: selectedFollowers })}`}
          </span>
          <Select
            aria-label={t(
              'locations.unassignedTable.assignSelectedDevicesTo',
              'Assign selected devices to',
            )}
            value={bulkLocation}
            onChange={(e) => setBulkLocation(e.target.value)}
            className="w-auto min-w-[10rem]"
            options={[
              { value: '', label: t('locations.unassignedTable.assignTo2', 'Assign to…') },
              ...locationOptions,
            ]}
          />
          <Button
            type="button"
            size="sm"
            onClick={commitBulk}
            disabled={busy || bulkLocation.length === 0}
          >
            {t('locations.unassignedTable.assign', 'Assign')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setSelectedIds([])}>
            {t('locations.unassignedTable.clear', 'Clear')}
          </Button>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={visible}
        rowKey={(device) => device.id}
        minWidthPx={720}
        // "Nothing matches" and "everything has a room" are different news,
        // and only the second is good.
        emptyMessage={filter.active ? t('locations.filter.noMatch') : emptyMessage}
      />
    </section>
  )
}
