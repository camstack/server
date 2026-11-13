/**
 * The inputs form of an automation made from a template (#527): the only thing
 * an operator fills in. One field per declared input, by kind — a device picker,
 * the events of the chosen device, the command editor, a number — and a
 * repeatable list of rows for a group. A problem the expansion reported for an
 * input is shown under that input, by its dotted address (`buttons.2.targets`).
 */
import {
  type AutomationTemplatePayload,
  type DeviceFiredLeaf,
  type TemplateActionValue,
  TemplateActionValueSchema,
  type TemplateEventValue,
  TemplateEventValueSchema,
  type TemplateGroupInput,
  type TemplateInputValue,
  type TemplateInputValues,
  type TemplateInstanceProblem,
  type TemplateScalarInput,
  type TemplateScalarValue,
} from '@camstack/types'
import {
  Button,
  DeviceValuePicker,
  FormField,
  IconButton,
  Input,
  Select,
  Switch,
} from '@camstack/ui-library'
import { Plus, Trash2 } from 'lucide-react'
import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CommandStep } from '../flow/CommandStep'
import { useAutomationDevices } from '../automation/automation-data'
import { FiredFields } from '../automation/FiredFields'
import { DurationValueInput } from './DurationValueInput'
import {
  groupBounds,
  problemsAt,
  rowsOf,
  withAddedRow,
  withRowValue,
  withValue,
  withoutRow,
} from './template-values'

type Siblings = Readonly<Record<string, TemplateInputValue>>

export interface TemplateInputsFormProps {
  readonly payload: AutomationTemplatePayload
  readonly values: TemplateInputValues
  readonly problems: readonly TemplateInstanceProblem[]
  readonly disabled?: boolean
  readonly onChange: (next: TemplateInputValues) => void
}

function deviceIdsOf(value: TemplateInputValue | undefined): readonly number[] {
  if (typeof value === 'number') return [value]
  if (Array.isArray(value)) return value.filter((v): v is number => typeof v === 'number')
  return []
}

function eventValueOf(value: TemplateInputValue | undefined): TemplateEventValue | undefined {
  const parsed = TemplateEventValueSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function actionValueOf(value: TemplateInputValue | undefined): TemplateActionValue | undefined {
  const parsed = TemplateActionValueSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function TemplateInputsForm({
  payload,
  values,
  problems,
  disabled = false,
  onChange,
}: TemplateInputsFormProps): ReactNode {
  return (
    <div className="space-y-4" data-testid="template-inputs-form">
      {payload.inputs.map((input) =>
        input.kind === 'group' ? (
          <GroupField
            key={input.key}
            group={input}
            values={values}
            problems={problems}
            disabled={disabled}
            onChange={onChange}
          />
        ) : (
          <ScalarField
            key={input.key}
            input={input}
            siblings={input.kind === 'event' || input.kind === 'action' ? payload.inputs : []}
            siblingValues={values}
            address={input.key}
            problems={problems}
            disabled={disabled}
            onChange={(next) => onChange(withValue(values, input.key, next))}
          />
        ),
      )}
    </div>
  )
}

interface GroupFieldProps {
  readonly group: TemplateGroupInput
  readonly values: TemplateInputValues
  readonly problems: readonly TemplateInstanceProblem[]
  readonly disabled: boolean
  readonly onChange: (next: TemplateInputValues) => void
}

function GroupField({ group, values, problems, disabled, onChange }: GroupFieldProps): ReactNode {
  const { t } = useTranslation()
  const rows = rowsOf(values, group.key)
  const bounds = groupBounds(group)
  const own = problemsAt(problems, group.key)
  return (
    <section className="space-y-2" data-testid={`template-group-${group.key}`}>
      <h4 className="text-sm font-medium text-foreground">{group.label}</h4>
      {own.map((p) => (
        <p key={p.detail} role="alert" className="text-xs text-danger">
          {p.detail}
        </p>
      ))}
      {rows.map((row, index) => (
        <div
          // The index is the row's address (`buttons.2.targets`); rows have no other identity.
          key={index}
          className="space-y-3 rounded-md border border-border bg-surface p-3"
          data-testid={`template-group-${group.key}-row`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground-muted">
              {t('build.templates.row', 'Row {{n}}', { n: index + 1 })}
            </span>
            <IconButton
              icon={Trash2}
              size="sm"
              variant="ghost"
              aria-label={t('build.templates.removeRow', 'Remove row')}
              disabled={disabled || rows.length <= bounds.min}
              onClick={() => onChange(withoutRow(values, group, index))}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {group.inputs.map((input) => (
              <ScalarField
                key={input.key}
                input={input}
                siblings={group.inputs}
                siblingValues={row}
                address={`${group.key}.${String(index)}.${input.key}`}
                problems={problems}
                disabled={disabled}
                onChange={(next) =>
                  onChange(withRowValue(values, group.key, index, input.key, next))
                }
              />
            ))}
          </div>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || rows.length >= bounds.max}
        onClick={() => onChange(withAddedRow(values, group))}
        data-testid={`template-group-${group.key}-add`}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {t('build.templates.addRow', 'Add row')}
      </Button>
    </section>
  )
}

interface ScalarFieldProps {
  readonly input: TemplateScalarInput
  /** The inputs beside this one — where an event or action input finds its device input. */
  readonly siblings: readonly { readonly key: string }[]
  readonly siblingValues: Siblings
  readonly address: string
  readonly problems: readonly TemplateInstanceProblem[]
  readonly disabled: boolean
  readonly onChange: (next: TemplateScalarValue | undefined) => void
}

function ScalarField({
  input,
  siblingValues,
  address,
  problems,
  disabled,
  onChange,
}: ScalarFieldProps): ReactNode {
  const own = problemsAt(problems, address)
  const error = own.length === 0 ? undefined : own.map((p) => p.detail).join(' ')
  const value = siblingValues[input.key]
  return (
    <FormField
      label={input.label}
      required={input.optional !== true}
      {...(input.description === undefined ? {} : { description: input.description })}
      {...(error === undefined ? {} : { error })}
      className="min-w-0"
    >
      <ScalarControl
        input={input}
        value={value}
        siblingValues={siblingValues}
        address={address}
        disabled={disabled}
        onChange={onChange}
      />
    </FormField>
  )
}

interface ScalarControlProps {
  readonly input: TemplateScalarInput
  readonly value: TemplateInputValue | undefined
  readonly siblingValues: Siblings
  readonly address: string
  readonly disabled: boolean
  readonly onChange: (next: TemplateScalarValue | undefined) => void
}

function ScalarControl({
  input,
  value,
  siblingValues,
  address,
  disabled,
  onChange,
}: ScalarControlProps): ReactNode {
  const { t } = useTranslation()
  const devices = useAutomationDevices()
  switch (input.kind) {
    case 'device': {
      const requires =
        input.filter?.capability === undefined
          ? {}
          : { requires: { caps: [input.filter.capability] } }
      const fixedTypes = input.filter?.role === undefined ? {} : { fixedTypes: [input.filter.role] }
      if (input.multiple === true) {
        return (
          <DeviceValuePicker
            pick="device"
            multiple
            {...requires}
            {...fixedTypes}
            recentKey={`template-input-${input.key}`}
            testId={`template-input-${address}`}
            disabled={disabled}
            value={deviceIdsOf(value).map((deviceId) => ({ deviceId }))}
            onChange={(next) => {
              const ids = next.map((p) => p.deviceId)
              onChange(ids.length === 0 ? undefined : ids)
            }}
          />
        )
      }
      const current = deviceIdsOf(value)[0]
      return (
        <DeviceValuePicker
          pick="device"
          {...requires}
          {...fixedTypes}
          recentKey={`template-input-${input.key}`}
          testId={`template-input-${address}`}
          disabled={disabled}
          value={current === undefined ? null : { deviceId: current }}
          onChange={(next) => onChange(next === null ? undefined : next.deviceId)}
        />
      )
    }
    case 'event': {
      const deviceId = deviceIdsOf(siblingValues[input.deviceInput])[0]
      if (deviceId === undefined) {
        return (
          <p className="text-xs text-foreground-subtle" data-testid={`template-input-${address}`}>
            {t('build.templates.pickDeviceFirst', 'Pick the device first.')}
          </p>
        )
      }
      const event = eventValueOf(value)
      const leaf: DeviceFiredLeaf = {
        kind: 'device-fired',
        deviceId,
        ...(event?.eventIds === undefined ? {} : { eventIds: event.eventIds }),
        ...(event?.sourceIds === undefined ? {} : { sourceIds: event.sourceIds }),
        ...(event?.kinds === undefined ? {} : { kinds: event.kinds }),
      }
      return (
        <div className="flex flex-wrap items-end gap-2" data-testid={`template-input-${address}`}>
          <FiredFields
            leaf={leaf}
            hideDevice
            onChange={(next) => {
              const picked: TemplateEventValue = {
                ...(next.eventIds === undefined ? {} : { eventIds: next.eventIds }),
                ...(next.sourceIds === undefined ? {} : { sourceIds: next.sourceIds }),
                ...(next.kinds === undefined ? {} : { kinds: next.kinds }),
              }
              onChange(TemplateEventValueSchema.safeParse(picked).success ? picked : undefined)
            }}
          />
        </div>
      )
    }
    case 'action': {
      const targetIds =
        input.deviceInput === undefined ? [] : deviceIdsOf(siblingValues[input.deviceInput])
      if (input.deviceInput !== undefined && targetIds.length === 0) {
        return (
          <p className="text-xs text-foreground-subtle" data-testid={`template-input-${address}`}>
            {t('build.templates.pickDevicesFirst', 'Pick the devices first.')}
          </p>
        )
      }
      const action = actionValueOf(value)
      return (
        <div data-testid={`template-input-${address}`}>
          <CommandStep
            autoOpen={false}
            devices={devices}
            variables={[]}
            step={{
              kind: 'command',
              target: { kind: 'devices', ids: [...targetIds] },
              actionId: action?.actionId ?? '',
              ...(action?.args === undefined ? {} : { args: action.args }),
            }}
            onChange={(next) =>
              onChange({
                actionId: next.actionId,
                ...(next.args === undefined ? {} : { args: next.args }),
              })
            }
          />
        </div>
      )
    }
    case 'duration':
      return (
        <span data-testid={`template-input-${address}`}>
          <DurationValueInput
            value={typeof value === 'number' ? value : undefined}
            disabled={disabled}
            {...(input.min === undefined ? {} : { min: input.min })}
            {...(input.max === undefined ? {} : { max: input.max })}
            aria-label={input.label}
            onChange={onChange}
          />
        </span>
      )
    case 'number':
      return (
        <Input
          type="number"
          data-testid={`template-input-${address}`}
          disabled={disabled}
          value={typeof value === 'number' ? String(value) : ''}
          {...(input.min === undefined ? {} : { min: input.min })}
          {...(input.max === undefined ? {} : { max: input.max })}
          onChange={(e) => {
            const parsed = e.target.value === '' ? undefined : Number(e.target.value)
            onChange(parsed === undefined || Number.isNaN(parsed) ? undefined : parsed)
          }}
        />
      )
    case 'text':
      return (
        <Input
          data-testid={`template-input-${address}`}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          {...(input.maxLength === undefined ? {} : { maxLength: input.maxLength })}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        />
      )
    case 'select':
      return (
        <Select
          data-testid={`template-input-${address}`}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          options={[
            ...(input.optional === true || typeof value !== 'string'
              ? [{ value: '', label: t('build.templates.choose', 'Choose…') }]
              : []),
            ...input.options.map((o) => ({ value: o.value, label: o.label })),
          ]}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        />
      )
    case 'boolean':
      return (
        <Switch
          data-testid={`template-input-${address}`}
          disabled={disabled}
          checked={value === true}
          onCheckedChange={(checked) => onChange(checked)}
          label={input.label}
        />
      )
  }
}
