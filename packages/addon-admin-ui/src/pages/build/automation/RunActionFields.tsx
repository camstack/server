/**
 * THEN → "Run an action": pick one of the actions (`actions.list`) and give
 * each variable it declares a value. A variable left blank takes the action's
 * own default — the recipe stores only what the operator typed.
 */

import type { ActionEntry, ActionVariable, AutomationAction } from '@camstack/types'
import { Input, Select, Skeleton, useActionsList } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { DraftNumberInput } from '../flow/DraftNumberInput'
import { FixedSelect } from '../flow/FixedSelect'
import { PickerLabel } from './FieldPicker'

type RunActionStep = Extract<AutomationAction, { kind: 'action' }>
type VariableValues = NonNullable<RunActionStep['variables']>

const POLL_MS = 10_000

export interface RunActionFieldsProps {
  readonly step: RunActionStep
  readonly onChange: (next: RunActionStep) => void
}

/** The values with `name` set, or removed when blank. */
export function withVariable(
  values: VariableValues | undefined,
  name: string,
  value: string | number | boolean | null,
): VariableValues | undefined {
  const rest = Object.fromEntries(Object.entries(values ?? {}).filter(([key]) => key !== name))
  const next = value === null ? rest : { ...rest, [name]: value }
  return Object.keys(next).length === 0 ? undefined : next
}

function withValues(step: RunActionStep, values: VariableValues | undefined): RunActionStep {
  return {
    kind: 'action',
    actionId: step.actionId,
    ...(values === undefined ? {} : { variables: values }),
  }
}

export function RunActionFields({ step, onChange }: RunActionFieldsProps) {
  const { t } = useTranslation()
  const list = useActionsList({}, { refetchInterval: POLL_MS })
  if (list.data === undefined) return <Skeleton className="h-8 w-64" />
  const chosen = list.data.find((a: ActionEntry) => a.id === step.actionId)
  const stale = step.actionId !== '' && chosen === undefined
  return (
    <div className="space-y-2" data-testid="run-action-step">
      <label className="block max-w-sm">
        <PickerLabel>{t('automation.runAction.action', 'Action')}</PickerLabel>
        <Select
          value={step.actionId}
          onChange={(e) => onChange({ kind: 'action', actionId: e.target.value })}
          options={[
            { value: '', label: t('automation.runAction.pick', 'Pick an action') },
            ...(stale
              ? [
                  {
                    value: step.actionId,
                    label: t('automation.runAction.missing', 'Missing action ({{id}})', {
                      id: step.actionId,
                    }),
                  },
                ]
              : []),
            ...list.data.map((a: ActionEntry) => ({ value: a.id, label: a.name })),
          ]}
        />
      </label>
      {stale && (
        <p className="text-xs text-danger">
          {t(
            'automation.runAction.missingHint',
            'This action no longer exists. Pick another, or the step will fail.',
          )}
        </p>
      )}
      {(chosen?.variables ?? []).length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          {(chosen?.variables ?? []).map((v) => (
            <VariableField
              key={v.name}
              variable={v}
              value={step.variables?.[v.name]}
              onChange={(value) =>
                onChange(withValues(step, withVariable(step.variables, v.name, value)))
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface VariableFieldProps {
  readonly variable: ActionVariable
  readonly value: string | number | boolean | undefined
  readonly onChange: (value: string | number | boolean | null) => void
}

function VariableField({ variable, value, onChange }: VariableFieldProps) {
  const { t } = useTranslation()
  const label = variable.label ?? variable.name
  const blankHint =
    variable.default === undefined
      ? t('automation.runAction.required', 'required')
      : t('automation.runAction.defaultIs', 'default {{value}}', {
          value: String(variable.default),
        })
  if (variable.type === 'boolean' || variable.type === 'select') {
    const choices =
      variable.type === 'boolean'
        ? [
            { value: 'true', label: t('common.yes', 'Yes') },
            { value: 'false', label: t('common.no', 'No') },
          ]
        : (variable.options ?? []).map((o) => ({ value: o, label: o }))
    return (
      <label className="block">
        <PickerLabel>{label}</PickerLabel>
        <FixedSelect
          widthClass="w-40"
          value={value === undefined ? '' : String(value)}
          onChange={(e) => {
            if (e.target.value === '') onChange(null)
            else onChange(variable.type === 'boolean' ? e.target.value === 'true' : e.target.value)
          }}
          options={[{ value: '', label: blankHint }, ...choices]}
        />
      </label>
    )
  }
  if (variable.type === 'number') {
    return (
      <label className="block">
        <PickerLabel>{label}</PickerLabel>
        <DraftNumberInput
          className="w-40"
          placeholder={blankHint}
          value={typeof value === 'number' ? value : undefined}
          onValue={onChange}
        />
      </label>
    )
  }
  return (
    <label className="block">
      <PickerLabel>{label}</PickerLabel>
      <Input
        className="w-40"
        placeholder={blankHint}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      />
    </label>
  )
}
