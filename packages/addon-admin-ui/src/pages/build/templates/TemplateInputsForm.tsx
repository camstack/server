/**
 * The inputs form of an automation made from a template (#527): the only thing
 * an operator fills in. One field per declared input, by kind — a device picker,
 * the events of the chosen device, a number. A repeatable group is a list of
 * cards, one per row, each titled by what its row reads; a group inside a row
 * is a list of one-line entries with its own "Add" — or, when it is only "a
 * device and an event of it", one events field: the device picker's event mode. A device is always picked
 * with the one device picker; an action input then only chooses what those
 * devices do. A problem the expansion reported for an input is shown under
 * that input, by its dotted address (`buttons.0.commands.1.targets`).
 */
import {
  type AutomationTemplatePayload,
  type DeviceFiredLeaf,
  type TemplateActionValue,
  TemplateActionValueSchema,
  type TemplateEventValue,
  TemplateEventValueSchema,
  type TemplateGroupInput,
  type TemplateGroupRow,
  type TemplateInputValue,
  type TemplateInputValues,
  type TemplateInstanceProblem,
  type TemplateNestedGroupInput,
  type TemplateNestedRow,
  type TemplateScalarInput,
  type TemplateScalarValue,
  TemplateTimeWindowValueSchema,
} from '@camstack/types'
import type { PickedDeviceAction, PickedDeviceEvent } from '@camstack/ui-library'
import {
  Button,
  DeviceEventPicker,
  DeviceValuePicker,
  FormField,
  IconButton,
  Input,
  Select,
  Switch,
  useDeviceLabelById,
  useDeviceStateGetCapSlice,
} from '@camstack/ui-library'
import { Plus, Trash2, X } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAutomationDevices } from '../automation/automation-data'
import { PickerLabel } from '../automation/FieldPicker'
import { TimeIsFields } from '../automation/TimeIsFields'
import { withWindow } from '../automation/time-is-model'
import { FiredFields } from '../automation/FiredFields'
import { EVENT_EMITTER_CAP, firedVocabularyOf } from '../automation/fired-model'
import { ActionEditor, TemplateActionPicker } from './TemplateActionPicker'
import { DurationValueInput } from './DurationValueInput'
import {
  groupBounds,
  type NestedGroupAt,
  nestedRowsOf,
  problemsAt,
  rowsOf,
  withAddedNestedRow,
  withAddedRow,
  withNestedRows,
  withNestedValue,
  withoutNestedRow,
  withoutRow,
  withRowValue,
  withValue,
} from './template-values'

type Siblings = Readonly<Record<string, TemplateInputValue | undefined>>

/** How many of a row's entries its card title spells out before "+N". */
const SUMMARY_LIMIT = 2

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

function ProblemLines({
  problems,
}: {
  readonly problems: readonly TemplateInstanceProblem[]
}): ReactNode {
  return problems.map((p) => (
    <p key={`${p.input ?? ''}|${p.detail}`} role="alert" className="basis-full text-xs text-danger">
      {p.detail}
    </p>
  ))
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

function AddButton({
  noun,
  disabled,
  testId,
  onClick,
}: {
  readonly noun: string | undefined
  readonly disabled: boolean
  readonly testId: string
  readonly onClick: () => void
}): ReactNode {
  const { t } = useTranslation()
  return (
    <Button size="sm" variant="outline" disabled={disabled} onClick={onClick} data-testid={testId}>
      <Plus className="h-3.5 w-3.5" aria-hidden />
      {noun === undefined
        ? t('build.templates.addRow', 'Add row')
        : t('build.templates.addNamed', 'Add {{noun}}', { noun })}
    </Button>
  )
}

function GroupField({ group, values, problems, disabled, onChange }: GroupFieldProps): ReactNode {
  const rows = rowsOf(values, group.key)
  const bounds = groupBounds(group)
  return (
    <section className="space-y-2" data-testid={`template-group-${group.key}`}>
      <h4 className="text-sm font-medium text-foreground">{group.label}</h4>
      <ProblemLines problems={problemsAt(problems, group.key)} />
      {rows.map((row, index) => (
        // The index is the row's address (`buttons.2`); rows have no other identity.
        <GroupRow
          key={index}
          group={group}
          values={values}
          row={row}
          index={index}
          removable={rows.length > bounds.min}
          problems={problems}
          disabled={disabled}
          onChange={onChange}
        />
      ))}
      <AddButton
        noun={group.rowLabel}
        disabled={disabled || rows.length >= bounds.max}
        testId={`template-group-${group.key}-add`}
        onClick={() => onChange(withAddedRow(values, group))}
      />
    </section>
  )
}

interface SummaryEntry {
  readonly deviceId: number
  readonly event: TemplateEventValue | undefined
}

function entryOf(inputs: readonly TemplateScalarInput[], row: Siblings): SummaryEntry | undefined {
  const device = inputs.find((input) => input.kind === 'device')
  if (device === undefined) return undefined
  const deviceId = deviceIdsOf(row[device.key])[0]
  if (deviceId === undefined) return undefined
  const event = inputs.find((input) => input.kind === 'event' && input.deviceInput === device.key)
  return { deviceId, event: event === undefined ? undefined : eventValueOf(row[event.key]) }
}

/** What a card is titled by: the devices its row reads first — its own, else its first nested group's. */
function summaryEntries(group: TemplateGroupInput, row: TemplateGroupRow): readonly SummaryEntry[] {
  const scalars = group.inputs.filter((i): i is TemplateScalarInput => i.kind !== 'group')
  const own = entryOf(scalars, row)
  if (own !== undefined) return [own]
  for (const input of group.inputs) {
    if (input.kind !== 'group') continue
    const entries = nestedRowsOf(row, input.key)
      .map((nested) => entryOf(input.inputs, nested))
      .filter((entry): entry is SummaryEntry => entry !== undefined)
    if (entries.length > 0) return entries
  }
  return []
}

/** "Wall switch · Buttons · Button 1 · Short press": the device by the shared resolver, then what fires. */
function SummaryWords({ entry }: { readonly entry: SummaryEntry }): ReactNode {
  const name = useDeviceLabelById(entry.deviceId, 'compact')
  const wanted = entry.event !== undefined
  const query = useDeviceStateGetCapSlice(
    { deviceId: entry.deviceId, capName: EVENT_EMITTER_CAP },
    { enabled: wanted },
  )
  const state = firedVocabularyOf({ status: query.status, data: query.data })
  const vocabulary = wanted && state.kind === 'known' ? state.vocabulary : []
  const sourceId = entry.event?.sourceIds?.[0]
  const eventId = entry.event?.eventIds?.[0]
  const source = vocabulary.find((v) => v.source?.id === sourceId)?.source?.label
  const event = vocabulary.find(
    (v) => v.id === eventId && (sourceId === undefined || v.source?.id === sourceId),
  )?.label
  return [
    name,
    sourceId === undefined ? undefined : (source ?? sourceId),
    eventId === undefined ? undefined : (event ?? eventId),
  ]
    .filter((part) => part !== undefined)
    .join(' · ')
}

function RowSummary({
  group,
  row,
}: {
  readonly group: TemplateGroupInput
  readonly row: TemplateGroupRow
}): ReactNode {
  const { t } = useTranslation()
  const entries = summaryEntries(group, row)
  if (entries.length === 0) {
    return group.rowLabel === undefined
      ? t('build.templates.newRow', 'New row')
      : t('build.templates.newNamed', 'New {{noun}}', { noun: group.rowLabel })
  }
  const shown = entries.slice(0, SUMMARY_LIMIT)
  const more = entries.length - shown.length
  return (
    <>
      {shown.map((entry, i) => (
        // Entries follow the row's order; they have no other identity.
        <Fragment key={i}>
          {i > 0 && ', '}
          <SummaryWords entry={entry} />
        </Fragment>
      ))}
      {more > 0 && ` +${String(more)}`}
    </>
  )
}

interface GroupRowProps {
  readonly group: TemplateGroupInput
  readonly values: TemplateInputValues
  readonly row: TemplateGroupRow
  readonly index: number
  readonly removable: boolean
  readonly problems: readonly TemplateInstanceProblem[]
  readonly disabled: boolean
  readonly onChange: (next: TemplateInputValues) => void
}

function GroupRow({
  group,
  values,
  row,
  index,
  removable,
  problems,
  disabled,
  onChange,
}: GroupRowProps): ReactNode {
  const { t } = useTranslation()
  const prefix = `${group.key}.${String(index)}`
  const noun = group.rowLabel
  return (
    <div
      className="space-y-3 rounded-md border border-border bg-surface p-3"
      data-testid={`template-group-${group.key}-row`}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className="min-w-0 truncate text-sm font-medium text-foreground"
          data-testid={`template-group-${group.key}-summary`}
        >
          <RowSummary group={group} row={row} />
        </span>
        <IconButton
          icon={Trash2}
          size="sm"
          variant="ghost"
          aria-label={
            noun === undefined
              ? t('build.templates.removeRow', 'Remove row')
              : t('build.templates.removeNamed', 'Remove {{noun}}', { noun })
          }
          disabled={disabled || !removable}
          onClick={() => onChange(withoutRow(values, group, index))}
        />
      </div>
      {group.inputs.map((input) =>
        input.kind === 'group' ? (
          <NestedGroupField
            key={input.key}
            at={{ groupKey: group.key, index, group: input }}
            rows={nestedRowsOf(row, input.key)}
            address={`${prefix}.${input.key}`}
            values={values}
            problems={problems}
            disabled={disabled}
            onChange={onChange}
          />
        ) : (
          <ScalarField
            key={input.key}
            input={input}
            siblingValues={row}
            address={`${prefix}.${input.key}`}
            problems={problems}
            disabled={disabled}
            onChange={(next) => onChange(withRowValue(values, group.key, index, input.key, next))}
          />
        ),
      )}
    </div>
  )
}

interface NestedGroupFieldProps {
  readonly at: NestedGroupAt
  readonly rows: readonly TemplateNestedRow[]
  readonly address: string
  readonly values: TemplateInputValues
  readonly problems: readonly TemplateInstanceProblem[]
  readonly disabled: boolean
  readonly onChange: (next: TemplateInputValues) => void
}

interface EventPair {
  readonly device: string
  readonly event: string
}

/** A nested group that is only "a device and an event of it": drawn as one events field. */
function eventPairOf(group: TemplateNestedGroupInput): EventPair | undefined {
  if (group.inputs.length !== 2) return undefined
  const device = group.inputs.find((input) => input.kind === 'device' && input.multiple !== true)
  const event = group.inputs.find(
    (input) => input.kind === 'event' && input.deviceInput === device?.key,
  )
  if (device === undefined || event === undefined) return undefined
  return { device: device.key, event: event.key }
}

function picksOf(
  rows: readonly TemplateNestedRow[],
  pair: EventPair,
): readonly PickedDeviceEvent[] {
  return rows.flatMap((row): readonly PickedDeviceEvent[] => {
    const deviceId = deviceIdsOf(row[pair.device])[0]
    const eventId = eventValueOf(row[pair.event])?.eventIds?.[0]
    if (deviceId === undefined || eventId === undefined) return []
    const sourceId = eventValueOf(row[pair.event])?.sourceIds?.[0]
    return [{ deviceId, eventId, ...(sourceId === undefined ? {} : { sourceId }) }]
  })
}

function rowsOfPicks(
  picks: readonly PickedDeviceEvent[],
  pair: EventPair,
): readonly TemplateNestedRow[] {
  return picks.map((pick) => ({
    [pair.device]: pick.deviceId,
    [pair.event]: {
      eventIds: [pick.eventId],
      ...(pick.sourceId === undefined ? {} : { sourceIds: [pick.sourceId] }),
    },
  }))
}

interface ActionPair {
  readonly devices: string
  readonly action: string
}

/** A nested group that is only "some devices and an action they share": drawn as one actions field. */
function actionPairOf(group: TemplateNestedGroupInput): ActionPair | undefined {
  if (group.inputs.length !== 2) return undefined
  const devices = group.inputs.find((input) => input.kind === 'device' && input.multiple === true)
  const action = group.inputs.find(
    (input) => input.kind === 'action' && input.deviceInput === devices?.key,
  )
  if (devices === undefined || action === undefined) return undefined
  return { devices: devices.key, action: action.key }
}

function actionPicksOf(
  rows: readonly TemplateNestedRow[],
  pair: ActionPair,
): readonly PickedDeviceAction[] {
  return rows.flatMap((row): readonly PickedDeviceAction[] => {
    const deviceIds = deviceIdsOf(row[pair.devices])
    const action = actionValueOf(row[pair.action])
    return deviceIds.length === 0 || action === undefined ? [] : [{ deviceIds, action }]
  })
}

function rowsOfActionPicks(
  picks: readonly PickedDeviceAction[],
  pair: ActionPair,
): readonly TemplateNestedRow[] {
  return picks.map((pick) => ({ [pair.devices]: [...pick.deviceIds], [pair.action]: pick.action }))
}

/** A group inside a card: a small heading, one line per entry, and its own "Add". */
function NestedGroupField({
  at,
  rows,
  address,
  values,
  problems,
  disabled,
  onChange,
}: NestedGroupFieldProps): ReactNode {
  const { t } = useTranslation()
  const group = at.group
  const bounds = groupBounds(group)
  const noun = group.rowLabel
  const pair = eventPairOf(group)
  const actionPair = actionPairOf(group)
  const devices = useAutomationDevices()
  if (actionPair !== undefined) {
    return (
      <div className="space-y-1" data-testid={`template-nested-${address}`}>
        <h5 className="text-xs font-medium text-foreground-muted">{group.label}</h5>
        <TemplateActionPicker
          testId={`template-input-${address}`}
          recentKey={`template-input-${group.key}`}
          disabled={disabled}
          devices={devices}
          maxItems={bounds.max}
          value={actionPicksOf(rows, actionPair)}
          onChange={(next) =>
            onChange(withNestedRows(values, at, rowsOfActionPicks(next, actionPair)))
          }
        />
        <ProblemLines
          problems={problems.filter(
            (p) => p.input === address || p.input?.startsWith(`${address}.`) === true,
          )}
        />
      </div>
    )
  }
  if (pair !== undefined) {
    return (
      <div className="space-y-1" data-testid={`template-nested-${address}`}>
        <h5 className="text-xs font-medium text-foreground-muted">{group.label}</h5>
        <DeviceEventPicker
          testId={`template-input-${address}`}
          recentKey={`template-input-${group.key}`}
          disabled={disabled}
          maxItems={bounds.max}
          value={picksOf(rows, pair)}
          onChange={(next) => onChange(withNestedRows(values, at, rowsOfPicks(next, pair)))}
        />
        <ProblemLines
          problems={problems.filter(
            (p) => p.input === address || p.input?.startsWith(`${address}.`) === true,
          )}
        />
      </div>
    )
  }
  return (
    <div className="space-y-2" data-testid={`template-nested-${address}`}>
      <h5 className="text-xs font-medium text-foreground-muted">{group.label}</h5>
      <ProblemLines problems={problemsAt(problems, address)} />
      {rows.map((row, nestedIndex) => {
        const line = `${address}.${String(nestedIndex)}`
        return (
          // The index is the entry's address (`buttons.0.commands.1`); entries have no other identity.
          <div
            key={nestedIndex}
            className="flex flex-wrap items-start gap-2"
            data-testid={`template-nested-${address}-row`}
          >
            {group.inputs.map((input) => (
              <LineCell
                key={input.key}
                input={input}
                row={row}
                address={`${line}.${input.key}`}
                disabled={disabled}
                onChange={(next) =>
                  onChange(withNestedValue(values, at, nestedIndex, input.key, next))
                }
              />
            ))}
            <IconButton
              icon={X}
              size="sm"
              variant="ghost"
              // Past the label row, beside the controls.
              className="mt-5"
              aria-label={
                noun === undefined
                  ? t('build.templates.removeRow', 'Remove row')
                  : t('build.templates.removeNamed', 'Remove {{noun}}', { noun })
              }
              disabled={disabled || rows.length <= bounds.min}
              onClick={() => onChange(withoutNestedRow(values, at, nestedIndex))}
            />
            <ProblemLines
              problems={group.inputs.flatMap((input) =>
                problemsAt(problems, `${line}.${input.key}`),
              )}
            />
          </div>
        )
      })}
      <AddButton
        noun={noun}
        disabled={disabled || rows.length >= bounds.max}
        testId={`template-nested-${address}-add`}
        onClick={() => onChange(withAddedNestedRow(values, at))}
      />
    </div>
  )
}

interface LineCellProps {
  readonly input: TemplateScalarInput
  readonly row: Siblings
  readonly address: string
  readonly disabled: boolean
  readonly onChange: (next: TemplateScalarValue | undefined) => void
}

/**
 * One input of a one-line entry: its label above its control, every label on
 * the same row and every control starting under it. An event's own selects and an action's select carry
 * their labels themselves, so they sit beside the device they read.
 */
function LineCell({ input, row, address, disabled, onChange }: LineCellProps): ReactNode {
  const control = (
    <ScalarControl
      input={input}
      value={row[input.key]}
      siblingValues={row}
      address={address}
      disabled={disabled}
      inline
      onChange={onChange}
    />
  )
  if (input.kind === 'event' || input.kind === 'action' || input.kind === 'boolean') return control
  return (
    <div className="min-w-[13rem] flex-1">
      <PickerLabel>{input.label}</PickerLabel>
      {control}
    </div>
  )
}

interface ScalarFieldProps {
  readonly input: TemplateScalarInput
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
  /** Inside a one-line entry: an event or action draws its own labelled cells. */
  readonly inline?: boolean
  readonly onChange: (next: TemplateScalarValue | undefined) => void
}

function ScalarControl({
  input,
  value,
  siblingValues,
  address,
  disabled,
  inline = false,
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
          <p
            className="min-w-[11rem] flex-1 py-1.5 text-xs text-foreground-subtle"
            data-testid={`template-input-${address}`}
          >
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
      const fields = (
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
      )
      if (inline) return fields
      return (
        <div className="flex flex-wrap items-end gap-2" data-testid={`template-input-${address}`}>
          {fields}
        </div>
      )
    }
    case 'action': {
      const targetIds =
        input.deviceInput === undefined ? [] : deviceIdsOf(siblingValues[input.deviceInput])
      if (input.deviceInput !== undefined && targetIds.length === 0) {
        return (
          <p
            className="min-w-[11rem] flex-1 py-1.5 text-xs text-foreground-subtle"
            data-testid={`template-input-${address}`}
          >
            {t('build.templates.pickDevicesFirst', 'Pick the devices first.')}
          </p>
        )
      }
      return (
        <ActionEditor
          deviceIds={targetIds}
          devices={devices}
          value={actionValueOf(value)}
          disabled={disabled}
          testId={`template-input-${address}`}
          onChange={onChange}
        />
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
    case 'time-window':
      return (
        <TimeWindowControl
          testId={`template-input-${address}`}
          value={value}
          disabled={disabled}
          onChange={onChange}
        />
      )
  }
}

interface TimeWindowControlProps {
  readonly testId: string
  readonly value: TemplateInputValue | undefined
  readonly disabled: boolean
  readonly onChange: (next: TemplateScalarValue | undefined) => void
}

/**
 * A `time-window` input: off leaves it without a value (no limit), on opens the
 * automation editor's own `time-is` fields. The window never holds an empty day
 * list: releasing the last day does nothing, so a value is always one the
 * template accepts.
 */
function TimeWindowControl({
  testId,
  value,
  disabled,
  onChange,
}: TimeWindowControlProps): ReactNode {
  const { t } = useTranslation()
  const parsed = TemplateTimeWindowValueSchema.safeParse(value)
  const leaf = parsed.success ? ({ kind: 'time-is', ...parsed.data } as const) : null
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <Switch
        data-testid={`${testId}-limit`}
        disabled={disabled}
        checked={leaf !== null}
        onCheckedChange={(checked) => {
          if (!checked) return onChange(undefined)
          const { kind: _kind, ...window } = withWindow({ kind: 'time-is' }, true)
          onChange(window)
        }}
        label={t('build.templates.timeWindow.limit', 'Only run at certain times')}
      />
      {leaf === null ? null : (
        <fieldset disabled={disabled} className="contents">
          <TimeIsFields
            leaf={leaf}
            onChange={(next) => {
              if (next.days?.length === 0) return
              const { kind: _kind, ...window } = next
              onChange(window)
            }}
          />
        </fieldset>
      )}
    </div>
  )
}
