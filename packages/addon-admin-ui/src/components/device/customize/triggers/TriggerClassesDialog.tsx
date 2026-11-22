/** Which detected classes of a camera fire a linked trigger. At least one stays on. */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ToggleChipRow,
} from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DETECTION_CLASSES, type DetectionClass } from './linked-triggers-model'

export interface TriggerClassesDialogProps {
  readonly deviceName: string
  readonly classes: readonly DetectionClass[]
  readonly busy: boolean
  readonly onSave: (classes: readonly DetectionClass[]) => void
  readonly onClose: () => void
}

export function TriggerClassesDialog({
  deviceName,
  classes,
  busy,
  onSave,
  onClose,
}: TriggerClassesDialogProps): ReactNode {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<readonly DetectionClass[]>(classes)
  const title = t('customize.triggers.classesTitle', { name: deviceName })
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent width="md" placement="sheet-on-mobile" aria-label={title}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-1 p-2 sm:p-4">
          <span className="text-xs text-foreground-muted">
            {t('customize.triggers.classesLabel')}
          </span>
          <ToggleChipRow
            chips={DETECTION_CLASSES.map((id) => ({
              id,
              label: t(`customize.triggers.classes.${id}`),
            }))}
            off={new Set(DETECTION_CLASSES.filter((id) => !draft.includes(id)))}
            allLabel={t('customize.triggers.anyClass')}
            ariaLabel={t('customize.triggers.classesLabel')}
            onChange={(off) => {
              const next = DETECTION_CLASSES.filter((id) => !off.has(id))
              if (next.length > 0) setDraft(next)
            }}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="button" disabled={busy} onClick={() => onSave(draft)}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
