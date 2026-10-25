/**
 * Publish one numeric field converted to another unit in its dimension.
 */
import { convertUnitTargets } from '@camstack/types'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
} from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface ConvertUnitDialogProps {
  readonly open: boolean
  readonly from: string
  readonly initialTo: string | null
  readonly onClose: () => void
  readonly onSave: (to: string) => void
}

export function ConvertUnitDialog({
  open,
  from,
  initialTo,
  onClose,
  onSave,
}: ConvertUnitDialogProps): ReactNode {
  const { t } = useTranslation()
  const targets = convertUnitTargets(from)
  const [to, setTo] = useState(initialTo ?? targets[0] ?? '')
  const chosen = targets.includes(to) ? to : (targets[0] ?? '')
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        width="sm"
        scroll="body"
        placement="sheet-on-mobile"
        data-testid="convert-unit-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('customize.override.convertTitle')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2">
          <p className="text-xs text-foreground">
            {t('customize.override.convertSummary', { from, to: chosen })}
          </p>
          {targets.length > 1 && (
            <Select
              aria-label={t('customize.override.targetUnit')}
              value={chosen}
              onChange={(event) => setTo(event.target.value)}
              options={targets.map((unit) => ({ value: unit, label: unit }))}
            />
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('compositionEditor.cancel')}
          </Button>
          <Button
            data-testid="convert-unit-publish"
            disabled={chosen === '' || chosen === from}
            onClick={() => {
              onSave(chosen)
              onClose()
            }}
          >
            {t('customize.override.publish')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
