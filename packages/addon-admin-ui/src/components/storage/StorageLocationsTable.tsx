/**
 * The storage locations (System → Data → Storage, and the Cluster tabs that manage one or two
 * kinds): one `<InstancesTable>` over the function cap `storage`. A location is an instance of a
 * declared kind (`recordings`, `backups`, ...), so the list, the Add / Edit form with its provider
 * select, the on-switch, the connection test and the delete are the ones every instance list
 * shares. This adds only what a location has of its own: capacity and state columns, the state /
 * drain / discard block at the top of the edit dialog, and the delete's forced variant
 * (offered by the delete dialog when the hub refuses on occupancy).
 */
import { useStorageListLocationDeclarations } from '@dominevo/ui-library'
import { HardDrive } from 'lucide-react'
import { useMemo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { InstancesTable } from '../instances/InstancesTable'
import type { InstanceRow, PanelRow } from '../instances/instances-model'
import { StorageLocationLead } from './StorageLocationLead'
import { storageExtraColumns } from './StorageLocationCells'
import { locationDeletable } from './location-deletable'
import { useLocationDeleteRefusal } from './use-location-delete-refusal'
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
  const onDeleteRefused = useLocationDeleteRefusal()
  // The hub refuses the delete of the last location of a type, the last one taking writes, and
  // any of a single kind: the row shows no Delete for those. Until both
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
      storageExtraColumns({
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
      onDeleteRefused={onDeleteRefused}
      {...(rowFilter !== undefined ? { rowFilter } : {})}
    />
  )
}
