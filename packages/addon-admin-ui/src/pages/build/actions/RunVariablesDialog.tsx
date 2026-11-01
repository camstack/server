/**
 * Asks for an action's variables before it runs from the editor. Shown when a
 * required variable has no default; the run starts only once each required one
 * is answered, and the answers go out through `actions.run`'s `variables`.
 */

import type { ActionVariable } from '@camstack/types'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@camstack/ui-library'
import { Loader2, Play } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DraftNumberInput } from '../flow/DraftNumberInput'
import { FixedSelect } from '../flow/FixedSelect'
import {
  initialRunValues,
  missingRunValues,
  type RunValue,
  type RunValues,
  runVariablesOf,
} from './run-variables'

export interface RunVariablesDialogProps {
  readonly actionName: string
  readonly variables: readonly ActionVariable[]
  readonly running: boolean
  readonly onRun: (variables: Record<string, RunValue>) => void
  readonly onCancel: () => void
}

interface FieldProps {
  readonly variable: ActionVariable
  readonly value: RunValue | undefined
  readonly onChange: (next: RunValue | undefined) => void
}

function VariableField({ variable, value, onChange }: FieldProps) {
  const { t } = useTranslation()
  const label = variable.label ?? variable.name
  if (variable.type === 'number') {
    return (
      <DraftNumberInput
        aria-label={label}
        value={typeof value === 'number' ? value : undefined}
        onValue={(n) => onChange(n ?? undefined)}
      />
    )
  }
  if (variable.type === 'boolean') {
    return (
      <FixedSelect
        widthClass="w-28"
        aria-label={label}
        value={value === true ? 'yes' : 'no'}
        onChange={(e) => onChange(e.target.value === 'yes')}
        options={[
          { value: 'yes', label: t('common.yes', 'Yes') },
          { value: 'no', label: t('common.no', 'No') },
        ]}
      />
    )
  }
  if (variable.type === 'select') {
    return (
      <FixedSelect
        widthClass="w-48"
        aria-label={label}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        options={[
          { value: '', label: t('actions.editor.runDialog.choose', 'Choose…') },
          ...(variable.options ?? []).map((o) => ({ value: o, label: o })),
        ]}
      />
    )
  }
  return (
    <Input
      aria-label={label}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function RunVariablesDialog({
  actionName,
  variables,
  running,
  onRun,
  onCancel,
}: RunVariablesDialogProps) {
  const { t } = useTranslation()
  const [values, setValues] = useState<RunValues>(() => initialRunValues(variables))
  const missing = missingRunValues(variables, values)
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        aria-label={t('actions.editor.runDialog.title', 'Run {{name}}', { name: actionName })}
      >
        <DialogHeader>
          <DialogTitle>
            {t('actions.editor.runDialog.title', 'Run {{name}}', { name: actionName })}
          </DialogTitle>
          <DialogDescription>
            {t('actions.editor.runDialog.description', 'Give the variables this run should use.')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3" data-testid="run-variables-form">
          {variables.map((v) => (
            <label key={v.name} className="block space-y-1">
              <span className="text-xs text-foreground-subtle">
                {v.label ?? v.name}
                {v.required === true ? ' *' : ''}
              </span>
              <VariableField
                variable={v}
                value={values[v.name]}
                onChange={(next) => setValues({ ...values, [v.name]: next })}
              />
            </label>
          ))}
        </div>
        <DialogFooter className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            disabled={running || missing.length > 0}
            onClick={() => onRun(runVariablesOf(variables, values))}
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}{' '}
            {t('actions.editor.runNow', 'Run now')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
