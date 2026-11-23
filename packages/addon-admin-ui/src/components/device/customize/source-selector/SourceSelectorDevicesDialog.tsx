/**
 * The dialog a Customize surface opens to link devices: the `SourceSelector`
 * device step, a draft the host confirms explicitly, Cancel and an
 * "Add N" button.
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@camstack/ui-library'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssignmentCandidate, AssignmentFilter } from '../assignments/assignment-candidates'
import type { RoomSuggestions } from '../assignments/room-suggestions'
import type { Known } from '../known'
import { SourceSelector } from './SourceSelector'
import type { SourceSelectorDevicesSelection } from './SourceSelectorDevices'

export interface SourceSelectorDevicesDialogProps {
  readonly open: boolean
  readonly title: string
  readonly selection: SourceSelectorDevicesSelection
  readonly candidates: Known<readonly AssignmentCandidate[]>
  readonly filters?: readonly AssignmentFilter[]
  readonly room?: RoomSuggestions | null
  readonly confirmLabel: (count: number) => string
  readonly onConfirm: (picked: readonly AssignmentCandidate[]) => void
  readonly onClose: () => void
}

export function SourceSelectorDevicesDialog({
  open,
  title,
  selection,
  candidates,
  filters,
  room = null,
  confirmLabel,
  onConfirm,
  onClose,
}: SourceSelectorDevicesDialogProps): ReactNode {
  const { t } = useTranslation()
  const [picked, setPicked] = useState<readonly number[]>([])
  const answered = candidates.kind === 'known' ? candidates.value : []
  const pickedCandidates = answered.filter((c) => picked.includes(c.deviceId))

  useEffect(() => {
    if (!open) setPicked([])
  }, [open])

  const close = (): void => {
    setPicked([])
    onClose()
  }
  const confirmWith = (chosen: readonly AssignmentCandidate[]): void => {
    if (chosen.length === 0) return
    onConfirm(chosen)
    setPicked([])
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body" aria-label={title}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2 p-2 sm:p-4">
          <SourceSelector
            kind="devices"
            selection={selection}
            candidates={candidates}
            {...(filters !== undefined ? { filters } : {})}
            room={room}
            picked={picked}
            onPickedChange={setPicked}
            onChoose={confirmWith}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {t('customize.picker.cancel')}
          </Button>
          <Button
            disabled={pickedCandidates.length === 0}
            onClick={() => confirmWith(pickedCandidates)}
          >
            {confirmLabel(pickedCandidates.length)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
