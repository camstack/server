/**
 * One room, as a card whose MEMBER list is always visible — a `DataTable`,
 * like every other list of devices, so the filter bar and the column model are
 * the shared ones (an operator asked for exactly that: "sempre datatable se
 * possibile per avere i filtri già pronti" [always a datatable if possible, to have the filters ready]). The nesting the table cannot
 * express is decided in `location-card-rows.ts`, as a flat row list.
 *
 * The member list is the information: an operator asking "what is in the
 * Hall" wants the names, and a number that says `6` costs a click to answer
 * the actual question. That still holds for members.
 *
 * Their ACCESSORIES do not follow the same rule and are collapsed by default.
 * A container's children are its battery reading, its temperature, its "last
 * seen" and its identify button — one door contact produced five lines. Ten of
 * fifteen rows under camera 104 were exactly this. The count on the toggle
 * answers "does this device have companions" without spending the room.
 *
 * An EMPTY room still renders, with an explicit empty state. A card that
 * disappeared when it held nothing would be a room nobody could ever assign
 * anything to — the one moment the card matters most.
 *
 * The member list filters ITSELF (search + type chips), independently of the
 * unassigned table below and of every other room. The search also matches a
 * member's collapsed accessories: typing "batteria" must find the door
 * contact that carries it, or the collapse above costs the operator the
 * search too.
 */
import type { IconKey, SiteZone } from '@camstack/types'
import {
  Button,
  DataTable,
  DataTableFilterBar,
  DeviceName,
  IconButton,
  Input,
  KebabMenu,
  SECTION_CARD,
  SECTION_HEADER,
  useDataTableFilter,
  useDeviceLabel,
  type DataColumn,
  type DataTableFilterConfig,
  type KebabMenuItem,
} from '@camstack/ui-library'
import { ChevronDown, ChevronRight, Pencil, RefreshCw, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { DeviceTypeIcon, LabeledStatusDot } from './device-glyphs'
import { LocationDescriptionField } from './LocationDescriptionField'
import { LocationZoneField } from './LocationZoneField'
import { LocationIconPicker } from './LocationIconPicker'
import {
  buildLocationCardRows,
  locationCardRowKey,
  type LocationCardAccessoryRow,
  type LocationCardMemberRow,
  type LocationCardRow,
} from './location-card-rows'
import { linkedChildren, siteDeviceFields, type SiteDevice } from './site-locations'

export interface LocationCardProps {
  readonly name: string
  /** Rows that get their own line here — accessories nest under their parent. */
  readonly members: readonly SiteDevice[]
  /** The fleet the nested accessories are read from. */
  readonly devices: readonly SiteDevice[]
  readonly busy: boolean
  /** The room's chosen icon, or `null` when it has none. `null` is NOT the
   *  fallback pin — the picker draws the pin for both, but only one of the two
   *  is a choice, and clearing has to stay reachable. */
  readonly icon: IconKey | null
  /** What the room LOOKS like, for the AI. `null` when nobody wrote one — and
   *  that is not the same as an empty string reaching the model. */
  readonly description: string | null
  readonly onRename: (to: string) => void | Promise<void>
  readonly onDelete: () => void | Promise<void>
  /** Rebuild this room's cameras' linked-device lists from what the room
   *  contains. Overwrites — see `rebuild-room-links.ts`. */
  readonly onRebuildLinks: () => void | Promise<void>
  /** Open the multi-select picker to assign devices to this room. */
  readonly onAddDevices: () => void
  readonly onPickIcon: (icon: IconKey | null) => void | Promise<void>
  readonly onSaveDescription: (description: string | null) => void | Promise<void>
  /** The zones that exist, and which one this room is in. Empty hides the
   *  control entirely — a select whose only answer is "none" is a question
   *  with no answers. */
  readonly zones: readonly SiteZone[]
  readonly zoneKey: string | null
  readonly onChangeZone: (zone: string | null) => void | Promise<void>
}

export function LocationCard({
  name,
  members,
  devices,
  busy,
  icon,
  description,
  onRename,
  onDelete,
  onRebuildLinks,
  onAddDevices,
  onPickIcon,
  onSaveDescription,
  zones,
  zoneKey,
  onChangeZone,
}: LocationCardProps) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  const filterConfig = useMemo<DataTableFilterConfig<SiteDevice>>(
    () => ({
      searchText: (member) => [
        member.name,
        ...linkedChildren(devices, member.id).map((child) => child.name),
      ],
      facetValue: (member) => member.type,
    }),
    [devices],
  )
  const filter = useDataTableFilter(members, filterConfig)

  // Which members the operator OPENED. Written by the chevron only — the
  // filter narrows the member rows and never opens one, so a search that finds
  // a collapsed accessory shows its parent, still collapsed.
  const [openMembers, setOpenMembers] = useState<ReadonlySet<number>>(() => new Set())
  const toggleMember = (id: number): void =>
    setOpenMembers((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const rows = useMemo(
    () => buildLocationCardRows(filter.rows, devices, openMembers),
    [filter.rows, devices, openMembers],
  )

  const columns: readonly DataColumn<LocationCardRow>[] = [
    {
      key: 'name',
      header: t('locations.columns.device'),
      notSortableReason: t('locations.columns.noSort'),
      render: (row) =>
        row.kind === 'member' ? (
          <MemberCell row={row} onToggle={() => toggleMember(row.device.id)} />
        ) : (
          <AccessoryCell row={row} />
        ),
    },
    {
      key: 'type',
      header: t('locations.columns.type'),
      notSortableReason: t('locations.columns.noSort'),
      render: (row) => <span className="text-xs text-foreground-muted">{row.device.type}</span>,
    },
    {
      key: 'status',
      header: t('locations.columns.status'),
      notSortableReason: t('locations.columns.noSort'),
      render: (row) => (
        <span className="flex items-center gap-1.5">
          <LabeledStatusDot device={row.device} />
          <span className="text-xs text-foreground-muted">
            {row.device.online ? t('common.online') : t('common.offline')}
          </span>
        </span>
      ),
    },
  ]

  const cancelRename = (): void => {
    setDraft(name)
    setEditing(false)
  }

  const commitRename = async (): Promise<void> => {
    const next = draft.trim()
    if (next.length === 0 || next === name) {
      cancelRename()
      return
    }
    await onRename(next)
    setEditing(false)
  }

  const menuItems: readonly KebabMenuItem[] = [
    {
      id: 'rename',
      label: t('locations.locationCard.rename', 'Rename'),
      icon: Pencil,
      disabled: busy,
      onClick: () => {
        setDraft(name)
        setEditing(true)
      },
    },
    {
      id: 'rebuild-links',
      label: t('locations.locationCard.rebuildLinkedDevices', 'Rebuild linked devices'),
      icon: RefreshCw,
      separatorBefore: true,
      disabled: busy,
      onClick: () => void onRebuildLinks(),
    },
    {
      id: 'delete',
      label: t('common.delete', 'Delete'),
      icon: Trash2,
      danger: true,
      separatorBefore: true,
      disabled: busy,
      onClick: () => void onDelete(),
    },
  ]

  return (
    <section className={`min-w-0 ${SECTION_CARD}`}>
      <header className={`${SECTION_HEADER} flex min-h-9 items-center gap-1.5`}>
        <LocationIconPicker name={name} icon={icon} busy={busy} onPick={onPickIcon} />
        {editing ? (
          <>
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename()
                if (e.key === 'Escape') cancelRename()
              }}
              aria-label={t('locations.locationCard.rename2', 'Rename {{name}}', { name })}
              className="min-w-0 flex-1"
              autoFocus
            />
            <Button type="button" size="sm" onClick={() => void commitRename()}>
              {t('common.save', 'Save')}
            </Button>
            <IconButton
              type="button"
              variant="ghost"
              icon={X}
              onClick={cancelRename}
              aria-label={t('locations.locationCard.cancelRename', 'Cancel rename')}
            />
          </>
        ) : (
          <>
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
              {name}
            </h2>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onAddDevices}
              aria-label={t('locations.room.addTo', { room: name })}
            >
              {t('locations.room.add')}
            </Button>
            <KebabMenu
              items={menuItems}
              title={t('locations.locationCard.actionsFor', 'Actions for {{name}}', { name })}
              triggerClassName="p-1"
            />
          </>
        )}
      </header>
      <LocationZoneField
        name={name}
        zones={zones}
        zoneKey={zoneKey}
        busy={busy}
        onChange={onChangeZone}
      />
      <LocationDescriptionField
        name={name}
        description={description}
        busy={busy}
        onSave={onSaveDescription}
      />
      {members.length > 0 && (
        <div className="border-b border-border px-3 py-1.5 sm:px-4 sm:py-2">
          <DataTableFilterBar
            state={filter.state}
            facets={filter.facets}
            labels={{
              searchPlaceholder: t('locations.filter.searchPlaceholder'),
              searchLabel: t('locations.room.searchLabel', { room: name }),
              facetsLabel: t('locations.filter.typesLabel'),
              clearLabel: t('locations.filter.clear'),
            }}
            onSearch={filter.setSearch}
            onToggleFacet={filter.toggleFacet}
            onClear={filter.clear}
          />
        </div>
      )}
      {members.length === 0 ? (
        <p className="px-3 py-3 text-xs text-foreground-subtle sm:px-4">
          {t(
            'locations.locationCard.nothingHereYetAssignA',
            'Nothing here yet — assign a device from the table below.',
          )}
        </p>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={locationCardRowKey}
          bordered={false}
          minWidthPx={360}
          emptyMessage={t('locations.filter.noMatch')}
        />
      )}
    </section>
  )
}

interface MemberCellProps {
  readonly row: LocationCardMemberRow
  readonly onToggle: () => void
}

function MemberCell({ row, onToggle }: MemberCellProps) {
  const { t } = useTranslation()
  const { device, accessories, open } = row
  const label = useDeviceLabel(siteDeviceFields(device), 'compact')
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <span className="flex items-center gap-1.5">
      {accessories.length > 0 ? (
        <Button
          type="button"
          variant="ghost"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={t(
            open
              ? 'locations.locationCard.collapseAccessories'
              : 'locations.locationCard.expandAccessories',
            { count: accessories.length, name: label },
          )}
          className="h-auto shrink-0 gap-0.5 p-0.5 text-foreground-subtle hover:text-foreground"
        >
          <Chevron className="h-3 w-3" />
          <span className="text-[10px] tabular-nums">{accessories.length}</span>
        </Button>
      ) : (
        // Keeps the name column aligned whether or not a device has companions.
        <span aria-hidden="true" className="w-[1.35rem] shrink-0" />
      )}
      <DeviceTypeIcon type={device.type} />
      <Link
        to={`/devices/${String(device.id)}`}
        className="min-w-0 truncate text-xs text-foreground hover:underline"
      >
        <DeviceName device={siteDeviceFields(device)} form="compact" />
      </Link>
    </span>
  )
}

interface AccessoryCellProps {
  readonly row: LocationCardAccessoryRow
}

function AccessoryCell({ row }: AccessoryCellProps) {
  const { device, parent } = row
  return (
    <span className="flex items-center gap-1.5 pl-6">
      <span aria-hidden="true" className="text-[10px] text-foreground-subtle">
        └
      </span>
      <DeviceTypeIcon type={device.type} className="h-3 w-3 shrink-0 text-foreground-subtle" />
      <Link
        to={`/devices/${String(device.id)}`}
        className="min-w-0 truncate text-xs text-foreground-muted hover:underline"
      >
        <DeviceName
          device={siteDeviceFields(device)}
          form="nested"
          parent={siteDeviceFields(parent)}
        />
      </Link>
    </span>
  )
}
