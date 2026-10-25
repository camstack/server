/**
 * AssignDialog — assign one or many faces to an existing person, or create a
 * new one. Shared by three flows: single face-card assign, batch-select
 * assign, and the SimilarGroupsModal's "Adopt" action.
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import {
  useFaceGalleryAssignFaces,
  useFaceGalleryCreateIdentity,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Input,
} from '@camstack/ui-library'
import type { Identity } from './types.js'
import { useTranslation } from 'react-i18next'

const FACE_GALLERY_KEY = [['faceGallery']]

interface AssignDialogProps {
  /** Faces to assign. Empty/closed when null. */
  readonly faceIds: readonly string[] | null
  readonly identities: readonly Identity[]
  readonly onDone: () => void
}

export function AssignDialog({ faceIds, identities, onDone }: AssignDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const assignFaces = useFaceGalleryAssignFaces()
  const createIdentity = useFaceGalleryCreateIdentity()
  const [newPersonName, setNewPersonName] = useState('')
  const [showNewPerson, setShowNewPerson] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const open = faceIds !== null && faceIds.length > 0
  const count = faceIds?.length ?? 0

  function reset() {
    setShowNewPerson(false)
    setNewPersonName('')
    setSelectedId(null)
  }
  function finish() {
    reset()
    onDone()
  }

  function assignTo(identityId: string) {
    if (!faceIds || faceIds.length === 0) return
    assignFaces.mutate(
      { faceIds: [...faceIds], identityId },
      {
        onSettled: () => {
          void queryClient.invalidateQueries({ queryKey: FACE_GALLERY_KEY })
          finish()
        },
      },
    )
  }

  function createAndAssign() {
    if (!faceIds || !newPersonName.trim()) return
    createIdentity.mutate(
      { name: newPersonName.trim() },
      {
        onSuccess: (created) => {
          if (created?.id) assignTo(created.id)
        },
        onError: () => {
          void queryClient.invalidateQueries({ queryKey: FACE_GALLERY_KEY })
          finish()
        },
      },
    )
  }

  const isPending = assignFaces.isPending || createIdentity.isPending

  return (
    <Dialog open={open} onOpenChange={(o) => !o && finish()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {count > 1
              ? t(
                  'detectionIntelligence.assignDialog.assignFacesToPerson',
                  'Assign {{value1}} faces to person',
                  { value1: String(count) },
                )
              : t('detectionIntelligence.assignDialog.assignFaceToPerson', 'Assign face to person')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'detectionIntelligence.assignDialog.selectAnExistingPersonOr',
              'Select an existing person or create a new one.',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1 max-h-56 overflow-y-auto">
          {identities.map((identity) => (
            <button
              key={identity.id}
              type="button"
              onClick={() => setSelectedId(identity.id)}
              className={`w-full rounded-md px-3 py-2 text-left text-xs transition-colors ${
                selectedId === identity.id
                  ? 'bg-primary/12 text-primary'
                  : 'hover:bg-surface-hover text-foreground'
              }`}
            >
              <span className="font-medium">{identity.name}</span>
              <span className="ml-2 text-foreground-subtle">
                {t('detectionIntelligence.assignDialog.samples', { count: identity.sampleCount })}
              </span>
            </button>
          ))}
        </div>

        <div className="min-h-[2.75rem] border-t border-border pt-2">
          {showNewPerson ? (
            <div className="flex items-center gap-2">
              <Input
                placeholder={t(
                  'detectionIntelligence.assignDialog.newPersonName',
                  'New person name…',
                )}
                value={newPersonName}
                onChange={(e) => setNewPersonName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createAndAssign()
                }}
                autoFocus
                className="flex-1"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setSelectedId(null)
                setShowNewPerson(true)
              }}
              className="w-full rounded-md border border-dashed border-border px-3 py-2 text-left text-xs text-foreground-subtle transition-colors hover:border-primary hover:text-primary"
            >
              {t('detectionIntelligence.assignDialog.newPerson', '+ New person…')}
            </button>
          )}
        </div>

        <DialogFooter className="min-h-[2.75rem]">
          <Button variant="secondary" onClick={finish} disabled={isPending}>
            {t('common.cancel', 'Cancel')}
          </Button>
          {showNewPerson ? (
            <Button
              variant="primary"
              onClick={createAndAssign}
              disabled={isPending || !newPersonName.trim()}
            >
              {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('detectionIntelligence.assignDialog.createAssign', 'Create & assign')}
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
