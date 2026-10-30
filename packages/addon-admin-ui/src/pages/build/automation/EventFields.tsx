/**
 * The event rows of the `when` tree that are not a scene: a device value that
 * BECOMES something, a system event, a schedule and a manual run.
 *
 * The three timing knobs on a "becomes" row are not decoration and are worth
 * the screen space:
 *
 *  - **becomes** — empty means *any change*, which is a different automation
 *    from one that fires on a particular value. It is a checkbox rather than an
 *    empty text box because "" is itself a value a string field can take.
 *  - **held for** — the new value must HOLD. This is what separates "the door
 *    opened" from "the door has been open for two minutes".
 *  - **debounce** — a burst collapses into one run. A contact sensor that
 *    reports three times in 400 ms is one event to a person.
 */

import type { AutomationLeaf, DeviceBecomesLeaf } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { Checkbox, Input, Select } from '@camstack/ui-library'
import { Trans, useTranslation } from 'react-i18next'
import { BuildDevicePicker } from '../flow/BuildDevicePicker'
import type { AutomationDevice } from './automation-data'
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
  readonly edge?: boolean
  readonly forMs?: number
  readonly debounceMs?: number
}

function buildBecomesLeaf(field: FieldSelection, options: DeviceBecomesOptions): DeviceBecomesLeaf {
  return {
    kind: 'device-becomes',
    deviceId: field.deviceId,
    cap: field.cap,
    fieldPath: field.fieldPath,
    ...(options.becomes === undefined ? {} : { becomes: options.becomes }),
    ...(options.edge === undefined ? {} : { edge: options.edge }),
    ...(options.forMs === undefined ? {} : { forMs: options.forMs }),
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
  }
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
  const options: DeviceBecomesOptions = {
    ...(trigger.becomes === undefined ? {} : { becomes: trigger.becomes }),
    ...(trigger.edge === undefined ? {} : { edge: trigger.edge }),
    ...(trigger.forMs === undefined ? {} : { forMs: trigger.forMs }),
    ...(trigger.debounceMs === undefined ? {} : { debounceMs: trigger.debounceMs }),
  }

  return (
    <>
      <FieldPicker
        value={selection}
        devices={devices}
        onChange={(next) => onChange(buildBecomesLeaf(next, options))}
      />

      <div className="min-w-[11rem] flex-1">
        <PickerLabel>{t('automation.triggerEditor.becomes', 'Becomes')}</PickerLabel>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-foreground-subtle">
            <Checkbox
              checked={trigger.becomes === undefined}
              onChange={(e) =>
                onChange(
                  buildBecomesLeaf(selection, {
                    ...options,
                    ...(e.target.checked ? { becomes: undefined } : { becomes: '' }),
                  }),
                )
              }
            />
            {t('automation.triggerEditor.anyChange', 'any change')}
          </label>
          {trigger.becomes !== undefined && (
            <ScalarValueInput
              value={trigger.becomes}
              field={descriptor}
              deviceId={selection.deviceId}
              cap={selection.cap}
              onChange={(becomes) => onChange(buildBecomesLeaf(selection, { ...options, becomes }))}
            />
          )}
        </div>
      </div>

      <label className="flex items-center gap-1.5 text-xs text-foreground-subtle">
        <Checkbox
          checked={trigger.edge === true}
          onChange={(e) =>
            onChange(
              buildBecomesLeaf(selection, {
                ...options,
                ...(e.target.checked ? { edge: true } : { edge: undefined }),
              }),
            )
          }
        />
        {t('automation.triggerEditor.onlyOnAChange', 'only on a change')}
      </label>

      <label className="w-28">
        <PickerLabel>{t('automation.triggerEditor.heldForS', 'Held for (s)')}</PickerLabel>
        <Input
          type="number"
          min={0}
          value={trigger.forMs === undefined ? '' : String(trigger.forMs / 1000)}
          placeholder="0"
          onChange={(e) =>
            onChange(
              buildBecomesLeaf(selection, {
                ...options,
                forMs: toMs(e.target.value),
              }),
            )
          }
        />
      </label>

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
        <BuildDevicePicker
          devices={devices}
          selection="single"
          value={trigger.deviceId === undefined ? [] : [trigger.deviceId]}
          emptyLabel={t('automation.triggerEditor.anyDevice', 'Any device')}
          testId="trigger-event-device"
          onChange={(ids) =>
            onChange({
              kind: 'device-event',
              category: trigger.category,
              ...(ids[0] === undefined ? {} : { deviceId: ids[0] }),
            })
          }
        />
      </div>
    </>
  )
}
