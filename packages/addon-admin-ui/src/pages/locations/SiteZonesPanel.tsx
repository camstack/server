import { Button, DataTable, Input, type DataColumn } from '@camstack/ui-library'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'

import type { IconKey, SiteZone } from '@camstack/types'

import { LocationIconPicker } from './LocationIconPicker'
import { useTranslation } from 'react-i18next'

/**
 * SITE ZONES — the named parts of the property that group rooms.
 *
 * "Night zone" holds the bedrooms. A camera belongs to one location and a
 * location to at most one zone, so nothing here touches a device row: grouping
 * rooms must never rewrite the fleet.
 *
 * A managed list is a `DataTable`. Creation is NOT here: the one "New zone"
 * control is `NewZoneButton` in the page header, so there is a single way in.
 *
 * MEMBERSHIP is not edited here. It is edited on the room, where the room is:
 * a screen that assigned rooms to zones AND zones to rooms would be two places
 * to change one fact, which is exactly how a location's description drifted
 * away from its icon.
 */
export interface SiteZonesPanelProps {
  readonly zones: readonly SiteZone[]
  readonly busy: boolean
  readonly onRename: (from: string, to: string) => void | Promise<void>
  readonly onDelete: (name: string) => void | Promise<void>
  readonly onPickIcon: (name: string, icon: IconKey | null) => void | Promise<void>
}

export function SiteZonesPanel({
  zones,
  busy,
  onRename,
  onDelete,
  onPickIcon,
}: SiteZonesPanelProps) {
  const { t } = useTranslation()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const submitRename = async (from: string): Promise<void> => {
    const to = renameDraft.trim()
    setRenaming(null)
    if (to.length === 0 || to === from) return
    await onRename(from, to)
  }

  const columns: DataColumn<SiteZone>[] = [
    {
      key: 'icon',
      header: t('locations.siteZonesPanel.icon', 'Icon'),
      width: 'w-12',
      notSortableReason: 'An icon has no order',
      render: (zone) => (
        <LocationIconPicker
          name={zone.label}
          icon={zone.icon}
          busy={busy}
          onPick={(icon) => onPickIcon(zone.label, icon)}
        />
      ),
    },
    {
      key: 'name',
      header: t('locations.siteZonesPanel.zone', 'Zone'),
      sortValue: (zone) => zone.label.toLowerCase(),
      render: (zone) =>
        renaming === zone.label ? (
          <Input
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitRename(zone.label)
              if (e.key === 'Escape') setRenaming(null)
            }}
            onBlur={() => void submitRename(zone.label)}
            aria-label={t('locations.siteZonesPanel.rename', 'Rename {{label}}', {
              label: zone.label,
            })}
            autoFocus
          />
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="px-0"
            onClick={() => {
              setRenameDraft(zone.label)
              setRenaming(zone.label)
            }}
            disabled={busy}
            title={t('locations.siteZonesPanel.renameTheZone', 'Rename the zone')}
          >
            {zone.label}
          </Button>
        ),
    },
    {
      key: 'rooms',
      header: t('locations.siteZonesPanel.rooms', 'Rooms'),
      align: 'right',
      sortValue: (zone) => zone.locationKeys.length,
      // How full it is. A zone with no rooms is not broken — it is one an
      // operator made and has not filled yet — but it IS worth seeing before
      // wondering why the app's chip shows nothing.
      render: (zone) => (
        <span className="tabular-nums text-foreground-subtle">
          {zone.locationKeys.length === 0
            ? t('common.empty')
            : t('common.rooms', { count: zone.locationKeys.length })}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('locations.siteZonesPanel.actions', 'Actions'),
      align: 'right',
      notSortableReason: 'Actions have no order',
      render: (zone) => (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void onDelete(zone.label)}
          disabled={busy}
          aria-label={t('locations.siteZonesPanel.delete', 'Delete {{label}}', {
            label: zone.label,
          })}
          title={t(
            'locations.siteZonesPanel.deleteTheZoneTheRooms',
            'Delete the zone — the rooms in it are kept',
          )}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      ),
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={zones}
      rowKey={(zone) => zone.zoneKey}
      emptyMessage={t(
        'locations.siteZonesPanel.noZonesYetAZone',
        'No zones yet. A zone groups rooms — “Night zone” for the bedrooms — and shows up before them in the app’s camera filter.',
      )}
    />
  )
}
