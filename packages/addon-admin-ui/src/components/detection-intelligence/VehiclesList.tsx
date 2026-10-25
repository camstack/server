/**
 * VehiclesList — manage plate-recognition vehicle identities.
 *
 * - DataTable of vehicles (cover crop, name, plate-sample count)
 * - Create / rename via ItemFormDialog; URL `?new=1` / `?edit=<id>` (useItemFormUrl)
 * - Edit dialog also hosts the per-vehicle plate samples grid (remove samples)
 * - Delete asks through useConfirm
 *
 * Mirrors the faces `PeopleList`; the only domain difference is that a plate
 * sample is self-labeling (it carries its OCR `text`), shown under each crop.
 * Plate assignment from Recent recognized plates stays on AssignPlateDialog.
 */

import {
  Badge,
  Button,
  DataTable,
  DataTableFilterBar,
  EmptyState,
  FormField,
  IconButton,
  Input,
  ItemFormDialog,
  TABLE_SCROLL_MAX_H,
  useConfirm,
  useDataTableFilter,
  useItemFormUrl,
  usePlateGalleryCreateVehicle,
  usePlateGalleryDeleteVehicle,
  usePlateGalleryListVehicles,
  usePlateGalleryListVehicleSamples,
  usePlateGalleryRemoveVehicleSample,
  usePlateGalleryRenameVehicle,
  type DataColumn,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Car, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { MediaIdImage } from './MediaIdImage.js'
import type { Vehicle, VehicleSampleInfo } from './plate-types.js'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

const PLATE_GALLERY_KEY = [['plateGallery']]

// ── Samples sub-component (lazy) ────────────────────────────────────────────

interface SamplesGridProps {
  readonly vehicleId: string
}

function SamplesGrid({ vehicleId }: SamplesGridProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: samples, isLoading } = usePlateGalleryListVehicleSamples({
    vehicleId,
  })
  const removeSample = usePlateGalleryRemoveVehicleSample()

  function handleRemove(sample: VehicleSampleInfo) {
    removeSample.mutate(
      { vehicleId, sampleId: sample.id },
      {
        onSettled: () => {
          void queryClient.invalidateQueries({ queryKey: PLATE_GALLERY_KEY })
        },
      },
    )
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-3 text-xs text-foreground-subtle">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('detectionIntelligence.vehiclesList.loadingPlates', 'Loading plates…')}
      </div>
    )
  }

  if (!samples || samples.length === 0) {
    return (
      <p className="py-2 text-xs text-foreground-subtle">
        {t('detectionIntelligence.vehiclesList.noPlatesYet', 'No plates yet.')}
      </p>
    )
  }

  return (
    <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
      {samples.map((sample) => (
        <div
          key={sample.id}
          className="group relative overflow-hidden rounded-md border border-border bg-surface"
        >
          <div className="relative aspect-[2/1] overflow-hidden bg-surface-hover">
            {sample.base64 ? (
              <img
                src={`data:image/jpeg;base64,${sample.base64}`}
                alt={sample.text}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-foreground-subtle">
                <Car className="h-6 w-6" />
              </div>
            )}
            <button // ui-check-ok: full-tile remove overlay; IconButton chrome fights the hit target
              type="button"
              onClick={() => handleRemove(sample)}
              disabled={removeSample.isPending}
              className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100 disabled:cursor-not-allowed"
              aria-label={t(
                'detectionIntelligence.vehiclesList.removePlateSample',
                'Remove plate sample',
              )}
            >
              <X className="h-4 w-4 text-white" />
            </button>
          </div>
          <p
            className="truncate px-1.5 py-1 text-center font-mono text-[11px] font-semibold tracking-wide text-foreground"
            title={sample.text}
          >
            {sample.text}
          </p>
        </div>
      ))}
    </div>
  )
}

// ── Columns ───────────────────────────────────────────────────────────────────

interface VehiclesColumnsDeps {
  readonly onEdit: (vehicle: Vehicle) => void
  readonly onDelete: (vehicle: Vehicle) => void
}

function vehiclesColumns(deps: VehiclesColumnsDeps): readonly DataColumn<Vehicle>[] {
  return [
    {
      key: 'vehicle',
      header: i18n.t('detectionIntelligence.vehiclesList.vehicle', 'Vehicle'),
      sortValue: (vehicle) => vehicle.name,
      render: (vehicle) => (
        <span className="flex min-w-0 items-center gap-2">
          {/* Cover crop — off the event-media plane by `coverMediaId` (the plate
              twin of the People avatar), so it rides the browser's `immutable`
              cache instead of the JSON. `coverBase64` remains the fallback. */}
          <span className="h-8 w-12 shrink-0 overflow-hidden rounded border border-border bg-surface-hover">
            <MediaIdImage
              mediaId={vehicle.coverMediaId}
              base64={vehicle.coverBase64}
              alt={vehicle.name}
              className="h-full w-full object-cover"
              placeholder={
                <span className="flex h-full w-full items-center justify-center">
                  <Car className="h-4 w-4 text-foreground-subtle" />
                </span>
              }
            />
          </span>
          <span className="truncate text-sm font-medium text-foreground">{vehicle.name}</span>
        </span>
      ),
    },
    {
      key: 'samples',
      header: i18n.t('detectionIntelligence.vehiclesList.plates', 'Plates'),
      align: 'center',
      nowrap: true,
      sortValue: (vehicle) => vehicle.sampleCount,
      render: (vehicle) => (
        <Badge variant="default" className="text-[10px]">
          {vehicle.sampleCount}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      nowrap: true,
      notSortableReason: 'Actions',
      render: (vehicle) => (
        <span className="flex items-center justify-end gap-1">
          <IconButton
            variant="ghost"
            size="sm"
            icon={Pencil}
            aria-label={i18n.t('detectionIntelligence.vehiclesList.edit', 'Edit {{name}}', {
              name: vehicle.name,
            })}
            onClick={(event) => {
              event.stopPropagation()
              deps.onEdit(vehicle)
            }}
          />
          <IconButton
            variant="ghost"
            size="sm"
            icon={Trash2}
            aria-label={i18n.t('detectionIntelligence.vehiclesList.delete', 'Delete {{name}}', {
              name: vehicle.name,
            })}
            onClick={(event) => {
              event.stopPropagation()
              deps.onDelete(vehicle)
            }}
          />
        </span>
      ),
    },
  ]
}

// ── Vehicle form dialog ───────────────────────────────────────────────────────

interface VehicleFormDialogProps {
  readonly mode: 'new' | 'edit'
  readonly vehicle: Vehicle | null
  readonly onClose: () => void
}

function VehicleFormDialog({ mode, vehicle, onClose }: VehicleFormDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [name, setName] = useState(mode === 'edit' ? (vehicle?.name ?? '') : '')
  const createVehicle = usePlateGalleryCreateVehicle()
  const renameVehicle = usePlateGalleryRenameVehicle()

  useEffect(() => {
    setName(mode === 'edit' ? (vehicle?.name ?? '') : '')
  }, [mode, vehicle?.id, vehicle?.name])

  const saving = createVehicle.isPending || renameVehicle.isPending
  const trimmed = name.trim()
  const nameUnchanged = mode === 'edit' && vehicle !== null && trimmed === vehicle.name
  const saveDisabled = saving || trimmed.length === 0 || nameUnchanged

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey: PLATE_GALLERY_KEY })
  }

  function handleSave(): void {
    if (saveDisabled) return
    if (mode === 'new') {
      createVehicle.mutate(
        { name: trimmed },
        {
          onSuccess: () => {
            invalidate()
            onClose()
          },
        },
      )
      return
    }
    if (vehicle === null) {
      onClose()
      return
    }
    renameVehicle.mutate(
      { id: vehicle.id, name: trimmed },
      {
        onSuccess: () => {
          invalidate()
          onClose()
        },
      },
    )
  }

  const title = mode === 'new' ? 'Add vehicle' : `Edit ${vehicle?.name ?? 'vehicle'}`

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      title={title}
      icon={Car}
      width={mode === 'edit' ? 'xl' : 'lg'}
      testId="vehicles-vehicle-form"
      footer={
        <Button
          variant="primary"
          size="sm"
          type="button"
          onClick={handleSave}
          disabled={saveDisabled}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {mode === 'new' ? t('common.add', 'Add') : t('common.save', 'Save')}
        </Button>
      }
    >
      <div className="space-y-4">
        <FormField label={t('detectionIntelligence.vehiclesList.name', 'Name')} required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave()
            }}
            placeholder={t('detectionIntelligence.vehiclesList.vehicleName', 'Vehicle name…')}
            autoFocus
          />
        </FormField>

        {mode === 'edit' && vehicle !== null && (
          <div>
            <p className="mb-1 text-[11px] font-medium text-foreground">
              {t('detectionIntelligence.vehiclesList.plateSamples', 'Plate samples')}
            </p>
            <p className="mb-2 text-[11px] text-foreground-subtle">
              {t(
                'detectionIntelligence.vehiclesList.removeAPlateCropTo',
                'Remove a plate crop to drop it from recognition for this vehicle. Assign new plates from Recent recognized plates.',
              )}
            </p>
            <SamplesGrid vehicleId={vehicle.id} />
          </div>
        )}
      </div>
    </ItemFormDialog>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

export function VehiclesList() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const { data: vehicles, isLoading } = usePlateGalleryListVehicles()
  const deleteVehicle = usePlateGalleryDeleteVehicle()
  const { state: formUrl, openNew, openEdit, close: closeForm } = useItemFormUrl()

  const rows = vehicles ?? []
  const filter = useDataTableFilter(rows, {
    searchText: (vehicle) => [vehicle.name],
  })

  const editingVehicle =
    formUrl.mode === 'edit' ? (rows.find((vehicle) => vehicle.id === formUrl.id) ?? null) : null

  // A stale `?edit=` (vehicle deleted elsewhere) must not leave the dialog open
  // on a missing row.
  useEffect(() => {
    if (formUrl.mode === 'edit' && !isLoading && editingVehicle === null) {
      closeForm()
    }
  }, [formUrl.mode, isLoading, editingVehicle, closeForm])

  const columns = useMemo(
    () =>
      vehiclesColumns({
        onEdit: (vehicle) => openEdit(vehicle.id),
        onDelete: (vehicle) => {
          void (async () => {
            const ok = await confirm({
              title: t('detectionIntelligence.vehiclesList.deleteVehicle', 'Delete vehicle'),
              message: t(
                'detectionIntelligence.vehiclesList.deleteAndAllItsPlate',
                'Delete {{name}} and all its plate samples? This cannot be undone.',
                { name: vehicle.name },
              ),
              confirmLabel: t('common.delete', 'Delete'),
              variant: 'danger',
            })
            if (!ok) return
            deleteVehicle.mutate(
              { id: vehicle.id },
              {
                onSettled: () => {
                  void queryClient.invalidateQueries({ queryKey: PLATE_GALLERY_KEY })
                  if (formUrl.mode === 'edit' && formUrl.id === vehicle.id) closeForm()
                },
              },
            )
          })()
        },
      }),
    [confirm, closeForm, deleteVehicle, formUrl, openEdit, queryClient, t],
  )

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-foreground-subtle">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('detectionIntelligence.vehiclesList.loadingVehicles', 'Loading vehicles…')}
      </div>
    )
  }

  const formOpen = formUrl.mode === 'new' || (formUrl.mode === 'edit' && editingVehicle !== null)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" type="button" onClick={openNew}>
          <Plus className="h-3.5 w-3.5" />
          {t('detectionIntelligence.vehiclesList.addVehicle', 'Add vehicle')}
        </Button>
      </div>

      {(rows.length > 0 || filter.active) && (
        <DataTableFilterBar
          state={filter.state}
          facets={filter.facets}
          labels={{
            searchPlaceholder: 'Search vehicles…',
            searchLabel: 'Search vehicles',
            facetsLabel: 'Filter',
            clearLabel: 'Clear',
          }}
          onSearch={filter.setSearch}
          onToggleFacet={filter.toggleFacet}
          onClear={filter.clear}
        />
      )}

      {filter.rows.length === 0 ? (
        <EmptyState
          icon={Car}
          title={
            filter.active
              ? t(
                  'detectionIntelligence.vehiclesList.nothingMatchesTheFilter',
                  'Nothing matches the filter',
                )
              : t(
                  'detectionIntelligence.vehiclesList.noVehiclesEnrolledYet',
                  'No vehicles enrolled yet',
                )
          }
          description={
            filter.active
              ? t(
                  'detectionIntelligence.vehiclesList.clearTheSearchOrTry',
                  'Clear the search or try another name.',
                )
              : t(
                  'detectionIntelligence.vehiclesList.addAVehicleThenAssign',
                  'Add a vehicle, then assign plate crops from Recent recognized plates.',
                )
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={filter.rows}
          rowKey={(vehicle) => vehicle.id}
          maxBodyHeight={TABLE_SCROLL_MAX_H}
          emptyMessage={t(
            'detectionIntelligence.vehiclesList.noVehiclesEnrolledYet2',
            'No vehicles enrolled yet.',
          )}
          onRowClick={(vehicle) => openEdit(vehicle.id)}
        />
      )}

      {formOpen && (
        <VehicleFormDialog
          mode={formUrl.mode === 'new' ? 'new' : 'edit'}
          vehicle={editingVehicle}
          onClose={closeForm}
        />
      )}
    </div>
  )
}
