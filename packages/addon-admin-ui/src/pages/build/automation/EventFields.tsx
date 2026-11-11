/**
 * The event rows of the `when` tree that are not a scene: a device value that
 * BECOMES something, a system event, a schedule and a manual run.
 *
 * The knobs on a "becomes" row are not decoration and are worth the screen space:
 *
 *  - **becomes** — any change, one value, a threshold (rises above / drops
 *    below) or a range (enters / leaves). A row fires on the TRANSITION into it,
 *    never on a re-report, so there is no separate "only on a change" switch.
 *  - **for** — the transition must HOLD (or, with "any change", the new value
 *    must stay put). This is what separates "the door opened" from "the door
 *    has been open for two minutes". See `HoldFields`.
 *  - **debounce** — a burst collapses into one run. A contact sensor that
 *    reports three times in 400 ms is one event to a person.
 */

import type { AutomationLeaf, BecomesOperator, DeviceBecomesLeaf, HoldSpec } from '@camstack/types'
import { BecomesOperatorSchema, EventCategory, holdOf } from '@camstack/types'
import { DeviceValuePicker, Input, Select } from '@camstack/ui-library'
import { Trans, useTranslation } from 'react-i18next'
import { BUILD_EXCLUDED_TYPES } from '../flow/build-device-filters'
import type { AutomationDevice } from './automation-data'
import { HoldFields } from './HoldFields'
import { FieldPicker, type FieldSelection, PickerLabel, useFieldDescriptor } from './FieldPicker'
import { type ScalarValue, ScalarValueInput } from './ValueInput'

type DeviceEventLeaf = Extract<AutomationLeaf, { kind: 'device-event' }>
type ScheduleLeaf = Extract<AutomationLeaf, { kind: 'schedule' }>

/** Sorted once at module load — the enum is 146 entries and the order it is
 *  declared in is grouped by subsystem, which is not how anyone searches it. */
const EVENT_CATEGORIES: readonly string[] = Object.values(EventCategory).sort((a, b) =>
  a.localeCompare(b),
)

export interface ScheduleFieldsProps {
  readonly leaf: ScheduleLeaf
  readonly onChange: (next: ScheduleLeaf) => void
}

export function ScheduleFields({ leaf, onChange }: ScheduleFieldsProps) {
  const { t } = useTranslation()
  return (
    <label className="min-w-[14rem] flex-1">
      <PickerLabel>{t('automation.triggerEditor.cronExpression', 'Cron expression')}</PickerLabel>
      <Input
        value={leaf.cron}
        placeholder="0 30 23 * * *"
        onChange={(e) => onChange({ kind: 'schedule', cron: e.target.value })}
      />
      <span className="mt-1 block text-xs text-foreground-subtle">
        <Trans i18nKey="automation.triggerEditor.cronHint" components={{ code: <code /> }} />
      </span>
    </label>
  )
}

export function ManualFields() {
  return (
    <p className="text-xs text-foreground-subtle">
      <Trans i18nKey="automation.triggerEditor.manualHint" components={{ b: <strong /> }} />
    </p>
  )
}

interface DeviceBecomesFieldsProps {
  readonly leaf: DeviceBecomesLeaf
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: DeviceBecomesLeaf) => void
}

/**
 * Rebuild a "becomes" row with the optional keys OMITTED when unset.
 *
 * `{ becomes: undefined }` and no `becomes` key are the same thing to
 * TypeScript and different things to `JSON.stringify` — and the recipe is
 * serialised into the generated file, where an explicit `"becomes": null` would
 * change what the emitted comparison means.
 */
interface DeviceBecomesOptions {
  readonly becomes?: ScalarValue
  readonly operator?: BecomesOperator
  readonly value?: DeviceBecomesLeaf['value']
  readonly hold?: HoldSpec
  readonly debounceMs?: number
}

function buildBecomesLeaf(field: FieldSelection, options: DeviceBecomesOptions): DeviceBecomesLeaf {
  return {
    kind: 'device-becomes',
    deviceId: field.deviceId,
    cap: field.cap,
    fieldPath: field.fieldPath,
    ...(options.becomes === undefined ? {} : { becomes: options.becomes }),
    ...(options.operator === undefined || options.value === undefined
      ? {}
      : {
          operator: options.operator,
          value: options.value,
        }),
    ...(options.hold === undefined ? {} : { for: options.hold }),
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
  }
}

/** What a row says it waits for: no predicate, one value, a threshold or a range. */
type BecomesChoice = 'any' | 'becomes' | BecomesOperator

function choiceOf(leaf: DeviceBecomesLeaf): BecomesChoice {
  if (leaf.operator !== undefined) return leaf.operator
  return leaf.becomes === undefined ? 'any' : 'becomes'
}

const CHOICES: readonly BecomesChoice[] = [
  'any',
  'becomes',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'outside',
]

function isRange(choice: BecomesChoice): boolean {
  return choice === 'between' || choice === 'outside'
}

function numberOf(raw: string): number | undefined {
  if (raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isNaN(n) ? undefined : n
}

/** The numeric operand of a threshold row, when the stored value is one. */
function operandOf(value: DeviceBecomesLeaf['value']): number | undefined {
  return typeof value === 'number' ? value : undefined
}

export function DeviceBecomesFields({
  leaf: trigger,
  devices,
  onChange,
}: DeviceBecomesFieldsProps) {
  const { t } = useTranslation()
  const selection: FieldSelection = {
    deviceId: trigger.deviceId,
    cap: trigger.cap,
    fieldPath: trigger.fieldPath,
  }
  const descriptor = useFieldDescriptor(selection)
  const hold = holdOf(trigger)
  const choice = choiceOf(trigger)
  const threshold = operandOf(trigger.value)
  const bounds: readonly [number | undefined, number | undefined] = Array.isArray(trigger.value)
    ? [trigger.value[0], trigger.value[1]]
    : [undefined, undefined]
  // A leaf stored before holds carried `forMs` and `edge`: editing it writes `for` and drops both.
  const options: DeviceBecomesOptions = {
    ...(trigger.becomes === undefined ? {} : { becomes: trigger.becomes }),
    ...(trigger.operator === undefined || trigger.value === undefined
      ? {}
      : { operator: trigger.operator, value: trigger.value }),
    ...(hold === undefined ? {} : { hold }),
    ...(trigger.debounceMs === undefined ? {} : { debounceMs: trigger.debounceMs }),
  }
  const { becomes: _becomes, operator: _operator, value: _value, ...kept } = options

  const setChoice = (raw: string): void => {
    if (raw === 'any') {
      onChange(buildBecomesLeaf(selection, kept))
      return
    }
    if (raw === 'becomes') {
      onChange(buildBecomesLeaf(selection, { ...kept, becomes: '' }))
      return
    }
    const operator = BecomesOperatorSchema.safeParse(raw)
    if (!operator.success) return
    onChange(
      buildBecomesLeaf(selection, {
        ...kept,
        operator: operator.data,
        value: isRange(operator.data) ? [0, 0] : 0,
      }),
    )
  }

  const choiceLabels: Readonly<Record<BecomesChoice, string>> = {
    any: t('automation.triggerEditor.anyChange', 'any change'),
    becomes: t('automation.triggerEditor.becomesValue', 'becomes a value'),
    gt: t('automation.triggerEditor.crossesAbove', 'rises above'),
    gte: t('automation.triggerEditor.reachesAtLeast', 'reaches at least'),
    lt: t('automation.triggerEditor.dropsBelow', 'drops below'),
    lte: t('automation.triggerEditor.reachesAtMost', 'reaches at most'),
    between: t('automation.triggerEditor.entersRange', 'enters the range'),
    outside: t('automation.triggerEditor.leavesRange', 'leaves the range'),
    eq: t('automation.triggerEditor.becomesValue', 'becomes a value'),
    ne: t('automation.triggerEditor.stopsBeing', 'stops being'),
  }

  return (
    <>
      <FieldPicker
        value={selection}
        devices={devices}
        onChange={(next) => onChange(buildBecomesLeaf(next, options))}
      />

      <label className="min-w-[10rem]">
        <PickerLabel>{t('automation.triggerEditor.becomes', 'Becomes')}</PickerLabel>
        <Select
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          options={CHOICES.map((c) => ({ value: c, label: choiceLabels[c] }))}
        />
      </label>

      {choice === 'becomes' && trigger.becomes !== undefined && (
        <div className="min-w-[9rem] flex-1">
          <PickerLabel>{t('automation.conditionRow.value', 'Value')}</PickerLabel>
          <ScalarValueInput
            value={trigger.becomes}
            field={descriptor}
            deviceId={selection.deviceId}
            cap={selection.cap}
            onChange={(becomes) => onChange(buildBecomesLeaf(selection, { ...options, becomes }))}
          />
        </div>
      )}

      {trigger.operator !== undefined && !isRange(choice) && (
        <label className="w-28">
          <PickerLabel>{t('automation.conditionRow.value', 'Value')}</PickerLabel>
          <Input
            type="number"
            step="any"
            value={threshold === undefined ? '' : String(threshold)}
            onChange={(e) => {
              const value = numberOf(e.target.value)
              if (value === undefined) return
              onChange(
                buildBecomesLeaf(selection, { ...options, operator: trigger.operator, value }),
              )
            }}
          />
        </label>
      )}

      {trigger.operator !== undefined &&
        isRange(choice) &&
        [0, 1].map((i) => (
          <label key={i} className="w-24">
            <PickerLabel>
              {i === 0
                ? t('automation.triggerEditor.rangeFrom', 'From')
                : t('automation.triggerEditor.rangeTo', 'To')}
            </PickerLabel>
            <Input
              type="number"
              step="any"
              value={bounds[i] === undefined ? '' : String(bounds[i])}
              onChange={(e) => {
                const value = numberOf(e.target.value)
                if (value === undefined) return
                const next: [number, number] = [bounds[0] ?? 0, bounds[1] ?? 0]
                next[i] = value
                onChange(
                  buildBecomesLeaf(selection, {
                    ...options,
                    operator: trigger.operator,
                    value: next,
                  }),
                )
              }}
            />
          </label>
        ))}

      <HoldFields
        hold={hold}
        modes={['held', 'stable']}
        onChange={(next) => {
          const { hold: _hold, ...rest } = options
          onChange(buildBecomesLeaf(selection, next === undefined ? rest : { ...rest, hold: next }))
        }}
      />

      <label className="w-28">
        <PickerLabel>{t('automation.triggerEditor.debounceS', 'Debounce (s)')}</PickerLabel>
        <Input
          type="number"
          min={0}
          value={trigger.debounceMs === undefined ? '' : String(trigger.debounceMs / 1000)}
          placeholder="0"
          onChange={(e) =>
            onChange(
              buildBecomesLeaf(selection, {
                ...options,
                debounceMs: toMs(e.target.value),
              }),
            )
          }
        />
      </label>
    </>
  )
}

/** Seconds on screen, milliseconds in the recipe. An empty box means the knob is
 *  not set at all, which is not the same as zero. */
function toMs(raw: string): number | undefined {
  if (raw.trim() === '') return undefined
  const seconds = Number(raw)
  if (Number.isNaN(seconds) || seconds < 0) return undefined
  return Math.round(seconds * 1000)
}

interface DeviceEventFieldsProps {
  readonly leaf: DeviceEventLeaf
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: DeviceEventLeaf) => void
}

export function DeviceEventFields({ leaf: trigger, devices, onChange }: DeviceEventFieldsProps) {
  const { t } = useTranslation()
  return (
    <>
      <label className="min-w-[15rem] flex-1">
        <PickerLabel>{t('automation.triggerEditor.eventCategory', 'Event category')}</PickerLabel>
        <Select
          value={trigger.category}
          onChange={(e) =>
            onChange({
              kind: 'device-event',
              category: e.target.value,
              ...(trigger.deviceId === undefined ? {} : { deviceId: trigger.deviceId }),
            })
          }
          options={[
            {
              value: '',
              label: t('automation.triggerEditor.selectAnEvent', 'Select an event…'),
            },
            ...EVENT_CATEGORIES.map((c) => ({ value: c, label: c })),
          ]}
        />
      </label>
      <div className="min-w-[11rem] flex-1">
        <PickerLabel>{t('automation.triggerEditor.fromDevice', 'From device')}</PickerLabel>
        <DeviceValuePicker
          pick="device"
          excludeTypes={BUILD_EXCLUDED_TYPES}
          recentKey="build-targets"
          value={trigger.deviceId === undefined ? null : { deviceId: trigger.deviceId }}
          placeholder={t('automation.triggerEditor.anyDevice', 'Any device')}
          testId="trigger-event-device"
          onChange={(picked) =>
            onChange({
              kind: 'device-event',
              category: trigger.category,
              ...(picked === null ? {} : { deviceId: picked.deviceId }),
            })
          }
        />
      </div>
    </>
  )
}
