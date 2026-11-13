/**
 * The inputs form of an automation made from a template (#527): the only thing
 * an operator fills in. One field per declared input, by kind — a device picker,
 * the events of the chosen device, a number — and a repeatable list of rows
 * for a group. An action that names a sibling device input with no capability
 * or role filter is one Command field: the dialog picks the command and the
 * devices, and both stored keys change together. A problem the expansion
 * reported for an input is shown under that input, by its dotted address
 * (`buttons.2.targets`); a combined field shows both keys' problems.
 */
import {
  type AutomationTemplatePayload,
  type DeviceFiredLeaf,
  type TemplateActionValue,
  TemplateActionValueSchema,
  type TemplateEventValue,
  TemplateEventValueSchema,
  type TemplateGroupInput,
  type TemplateInput,
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
import { useAutomationDevices } from '../automation/automation-data'
import { FiredFields } from '../automation/FiredFields'
import { CommandStep } from '../flow/CommandStep'
import type { CommandStep as CommandStepValue } from '../flow/command-vocab'
import { DurationValueInput } from './DurationValueInput'
import {
  groupBounds,
  problemsAt,
  rowsOf,
  type TemplateValuePatch,
  withAddedRow,
  withoutRow,
  withRowValue,
  withRowValues,
  withValue,
  withValues,
} from './template-values'

type DeviceInput = Extract<TemplateScalarInput, { kind: 'device' }>
type ActionInput = Extract<TemplateScalarInput, { kind: 'action' }>

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

function scalarsOf(inputs: readonly TemplateInput[]): readonly TemplateScalarInput[] {
  return inputs.filter((input): input is TemplateScalarInput => input.kind !== 'group')
}

function deviceByKey(
  siblings: readonly TemplateScalarInput[],
  key: string,
): DeviceInput | undefined {
  const found = siblings.find((input) => input.key === key && input.kind === 'device')
  return found !== undefined && found.kind === 'device' ? found : undefined
}

/**
 * The device input this action can replace. Absent when the dialog cannot
 * apply the device's filter, or when another input beside it also reads
 * that device (an event still needs its own picker).
 */
function commandDevice(
  action: ActionInput,
  siblings: readonly TemplateScalarInput[],
): DeviceInput | undefined {
  if (action.deviceInput === undefined) return undefined
  const named = action.deviceInput
  const readers = siblings.filter(
    (input) => (input.kind === 'action' || input.kind === 'event') && input.deviceInput === named,
  )
  if (readers.length !== 1) return undefined
  const device = deviceByKey(siblings, named)
  if (device === undefined) return undefined
  if (device.filter?.capability !== undefined || device.filter?.role !== undefined) {
    return undefined
  }
  return device
}

function hiddenDeviceKeys(siblings: readonly TemplateScalarInput[]): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const input of siblings) {
    if (input.kind !== 'action') continue
    const device = commandDevice(input, siblings)
    if (device !== undefined) keys.add(device.key)
  }
  return keys
}

function storedDeviceValue(
  device: DeviceInput,
  target: CommandStepValue['target'],
): TemplateScalarValue | undefined {
  if (target.kind !== 'devices' || target.ids.length === 0) return undefined
  if (device.multiple === true) return [...target.ids]
  return target.ids[0]
}

function storedActionValue(step: CommandStepValue): TemplateActionValue | undefined {
  if (step.actionId === '') return undefined
  return {
    actionId: step.actionId,
    ...(step.args === undefined ? {} : { args: step.args }),
  }
}

export function TemplateInputsForm({
  payload,
  values,
  problems,
  disabled = false,
  onChange,
}: TemplateInputsFormProps): ReactNode {
  const siblings = scalarsOf(payload.inputs)
  const hidden = hiddenDeviceKeys(siblings)
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
          <ScopedInput
            key={input.key}
            input={input}
            siblings={siblings}
            hidden={hidden}
            siblingValues={values}
            addressPrefix=""
            problems={problems}
            disabled={disabled}
            onScalar={(key, next) => onChange(withValue(values, key, next))}
            onPair={(patch) => onChange(withValues(values, patch))}
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
  const hidden = hiddenDeviceKeys(group.inputs)
  return (
    <section className="space-y-2" data-testid={`template-group-${group.key}`}>
      <h4 className="text-sm font-medium text-foreground">{group.label}</h4>
      {own.map((p) => (
        <p key={p.detail} role="alert" className="text-xs text-danger">
          {p.detail}
        </p>
      ))}
      {rows.map((row, index) => (
        // The index is the row's address (`buttons.2.targets`); rows have no other identity.
        <GroupRow
          key={index}
          group={group}
          values={values}
          row={row}
          index={index}
          rowCount={rows.length}
          minRows={bounds.min}
          hidden={hidden}
          problems={problems}
          disabled={disabled}
          onChange={onChange}
        />
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

interface GroupRowProps {
  readonly group: TemplateGroupInput
  readonly values: TemplateInputValues
  readonly row: Siblings
  readonly index: number
  readonly rowCount: number
  readonly minRows: number
  readonly hidden: ReadonlySet<string>
  readonly problems: readonly TemplateInstanceProblem[]
  readonly disabled: boolean
  readonly onChange: (next: TemplateInputValues) => void
}

function GroupRow({
  group,
  values,
  row,
  index,
  rowCount,
  minRows,
  hidden,
  problems,
  disabled,
  onChange,
}: GroupRowProps): ReactNode {
  const { t } = useTranslation()
  const prefix = `${group.key}.${String(index)}`
  return (
    <div
      // The index is the row's address (`buttons.2.targets`); rows have no other identity.
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
          disabled={disabled || rowCount <= minRows}
          onClick={() => onChange(withoutRow(values, group, index))}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {group.inputs.map((input) => (
          <ScopedInput
            key={input.key}
            input={input}
            siblings={group.inputs}
            hidden={hidden}
            siblingValues={row}
            addressPrefix={prefix}
            problems={problems}
            disabled={disabled}
            className="sm:col-span-2"
            onScalar={(key, next) => onChange(withRowValue(values, group.key, index, key, next))}
            onPair={(patch) => onChange(withRowValues(values, group.key, index, patch))}
          />
        ))}
      </div>
    </div>
  )
}

interface ScopedInputProps {
  readonly input: TemplateScalarInput
  readonly siblings: readonly TemplateScalarInput[]
  readonly hidden: ReadonlySet<string>
  readonly siblingValues: Siblings
  readonly addressPrefix: string
  readonly problems: readonly TemplateInstanceProblem[]
  readonly disabled: boolean
  /** Applied only to a combined command, so it can span the row grid. */
  readonly className?: string
  readonly onScalar: (key: string, next: TemplateScalarValue | undefined) => void
  readonly onPair: (patch: TemplateValuePatch) => void
}

function ScopedInput({
  input,
  siblings,
  hidden,
  siblingValues,
  addressPrefix,
  problems,
  disabled,
  className,
  onScalar,
  onPair,
}: ScopedInputProps): ReactNode {
  if (hidden.has(input.key)) return null
  const address = addressPrefix === '' ? input.key : `${addressPrefix}.${input.key}`
  if (input.kind === 'action') {
    const device = commandDevice(input, siblings)
    if (device !== undefined) {
      const deviceAddress = addressPrefix === '' ? device.key : `${addressPrefix}.${device.key}`
      return (
        <CommandPairField
          action={input}
          device={device}
          siblingValues={siblingValues}
          address={address}
          deviceAddress={deviceAddress}
          problems={problems}
          {...(className === undefined ? {} : { className })}
          onChange={onPair}
        />
      )
    }
  }
  return (
    <ScalarField
      input={input}
      siblings={siblings}
      siblingValues={siblingValues}
      address={address}
      problems={problems}
      disabled={disabled}
      onChange={(next) => onScalar(input.key, next)}
    />
  )
}

interface CommandPairFieldProps {
  readonly action: ActionInput
  readonly device: DeviceInput
  readonly siblingValues: Siblings
  readonly address: string
  readonly deviceAddress: string
  readonly problems: readonly TemplateInstanceProblem[]
  readonly className?: string
  readonly onChange: (patch: TemplateValuePatch) => void
}

function CommandPairField({
  action,
  device,
  siblingValues,
  address,
  deviceAddress,
  problems,
  className,
  onChange,
}: CommandPairFieldProps): ReactNode {
  const { t } = useTranslation()
  const devices = useAutomationDevices()
  const own = [...problemsAt(problems, deviceAddress), ...problemsAt(problems, address)]
  const error = own.length === 0 ? undefined : own.map((problem) => problem.detail).join(' ')
  const picked = actionValueOf(siblingValues[action.key])
  const targetIds = deviceIdsOf(siblingValues[device.key])
  return (
    <FormField
      label={t('build.templates.command', 'Command')}
      required={action.optional !== true || device.optional !== true}
      {...(action.description === undefined ? {} : { description: action.description })}
      {...(error === undefined ? {} : { error })}
      className={className === undefined ? 'min-w-0' : `min-w-0 ${className}`}
    >
      <div data-testid={`template-input-${address}`}>
        <CommandStep
          autoOpen={false}
          singleTarget={device.multiple !== true}
          devices={devices}
          variables={[]}
          step={{
            kind: 'command',
            target: { kind: 'devices', ids: [...targetIds] },
            actionId: picked?.actionId ?? '',
            ...(picked?.args === undefined ? {} : { args: picked.args }),
          }}
          onChange={(next) =>
            onChange({
              [device.key]: storedDeviceValue(device, next.target),
              [action.key]: storedActionValue(next),
            })
          }
        />
      </div>
    </FormField>
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
