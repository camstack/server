/**
 * The storage locations (System → Data → Storage, and the Cluster tabs that manage one or two
 * kinds): one `<InstancesTable>` over the function cap `storage`. A location is an instance of a
 * declared kind (`recordings`, `backups`, ...), so the list, the Add / Edit form with its provider
 * select, the on-switch, the connection test and the delete are the ones every instance list
 * shares. This adds only what a location has of its own: capacity and state columns, the state /
 * drain / discard block at the top of the edit dialog, and the forced delete.
 */
import { HardDrive } from 'lucide-react'
import { useMemo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { InstancesTable } from '../instances/InstancesTable'
import type { InstanceRow, PanelRow } from '../instances/instances-model'
import { ForceDeleteLocationButton } from './ForceDeleteLocationButton'
import { StorageLocationLead } from './StorageLocationLead'
import { storageColumns } from './StorageLocationCells'

export const STORAGE_FUNCTION_CAP = 'storage'

export interface StorageLocationsTableProps {
  /** Location kinds to show; absent shows every kind. */
  readonly kinds?: readonly string[]
}

export function StorageLocationsTable({ kinds }: StorageLocationsTableProps): ReactElement {
  const { t } = useTranslation()
  const columns = useMemo(
    () =>
      storageColumns({
        capacity: t('system.storage.colCapacity', 'Capacity'),
        mode: t('system.storage.colMode', 'State'),
      }),
    [t],
  )
  const rowFilter = useMemo(
    () =>
      kinds === undefined
        ? undefined
        : (row: PanelRow): boolean =>
            row.kind === 'instance' && row.kindId !== undefined && kinds.includes(row.kindId),
    [kinds],
  )
  return (
    <InstancesTable
      functionCap={STORAGE_FUNCTION_CAP}
      icon={HardDrive}
      title={t('system.storage.title', 'Storage locations')}
      subtitle={t(
        'system.storage.subtitle',
        'Where recordings, event media, artifacts and backups are kept. Each location is one kind on one provider; the state decides whether it takes writes, is only read, drains or is left alone.',
      )}
      emptyTitle={t('system.storage.emptyTitle', 'No storage locations yet')}
      emptyDescription={t(
        'system.storage.noStorageLocationsDeclaredBy',
        'No storage locations declared by any installed addon.',
      )}
      addLabel={t('system.storage.addLocation', 'Add location')}
      extraColumns={columns}
      lead={(row: InstanceRow) => <StorageLocationLead row={row} />}
      rowActions={(row: InstanceRow) => <ForceDeleteLocationButton row={row} />}
      {...(rowFilter !== undefined ? { rowFilter } : {})}
    />
  )
}
