/**
 * One fan preset: a name and the ordered steps that put the fan (and the lamp,
 * the dimmer, the switch beside it) where the operator wants. "Use current
 * values" asks the hub to read the live state and fill the steps — the result
 * is shown here for review, with every reading it could not take named. Nothing
 * is saved until Save.
 */
import {
  type ActionStep,
  type AutomationAction,
  type FanCaptureOmission,
  type FanPreset,
} from '@camstack/types'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorBox,
  FormField,
  Input,
  useFanPresetsCapturePreset,
} from '@camstack/ui-library'
import { Camera, Loader2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActionList } from '../../pages/build/automation/ActionList'
import type { AutomationDevice } from '../../pages/build/automation/automation-data'
import { checkPresetDraft, omissionText, type PresetCheck } from './fan-presets-model'

export interface FanPresetDialogProps {
  readonly fanId: number
  readonly draft: FanPreset
  /** The other presets, for the duplicate-name check. */
  readonly others: readonly FanPreset[]
  /** The fan and its siblings — the only devices a step may name. */
  readonly devices: readonly AutomationDevice[]
  readonly saving: boolean
  readonly error: string | null
  readonly onSave: (preset: FanPreset) => void
  readonly onClose: () => void
}

function isActionStep(action: AutomationAction): action is ActionStep {
  return action.kind === 'cap' || action.kind === 'wait'
}

function useProblemText(): (check: PresetCheck) => string | null {
  const { t } = useTranslation()
  return (check) => {
    if (check.ok) return null
    switch (check.reason) {
      case 'no-name':
        return t('fanPresets.problem.name', 'Give the preset a name.')
      case 'no-steps':
        return t('fanPresets.problem.noSteps', 'Add at least one step, or use the current values.')
      case 'duplicate-name':
        return t('fanPresets.problem.duplicate', 'Another preset already has this name.')
    }
  }
}

export function FanPresetDialog({
  fanId,
  draft: initial,
  others,
  devices,
  saving,
  error,
  onSave,
  onClose,
}: FanPresetDialogProps): ReactNode {
  const { t } = useTranslation()
  const problemText = useProblemText()
  const [draft, setDraft] = useState<FanPreset>(initial)
  const [omitted, setOmitted] = useState<readonly FanCaptureOmission[]>([])
  const capture = useFanPresetsCapturePreset(
    { deviceId: fanId, steps: draft.steps },
    { enabled: false, gcTime: 0, retry: false },
  )
  const check = checkPresetDraft(others, draft)
  const problem = problemText(check)

  const useCurrent = (): void => {
    void capture.refetch().then((result) => {
      if (result.data === undefined) return
      setDraft((d) => ({ ...d, steps: result.data.steps }))
      setOmitted(result.data.omitted)
    })
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="xl" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>{t('fanPresets.dialog.title', 'Fan preset')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-3" data-testid="fan-preset-editor">
            <FormField label={t('fanPresets.dialog.name', 'Name')}>
              <Input
                value={draft.name}
                maxLength={40}
                placeholder={t('fanPresets.dialog.namePlaceholder', 'Night, Boost, Away…')}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </FormField>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-foreground-muted">
                {t(
                  'fanPresets.dialog.stepsHint',
                  'Steps run in order, on this fan and the devices beside it.',
                )}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={capture.isFetching}
                onClick={useCurrent}
                data-testid="fan-preset-use-current"
              >
                {capture.isFetching ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Camera className="h-4 w-4" />
                )}{' '}
                {t('fanPresets.dialog.useCurrent', 'Use current values')}
              </Button>
            </div>
            {capture.isError && (
              <ErrorBox
                message={
                  capture.error?.message ??
                  t('fanPresets.dialog.captureFailed', 'The current values could not be read.')
                }
              />
            )}
            {omitted.length > 0 && (
              <div
                role="status"
                className="rounded border border-warning/40 bg-warning/10 p-3 text-xs text-warning"
                data-testid="fan-preset-omitted"
              >
                <p>
                  {t(
                    'fanPresets.dialog.omitted',
                    'These values could not be read, so they were left out:',
                  )}
                </p>
                <ul className="mt-1 list-disc pl-4">
                  {omitted.map((o) => (
                    <li key={`${o.what}:${o.reason}`}>{omissionText(o)}</li>
                  ))}
                </ul>
              </div>
            )}
            <ActionList
              actions={draft.steps}
              devices={devices}
              allowedKinds={['cap', 'wait']}
              onChange={(steps) => setDraft({ ...draft, steps: steps.filter(isActionStep) })}
            />
            {problem !== null && draft.name !== '' && (
              <p className="text-xs text-warning">{problem}</p>
            )}
            {error !== null && <ErrorBox message={error} />}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            disabled={saving || !check.ok}
            onClick={() => onSave({ ...draft, name: draft.name.trim() })}
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} {t('common.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
