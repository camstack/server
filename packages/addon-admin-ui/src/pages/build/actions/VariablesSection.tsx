/**
 * The variables an action declares: name, label, type, default, and (for a
 * select) the options. A caller may override each one when it runs the action;
 * in a step, the "{x}" button puts one into an argument.
 */

import type { ActionVariable, ActionVariableType } from '@camstack/types'
import { Button, Input, SectionCard } from '@camstack/ui-library'
import { Plus, Trash2, Variable } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { DraftNumberInput } from '../flow/DraftNumberInput'
import { FixedSelect } from '../flow/FixedSelect'
import { isValidVariableName, newVariable } from './action-draft'

const TYPES: readonly ActionVariableType[] = ['number', 'string', 'boolean', 'select']

export interface VariablesSectionProps {
  readonly variables: readonly ActionVariable[]
  readonly onChange: (next: readonly ActionVariable[]) => void
  /** Rename goes through the draft so steps naming the variable follow. */
  readonly onRename: (index: number, name: string) => void
}

/** The variable with its type switched: default and options do not carry over. */
function withType(variable: ActionVariable, type: ActionVariableType): ActionVariable {
  return {
    name: variable.name,
    ...(variable.label === undefined ? {} : { label: variable.label }),
    type,
    ...(type === 'select' ? { options: variable.options ?? ['option'] } : {}),
  }
}

function withOptions(variable: ActionVariable, text: string): ActionVariable {
  const options = text
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '')
  const keepDefault =
    variable.default !== undefined &&
    typeof variable.default === 'string' &&
    options.includes(variable.default)
  const { default: _dropped, ...rest } = variable
  return {
    ...(keepDefault ? variable : rest),
    options: options.length === 0 ? ['option'] : options,
  }
}

function withDefault(
  variable: ActionVariable,
  value: string | number | boolean | null,
): ActionVariable {
  const { default: _dropped, ...rest } = variable
  return value === null ? rest : { ...rest, default: value }
}

function withLabel(variable: ActionVariable, label: string): ActionVariable {
  const { label: _dropped, ...rest } = variable
  return label.trim() === '' ? rest : { ...rest, label }
}

export function VariablesSection({ variables, onChange, onRename }: VariablesSectionProps) {
  const { t } = useTranslation()
  const typeLabel = (type: ActionVariableType): string => {
    switch (type) {
      case 'number':
        return t('actions.variables.typeNumber', 'number')
      case 'string':
        return t('actions.variables.typeText', 'text')
      case 'boolean':
        return t('actions.variables.typeBoolean', 'yes / no')
      default:
        return t('actions.variables.typeSelect', 'select')
    }
  }
  const replace = (index: number, next: ActionVariable): void =>
    onChange(variables.map((v, i) => (i === index ? next : v)))
  return (
    <SectionCard
      headingId="vars-heading"
      title={t('actions.variables.title', 'Variables')}
      icon={Variable}
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange([...variables, newVariable(variables)])}
        >
          <Plus className="h-4 w-4" /> {t('actions.variables.add', 'Variable')}
        </Button>
      }
    >
      <div className="space-y-3 p-3">
        {variables.map((v, index) => (
          <div
            key={`${String(index)}`}
            className="grid gap-2 sm:grid-cols-[1fr_1fr_8rem_1fr_1.2fr_auto] sm:items-end"
            data-testid="variable-row"
          >
            <label className="space-y-1">
              <span className="text-xs text-foreground-subtle">
                {t('actions.variables.name', 'Name')}
              </span>
              <Input
                aria-label={t('actions.variables.nameAria', 'Variable name')}
                value={v.name}
                aria-invalid={!isValidVariableName(v.name)}
                onChange={(e) => onRename(index, e.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-foreground-subtle">
                {t('actions.variables.label', 'Label')}
              </span>
              <Input
                aria-label={t('actions.variables.label', 'Label')}
                value={v.label ?? ''}
                onChange={(e) => replace(index, withLabel(v, e.target.value))}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-foreground-subtle">
                {t('actions.variables.type', 'Type')}
              </span>
              <FixedSelect
                widthClass="w-full"
                aria-label={t('actions.variables.type', 'Type')}
                value={v.type}
                options={TYPES.map((type) => ({ value: type, label: typeLabel(type) }))}
                onChange={(e) => {
                  const picked = TYPES.find((type) => type === e.target.value)
                  if (picked !== undefined) replace(index, withType(v, picked))
                }}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-foreground-subtle">
                {t('actions.variables.default', 'Default')}
              </span>
              <DefaultField
                variable={v}
                onChange={(value) => replace(index, withDefault(v, value))}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-foreground-subtle">
                {t('actions.variables.options', 'Options')}
              </span>
              <Input
                aria-label={t('actions.variables.options', 'Options')}
                value={(v.options ?? []).join(', ')}
                disabled={v.type !== 'select'}
                placeholder={t('actions.variables.optionsHint', 'Only for a select')}
                onChange={(e) => replace(index, withOptions(v, e.target.value))}
              />
            </label>
            <Button
              variant="ghost"
              aria-label={t('actions.variables.remove', 'Remove variable')}
              onClick={() => onChange(variables.filter((_, i) => i !== index))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <p className="text-xs text-foreground-subtle">
          {t(
            'actions.variables.hint',
            'Callers can override a variable. In a step, the {x} button puts one in an argument.',
          )}
        </p>
      </div>
    </SectionCard>
  )
}

interface DefaultFieldProps {
  readonly variable: ActionVariable
  readonly onChange: (value: string | number | boolean | null) => void
}

function DefaultField({ variable, onChange }: DefaultFieldProps) {
  const { t } = useTranslation()
  const label = t('actions.variables.default', 'Default')
  if (variable.type === 'number') {
    return (
      <DraftNumberInput
        aria-label={label}
        value={typeof variable.default === 'number' ? variable.default : undefined}
        onValue={onChange}
      />
    )
  }
  if (variable.type === 'boolean' || variable.type === 'select') {
    const choices =
      variable.type === 'boolean'
        ? [
            { value: 'true', label: t('common.yes', 'Yes') },
            { value: 'false', label: t('common.no', 'No') },
          ]
        : (variable.options ?? []).map((o) => ({ value: o, label: o }))
    return (
      <FixedSelect
        widthClass="w-full"
        aria-label={label}
        value={variable.default === undefined ? '' : String(variable.default)}
        options={[{ value: '', label: t('actions.variables.noDefault', 'None') }, ...choices]}
        onChange={(e) => {
          if (e.target.value === '') onChange(null)
          else onChange(variable.type === 'boolean' ? e.target.value === 'true' : e.target.value)
        }}
      />
    )
  }
  return (
    <Input
      aria-label={label}
      value={typeof variable.default === 'string' ? variable.default : ''}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    />
  )
}
