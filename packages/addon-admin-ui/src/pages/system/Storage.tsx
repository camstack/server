/**
 * Storage Locations page.
 *
 * Architecture (post declarative-storage-locations rework):
 *   - The `storage` cap (singleton, owned by `storage-orchestrator`) is
 *     the only surface this page talks to. `listLocations()` returns
 *     every persisted `StorageLocation`; `listLocationDeclarations()`
 *     returns the kernel-aggregated, addon-declared location catalog;
 *     `upsertLocation` / `deleteLocation` mutate the records.
 *   - The screen is fully declaration-driven: one `<LocationGroup>` per
 *     `StorageLocationDeclaration` (header = `displayName`, subtitle =
 *     `description`). A group's locations are
 *     `allLocations.filter(l => l.type === declaration.id)`. The "+ Add"
 *     button shows only when `declaration.cardinality === 'multi'`.
 *   - There is no hard-coded `StorageLocationType` enum in the UI any
 *     more — addons declare their storage slots and this page renders
 *     them.
 *   - Typed declaration groups keep a `LocationCard` stack (not
 *     DataTable): each row carries mode, capacity, drain and protection
 *     controls that a table would flatten poorly. Add/edit open state is
 *     URL-owned via `useItemFormUrl` (`?new=1` / `?edit=<locationId>`);
 *     create also carries `?type=<declarationId>` so a reload reopens the
 *     right wizard. The multi-step add / edit shells stay as their own
 *     Dialogs — too large for a clean `ItemFormDialog` wrap.
 *
 * Moving a location's footage/media to another location is handled
 * exclusively by the Recordings → Management → Move storage panel
 * (`StorageMigrationSection`, backed by the `storage-migration`
 * capability's coordinated plan/start/status/cancel flow) — this page no
 * longer offers an ad-hoc per-location "Relocate" action.
 */

import type { StorageLocation, StorageLocationDeclaration } from '@camstack/types'
import {
  useConfirm,
  useItemFormUrl,
  useRecordingArchiveGetStorageUsage,
  useStorageDeleteLocation,
  useStorageListDrainProgress,
  useStorageListLocationDeclarations,
  useStorageListLocations,
  useStorageUpsertLocation,
  useUrlQueryParam,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { AdminPage } from '../../components/AdminPage'
import { AddLocationWizard } from '../../components/storage/AddLocationWizard'
import { toDrainProgressById } from '../../components/storage/drain-progress'
import { EditLocationModal } from '../../components/storage/EditLocationModal'
import { LocationGroup } from '../../components/storage/LocationGroup'
import { toLocationUpsertInput } from '../../components/storage/location-enabled'
import {
  type LocationMode,
  locationModeChoice,
  modeRequiresConfirmation,
} from '../../components/storage/location-mode'
import { ownedBytesByLocation } from '../../components/storage/location-owned-usage'
import { useTranslation } from 'react-i18next'

export function StoragePage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const { data: locations, isLoading, isError } = useStorageListLocations({})
  // The cap declares `listLocationDeclarations` with no input and a
  // readonly array output; tRPC inference yields the declaration array
  // directly. Default to `[]` while loading so the render is safe.
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
  // Drain progress, for the locations the operator has set to drain. A hub that
  // does not know the method leaves this empty and the card says so — the
  // figure is withheld, never invented.
  const { data: drainRows } = useStorageListDrainProgress({}, { refetchOnWindowFocus: false })
  const drainById = useMemo(() => toDrainProgressById(drainRows), [drainRows])

  const { state: formUrl, openNew, openEdit, close: closeForm } = useItemFormUrl()
  // Companion to `?new=1`: which declaration the Add wizard targets.
  const [addType, setAddType] = useUrlQueryParam('type')

  const closeFormFully = (): void => {
    setAddType(null)
    closeForm()
  }

  const openAddForType = (type: string): void => {
    setAddType(type)
    openNew()
  }

  const openEditLocation = (location: StorageLocation): void => {
    setAddType(null)
    openEdit(location.id)
  }

  const locationList = locations ?? []
  const editingLocation =
    formUrl.mode === 'edit' ? (locationList.find((loc) => loc.id === formUrl.id) ?? null) : null

  // Stale or incomplete URL params must not leave a wizard open on nothing.
  useEffect(() => {
    if (formUrl.mode === 'new' && (addType === null || addType === '')) {
      setAddType(null)
      closeForm()
    }
  }, [formUrl.mode, addType, closeForm, setAddType])

  useEffect(() => {
    if (formUrl.mode === 'edit' && !isLoading && editingLocation === null) {
      setAddType(null)
      closeForm()
    }
  }, [formUrl.mode, isLoading, editingLocation, closeForm, setAddType])

  useEffect(() => {
    if (formUrl.mode === 'closed' && addType !== null) {
      setAddType(null)
    }
  }, [formUrl.mode, addType, setAddType])

  const deleteLocation = useStorageDeleteLocation({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['storage', 'listLocations']] })
    },
  })

  const upsertLocation = useStorageUpsertLocation({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['storage', 'listLocations']] })
    },
  })

  // `disabled` is the only state that takes footage OFF the timeline, so it is
  // the only one worth an interstitial; the other three are ordinary edits.
  const handleSetMode = async (location: StorageLocation, next: LocationMode): Promise<void> => {
    if (modeRequiresConfirmation(next)) {
      const ok = await confirm({
        title: t('system.storage.disable', 'Disable "{{displayName}}"?', {
          displayName: location.displayName,
        }),
        message: t(
          'system.storage.nothingIsDeletedSetThe',
          '{{consequence}} Nothing is deleted — set the location back to Read-only or Active to bring its footage back.',
          { consequence: locationModeChoice(next).consequence },
        ),
        confirmLabel: t('common.disable', 'Disable'),
        variant: 'danger',
      })
      if (!ok) return
    }
    upsertLocation.mutate(toLocationUpsertInput(location, { mode: next }))
  }

  const handleDelete = async (location: StorageLocation): Promise<void> => {
    const ok = await confirm({
      title: t('system.storage.deleteLocation', 'Delete location "{{displayName}}"?', {
        displayName: location.displayName,
      }),
      message: t(
        'system.storage.thisRemovesTheLocationRecord',
        'This removes the location record. Files on disk are not deleted; the underlying directory or remote path stays untouched.',
      ),
      confirmLabel: t('common.delete', 'Delete'),
      variant: 'danger',
    })
    if (!ok) return
    try {
      await deleteLocation.mutateAsync({ id: location.id })
      if (formUrl.mode === 'edit' && formUrl.id === location.id) closeFormFully()
    } catch (err) {
      // The orchestrator refuses a location it has not verified EMPTY — and it
      // refuses "could not check" as well as "still holds data", because a read
      // that fails must not authorise a delete. Both refusals need an override
      // an operator can actually reach: a disk that was pulled, or a location
      // on a node that is down, answers "unknown" forever.
      const forced = await confirm({
        title: t('system.storage.deleteAnyway', 'Delete anyway?'),
        message: t('system.storage.forcingNote', {
          error: err instanceof Error ? err.message : String(err),
        }),
        confirmLabel: t('system.storage.forceDelete', 'Force delete'),
        variant: 'danger',
      })
      if (forced) {
        deleteLocation.mutate(
          { id: location.id, force: true },
          {
            onSuccess: () => {
              if (formUrl.mode === 'edit' && formUrl.id === location.id) closeFormFully()
            },
          },
        )
      }
    }
  }

  // Group locations by their declared id (`location.type === declaration.id`).
  const grouped = useMemo<Map<string, StorageLocation[]>>(() => {
    const map = new Map<string, StorageLocation[]>()
    for (const loc of locations ?? []) {
      const arr = map.get(loc.type)
      if (arr) arr.push(loc)
      else map.set(loc.type, [loc])
    }
    return map
  }, [locations])

  const loading = isLoading || declarationsQuery.isLoading
  const errored = isError || declarationsQuery.isError
  const showAddWizard = formUrl.mode === 'new' && addType !== null && addType !== ''
  const showEditModal = formUrl.mode === 'edit' && editingLocation !== null

  return (
    <AdminPage embedded>
      {loading && (
        <div className="text-xs text-foreground-subtle animate-pulse">
          {t('system.storage.loadingLocations', 'Loading locations…')}
        </div>
      )}
      {errored && (
        <div className="text-xs text-danger">
          {t('system.storage.failedToLoadStorageLocations', 'Failed to load storage locations.')}
        </div>
      )}

      {!loading && !errored && (
        <div className="space-y-3">
          {declarations.length === 0 && (
            <div className="rounded-lg border border-border bg-surface px-3 py-4 text-center text-[11px] text-foreground-subtle italic">
              {t(
                'system.storage.noStorageLocationsDeclaredBy',
                'No storage locations declared by any installed addon.',
              )}
            </div>
          )}
          {declarations.map((declaration) => (
            <LocationGroup
              key={declaration.id}
              type={declaration.id}
              displayName={declaration.displayName}
              description={declaration.description}
              cardinality={declaration.cardinality}
              locations={grouped.get(declaration.id) ?? []}
              onAdd={openAddForType}
              onEdit={openEditLocation}
              onDelete={(loc) => {
                void handleDelete(loc)
              }}
              ownedBytesById={ownedBytesById}
              drainById={drainById}
              onSetMode={(loc, next) => {
                void handleSetMode(loc, next)
              }}
            />
          ))}
        </div>
      )}

      {showAddWizard && addType !== null && (
        <AddLocationWizard
          initialType={addType}
          onClose={closeFormFully}
          onCreated={() => {
            void queryClient.invalidateQueries({ queryKey: [['storage', 'listLocations']] })
            closeFormFully()
          }}
        />
      )}

      {showEditModal && editingLocation !== null && (
        <EditLocationModal
          location={editingLocation}
          onClose={closeFormFully}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: [['storage', 'listLocations']] })
            closeFormFully()
          }}
        />
      )}
    </AdminPage>
  )
}
