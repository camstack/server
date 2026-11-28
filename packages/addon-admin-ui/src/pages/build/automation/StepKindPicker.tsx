/**
 * "+ Step" asks WHICH step first. Nothing is added to the list until a kind is
 * chosen, so a blank step never appears (and never opens a modal) on its own.
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@dominevo/ui-library'
import { useTranslation } from 'react-i18next'
import type { ActionKind } from './recipe-parts'

/** What the picker hands back: the kind of step to add. */
export type StepChoice = ActionKind

export interface StepKindOption {
  readonly value: StepChoice
  readonly labelKey: string
}

export interface StepKindPickerProps {
  readonly open: boolean
  readonly options: readonly StepKindOption[]
  readonly onOpenChange: (open: boolean) => void
  readonly onPick: (choice: StepChoice) => void
}

export function StepKindPicker({ open, options, onOpenChange, onPick }: StepKindPickerProps) {
  const { t } = useTranslation()
  if (!open) return null
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>{t('automation.actionList.pickKindTitle', 'Add a step')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="grid gap-2" data-testid="step-kind-picker">
          {options.map((option) => (
            <Button
              key={option.value}
              variant="outline"
              className="justify-start"
              data-testid={`step-kind-option-${option.value}`}
              onClick={() => onPick(option.value)}
            >
              {t(option.labelKey)}
            </Button>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
