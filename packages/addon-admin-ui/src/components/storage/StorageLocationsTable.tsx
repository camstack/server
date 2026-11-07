/**
 * The storage locations (System → Data → Storage, and the Cluster tabs that manage one or two
 * kinds): one `<InstancesTable>` over the function cap `storage`. A location is an instance of a
 * declared kind (`recordings`, `backups`, ...), so the list, the Add / Edit form with its provider
 * select, the on-switch, the connection test and the delete are the ones every instance list
 * shares. This adds only what a location has of its own: capacity and state columns, the state /
 * drain / discard block at the top of the edit dialog, and the forced delete.
 */
import { useStorageListLocationDeclarations } from '@camstack/ui-library'
import { HardDrive } from 'lucide-react'
import { useMemo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { InstancesTable } from '../instances/InstancesTable'
import type { InstanceRow, PanelRow } from '../instances/instances-model'
import { ForceDeleteLocationButton } from './ForceDeleteLocationButton'
import { StorageLocationLead } from './StorageLocationLead'
import { storageColumns } from './StorageLocationCells'
import { locationDeletable } from './location-deletable'
import { useStorageLocationFacts } from './use-storage-location-facts'

export const STORAGE_FUNCTION_CAP = 'storage'

export interface StorageLocationsTableProps {
  /** Location kinds to show; absent shows every kind. */
  readonly kinds?: readonly string[]
}

export function StorageLocationsTable({ kinds }: StorageLocationsTableProps): ReactElement {
  const { t } = useTranslation()
  const { locations } = useStorageLocationFacts()
  const declarations = useStorageListLocationDeclarations({}).data
  // The hub refuses the delete of the last location of a type, the last one taking writes, and
  // any of a single kind: the row shows neither Delete nor the forced one for those. Until both
  // reads answered the row shows none, which the hub would not have allowed either.
  const canDelete = (row: InstanceRow): boolean => {
    const location = locations.find((l) => l.id === row.id)
    const declaration = declarations?.find((d) => d.id === location?.type)
    if (location === undefined || declaration === undefined) return false
    return locationDeletable(
      location,
      locations.filter((l) => l.type === location.type),
      declaration.cardinality,
    )
  }
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
      canDelete={canDelete}
      rowActions={(row: InstanceRow) =>
        canDelete(row) ? <ForceDeleteLocationButton row={row} /> : null
      }
      {...(rowFilter !== undefined ? { rowFilter } : {})}
    />
  )
}
