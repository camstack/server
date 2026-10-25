/**
 * StorageLocationsPanel — reusable storage-location management for a fixed set
 * of location TYPES, rendered with the same `LocationGroup` + add/edit/delete
 * controls as the Storage page. Used by the Pipeline → Cluster Events/Recording
 * tabs to manage their folders inline.
 */

import type { StorageLocation, StorageLocationDeclaration } from '@camstack/types'
import {
  useConfirm,
  useRecordingArchiveGetStorageUsage,
  useStorageDeleteLocation,
  useStorageListLocationDeclarations,
  useStorageListLocations,
  useStorageUpsertLocation,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { AddLocationWizard } from '../../storage/AddLocationWizard'
import { EditLocationModal } from '../../storage/EditLocationModal'
import { LocationGroup } from '../../storage/LocationGroup'
import { toLocationUpsertInput } from '../../storage/location-enabled'
import {
  type LocationMode,
  locationModeChoice,
  modeRequiresConfirmation,
} from '../../storage/location-mode'
import { ownedBytesByLocation } from '../../storage/location-owned-usage'
import { useTranslation } from 'react-i18next'

export interface StorageLocationsPanelProps {
  /** Location type ids to render (in order), e.g. ['eventMedia'] or
   *  ['recordings','recordingsLow']. Unknown types are skipped. */
  readonly types: readonly string[]
}

export function StorageLocationsPanel({ types }: StorageLocationsPanelProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()

  const { data: locations } = useStorageListLocations({})
  const declarationsQuery = useStorageListLocationDeclarations()
  const declarations = useMemo<readonly StorageLocationDeclaration[]>(
    () => declarationsQuery.data ?? [],
    [declarationsQuery.data],
  )
  // CamStack's OWN share of each volume. The only measured figure a UI can
  // reach is the recorder's per-volume usage rows; the classes it does not
  // account (backups, eventMedia, artifacts) simply get no share segment.
  const { data: recordingUsage } = useRecordingArchiveGetStorageUsage(
    {},
    { refetchOnWindowFocus: false },
  )
  const ownedBytesById = useMemo<ReadonlyMap<string, number>>(
    () => ownedBytesByLocation(locations ?? [], recordingUsage?.locations),
    [locations, recordingUsage?.locations],
  )

  const [addingForType, setAddingForType] = useState<string | null>(null)
  const [editing, setEditing] = useState<StorageLocation | null>(null)

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: [['storage', 'listLocations']] })
  }
  const upsertLocation = useStorageUpsertLocation({ onSuccess: invalidate })
  const deleteLocation = useStorageDeleteLocation({ onSuccess: invalidate })

  const byType = useMemo<Map<string, StorageLocation[]>>(() => {
    const map = new Map<string, StorageLocation[]>()
    for (const loc of locations ?? []) {
      const arr = map.get(loc.type)
      if (arr) arr.push(loc)
      else map.set(loc.type, [loc])
    }
    return map
  }, [locations])

  // The WHOLE record, rebuilt from the row that was read — `upsertLocation`
  // replaces, so a field-by-field payload drops `nodeId` and re-stamps an
  // agent's disk as the hub's. `disabled` hides the footage stored here, so it
  // is confirmed; the other three states are ordinary edits.
  const handleSetMode = async (loc: StorageLocation, next: LocationMode): Promise<void> => {
    if (modeRequiresConfirmation(next)) {
      const ok = await confirm({
        title: t('pipeline.storageLocationsPanel.disable', 'Disable "{{displayName}}"?', {
          displayName: loc.displayName,
        }),
        message: t(
          'pipeline.storageLocationsPanel.nothingIsDeletedSetThe',
          '{{consequence}} Nothing is deleted — set the location back to Read-only or Active to bring its footage back.',
          { consequence: locationModeChoice(next).consequence },
        ),
        confirmLabel: t('common.disable', 'Disable'),
        variant: 'danger',
      })
      if (!ok) return
    }
    upsertLocation.mutate(toLocationUpsertInput(loc, { mode: next }))
  }
  const handleDelete = async (loc: StorageLocation): Promise<void> => {
    const ok = await confirm({
      title: t(
        'pipeline.storageLocationsPanel.deleteLocation',
        'Delete location "{{displayName}}"?',
        { displayName: loc.displayName },
      ),
      message: t(
        'pipeline.storageLocationsPanel.removesTheRecordFilesOn',
        'Removes the record; files on disk are untouched.',
      ),
      confirmLabel: t('common.delete', 'Delete'),
      variant: 'danger',
    })
    if (!ok) return
    try {
      await deleteLocation.mutateAsync({ id: loc.id })
    } catch (err) {
      // Same override as the system Storage page: the orchestrator refuses a
      // location it has not verified empty, INCLUDING one it could not reach —
      // and a refusal an operator cannot override is its own failure mode.
      const forced = await confirm({
        title: t('pipeline.storageLocationsPanel.deleteAnyway', 'Delete anyway?'),
        message: t('pipeline.storageLocationsPanel.forcingNote', {
          error: err instanceof Error ? err.message : String(err),
        }),
        confirmLabel: t('pipeline.storageLocationsPanel.forceDelete', 'Force delete'),
        variant: 'danger',
      })
      if (forced) deleteLocation.mutate({ id: loc.id, force: true })
    }
  }

  const shown = types
    .map((t) => declarations.find((d) => d.id === t))
    .filter((d): d is StorageLocationDeclaration => d !== undefined)

  return (
    <div className="space-y-3">
      {shown.length === 0 ? (
        <p className="text-[11px] text-foreground-subtle italic">
          {t(
            'pipeline.storageLocationsPanel.noStorageLocationsDeclaredFor',
            'No storage locations declared for this purpose.',
          )}
        </p>
      ) : (
        shown.map((declaration) => (
          <LocationGroup
            key={declaration.id}
            type={declaration.id}
            displayName={declaration.displayName}
            description={declaration.description}
            cardinality={declaration.cardinality}
            locations={byType.get(declaration.id) ?? []}
            onAdd={(t) => setAddingForType(t)}
            onEdit={(loc) => setEditing(loc)}
            onDelete={(loc) => {
              void handleDelete(loc)
            }}
            ownedBytesById={ownedBytesById}
            onSetMode={(loc, next) => {
              void handleSetMode(loc, next)
            }}
          />
        ))
      )}

      {addingForType !== null && (
        <AddLocationWizard
          initialType={addingForType}
          onClose={() => setAddingForType(null)}
          onCreated={() => {
            invalidate()
            setAddingForType(null)
          }}
        />
      )}
      {editing !== null && (
        <EditLocationModal
          location={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            invalidate()
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}
