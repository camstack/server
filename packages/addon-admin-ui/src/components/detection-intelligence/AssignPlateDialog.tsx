/**
 * AssignPlateDialog — assign one or many plate reads to an existing vehicle, or
 * create a new one. Shared by the single plate-card assign and the batch-select
 * assign flows (mirrors the faces `AssignDialog`).
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import {
  usePlateGalleryAssignPlates,
  usePlateGalleryCreateVehicle,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Input,
} from '@camstack/ui-library'
import type { Vehicle } from './plate-types.js'
import { useTranslation } from 'react-i18next'

const PLATE_GALLERY_KEY = [['plateGallery']]

interface AssignPlateDialogProps {
  /** Plates to assign. Empty/closed when null. */
  readonly plateIds: readonly string[] | null
  readonly vehicles: readonly Vehicle[]
  readonly onDone: () => void
}

export function AssignPlateDialog({ plateIds, vehicles, onDone }: AssignPlateDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const assignPlates = usePlateGalleryAssignPlates()
  const createVehicle = usePlateGalleryCreateVehicle()
  const [newVehicleName, setNewVehicleName] = useState('')
  const [showNewVehicle, setShowNewVehicle] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const open = plateIds !== null && plateIds.length > 0
  const count = plateIds?.length ?? 0

  function reset() {
    setShowNewVehicle(false)
    setNewVehicleName('')
    setSelectedId(null)
  }
  function finish() {
    reset()
    onDone()
  }

  function assignTo(vehicleId: string) {
    if (!plateIds || plateIds.length === 0) return
    assignPlates.mutate(
      { plateIds: [...plateIds], vehicleId },
      {
        onSettled: () => {
          void queryClient.invalidateQueries({ queryKey: PLATE_GALLERY_KEY })
          finish()
        },
      },
    )
  }

  function createAndAssign() {
    if (!plateIds || !newVehicleName.trim()) return
    createVehicle.mutate(
      { name: newVehicleName.trim() },
      {
        onSuccess: (created) => {
          if (created?.id) assignTo(created.id)
        },
        onError: () => {
          void queryClient.invalidateQueries({ queryKey: PLATE_GALLERY_KEY })
          finish()
        },
      },
    )
  }

  const isPending = assignPlates.isPending || createVehicle.isPending

  return (
    <Dialog open={open} onOpenChange={(o) => !o && finish()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {count > 1
              ? t(
                  'detectionIntelligence.assignPlateDialog.assignPlatesToVehicle',
                  'Assign {{value1}} plates to vehicle',
                  { value1: String(count) },
                )
              : t(
                  'detectionIntelligence.assignPlateDialog.assignPlateToVehicle',
                  'Assign plate to vehicle',
                )}
          </DialogTitle>
          <DialogDescription>
            {t(
              'detectionIntelligence.assignPlateDialog.selectAnExistingVehicleOr',
              'Select an existing vehicle or create a new one.',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1 max-h-56 overflow-y-auto">
          {vehicles.map((vehicle) => (
            <Button
              variant="unstyled"
              key={vehicle.id}
              type="button"
              onClick={() => setSelectedId(vehicle.id)}
              className={`w-full rounded-md px-3 py-2 text-left text-xs transition-colors ${
                selectedId === vehicle.id
                  ? 'bg-primary/12 text-primary'
                  : 'hover:bg-surface-hover text-foreground'
              }`}
            >
              <span className="font-medium">{vehicle.name}</span>
              <span className="ml-2 text-foreground-subtle">
                {t('detectionIntelligence.assignPlateDialog.plates', {
                  count: vehicle.sampleCount,
                })}
              </span>
            </Button>
          ))}
        </div>

        {showNewVehicle ? (
          <div className="flex items-center gap-2 pt-2 border-t border-border">
            <Input
              placeholder={t(
                'detectionIntelligence.assignPlateDialog.newVehicleName',
                'New vehicle name…',
              )}
              value={newVehicleName}
              onChange={(e) => setNewVehicleName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createAndAssign()
              }}
              autoFocus
              className="flex-1"
            />
          </div>
        ) : (
          <Button
            variant="unstyled"
            type="button"
            onClick={() => {
              setSelectedId(null)
              setShowNewVehicle(true)
            }}
            className="mt-2 w-full rounded-md border border-dashed border-border px-3 py-2 text-left text-xs text-foreground-subtle hover:border-primary hover:text-primary transition-colors"
          >
            {t('detectionIntelligence.assignPlateDialog.newVehicle', '+ New vehicle…')}
          </Button>
        )}

        <DialogFooter>
          <Button variant="secondary" onClick={finish} disabled={isPending}>
            {t('common.cancel', 'Cancel')}
          </Button>
          {showNewVehicle ? (
            <Button
              variant="primary"
              onClick={createAndAssign}
              disabled={isPending || !newVehicleName.trim()}
            >
              {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('detectionIntelligence.assignPlateDialog.createAssign', 'Create & assign')}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => selectedId && assignTo(selectedId)}
              disabled={isPending || !selectedId}
            >
              {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {count > 1 ? t('detectionIntelligence.assignCount', { count }) : t('common.assign')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
