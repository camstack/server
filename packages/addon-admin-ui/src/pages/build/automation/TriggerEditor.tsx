/**
 * WHEN — the only genuinely new vocabulary in an automation.
 *
 * Four kinds, and the list is closed: a device field taking a value, an event on
 * the bus, a cron schedule, and by hand. Triggers are ANY-of — the first one
 * that fires starts a run — which is why they render as a flat list with no
 * joiner to choose. Ordering them would suggest a precedence that does not
 * exist.
 *
 * The three timing knobs on a state trigger are not decoration and are worth the
 * screen space:
 *
 *  - **becomes** — empty means *any change*, which is a different automation
 *    from one that fires on a particular value. It is a checkbox rather than an
 *    empty text box because "" is itself a value a string field can take.
 *  - **for** — the state must HOLD. This is what separates "the door opened" from
 *    "the door has been open for two minutes".
 *  - **debounce** — a burst collapses into one run. A contact sensor that reports
 *    three times in 400 ms is one event to a person.
 */

import type { AutomationTrigger } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { Badge, Button, Checkbox, Input, Select } from '@camstack/ui-library'
import { Plus, Trash2 } from 'lucide-react'
import type { AutomationDevice } from './automation-data'
import { FieldPicker, type FieldSelection, PickerLabel, useFieldDescriptor } from './FieldPicker'
import { ReadOnlyTriggerFields } from './ReadOnlyParts'
import { newTrigger, removeAt, replaceAt, type TriggerKind, triggerKindLabel } from './recipe-parts'
import { type ScalarValue, ScalarValueInput } from './ValueInput'
import { Trans, useTranslation } from 'react-i18next'

type DeviceStateTrigger = Extract<AutomationTrigger, { kind: 'device-state' }>
type DeviceEventTrigger = Extract<AutomationTrigger, { kind: 'device-event' }>

const TRIGGER_KINDS: readonly TriggerKind[] = ['device-state', 'device-event', 'schedule', 'manual']

/** Sorted once at module load — the enum is 146 entries and the order it is
 *  declared in is grouped by subsystem, which is not how anyone searches it. */
const EVENT_CATEGORIES: readonly string[] = Object.values(EventCategory).sort((a, b) =>
  a.localeCompare(b),
)

export interface TriggerEditorProps {
  readonly triggers: readonly AutomationTrigger[]
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: readonly AutomationTrigger[]) => void
}

export function TriggerEditor({ triggers, devices, onChange }: TriggerEditorProps) {
  const { t } = useTranslation()
  return (
    <div className="space-y-2">
      {triggers.length === 0 && (
        <p className="text-xs text-warning">
          {t(
            'automation.triggerEditor.noTriggersYetWithoutOne',
            'No triggers yet. Without one nothing can ever start this automation — not even "Run actions", which needs a manual trigger to have somewhere to arrive.',
          )}
        </p>
      )}

      {triggers.map((trigger, index) => (
        <TriggerRow
          // Index is the identity here: triggers carry no id, and reordering is
          // not offered precisely because ANY-of has no order to disturb.
          key={`${trigger.kind}-${String(index)}`}
          trigger={trigger}
          devices={devices}
          position={index}
          onChange={(next) => onChange(replaceAt(triggers, index, next))}
          onRemove={() => onChange(removeAt(triggers, index))}
        />
      ))}

      <Button
        variant="outline"
        onClick={() => onChange([...triggers, newTrigger('device-state')])}
        title={t(
          'automation.triggerEditor.addAnotherWayThisAutomation',
          'Add another way this automation can start',
        )}
      >
        <Plus className="h-4 w-4" /> {t('automation.triggerEditor.trigger')}
      </Button>
    </div>
  )
}

interface TriggerRowProps {
  readonly trigger: AutomationTrigger
  readonly devices: readonly AutomationDevice[]
  readonly position: number
  readonly onChange: (next: AutomationTrigger) => void
  readonly onRemove: () => void
}

function TriggerRow({ trigger, devices, position, onChange, onRemove }: TriggerRowProps) {
  const { t } = useTranslation()
  return (
    <div className="rounded border border-border p-3">
      <div className="flex flex-wrap items-end gap-2">
        <Badge variant="default">
          {position === 0
            ? t('automation.triggerEditor.when', 'When')
            : t('automation.triggerEditor.orWhen', 'or when')}
        </Badge>
        {isEditableKind(trigger.kind) ? (
          <label className="min-w-[13rem] flex-1">
            <PickerLabel>{t('automation.triggerEditor.trigger', 'Trigger')}</PickerLabel>
            <Select
              value={trigger.kind}
              onChange={(e) => onChange(newTrigger(asTriggerKind(e.target.value)))}
              options={TRIGGER_KINDS.map((k) => ({ value: k, label: triggerKindLabel(k) }))}
            />
          </label>
        ) : (
          <div className="min-w-[13rem] flex-1">
            <Badge variant="default">{triggerKindLabel(trigger.kind)}</Badge>
          </div>
        )}
        <Button
          variant="ghost"
          onClick={onRemove}
          title={t('automation.triggerEditor.removeThisTrigger', 'Remove this trigger')}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        {trigger.kind === 'device-state' && (
          <DeviceStateFields trigger={trigger} devices={devices} onChange={onChange} />
        )}
        {trigger.kind === 'device-event' && (
          <DeviceEventFields trigger={trigger} devices={devices} onChange={onChange} />
        )}
        {trigger.kind === 'schedule' && (
          <label className="min-w-[14rem] flex-1">
            <PickerLabel>
              {t('automation.triggerEditor.cronExpression', 'Cron expression')}
            </PickerLabel>
            <Input
              value={trigger.cron}
              placeholder="0 30 23 * * *"
              onChange={(e) => onChange({ kind: 'schedule', cron: e.target.value })}
            />
            <span className="mt-1 block text-xs text-foreground-subtle">
              <Trans i18nKey="automation.triggerEditor.cronHint" components={{ code: <code /> }} />
            </span>
          </label>
        )}
        {!isEditableKind(trigger.kind) && (
          <ReadOnlyTriggerFields trigger={trigger} devices={devices} />
        )}
        {trigger.kind === 'manual' && (
          <p className="text-xs text-foreground-subtle">
            <Trans i18nKey="automation.triggerEditor.manualHint" components={{ b: <strong /> }} />
          </p>
        )}
      </div>
    </div>
  )
}

/** The kinds the editor can author; any other kind in a recipe is shown read-only. */
function isEditableKind(kind: TriggerKind): boolean {
  return TRIGGER_KINDS.some((k) => k === kind)
}

function asTriggerKind(value: string): TriggerKind {
  const hit = TRIGGER_KINDS.find((k) => k === value)
  return hit ?? 'manual'
}

interface DeviceStateFieldsProps {
  readonly trigger: DeviceStateTrigger
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: AutomationTrigger) => void
}

/**
 * Rebuild a state trigger with the optional keys OMITTED when unset.
 *
 * `{ becomes: undefined }` and no `becomes` key are the same thing to
 * TypeScript and different things to `JSON.stringify` — and the recipe is
 * serialised into the generated file, where an explicit `"becomes": null` would
 * change what the emitted comparison means.
 */
interface DeviceStateOptions {
  readonly becomes?: ScalarValue
  readonly edge?: boolean
  readonly forMs?: number
  readonly debounceMs?: number
}

function buildStateTrigger(field: FieldSelection, options: DeviceStateOptions): DeviceStateTrigger {
  return {
    kind: 'device-state',
    deviceId: field.deviceId,
    cap: field.cap,
    fieldPath: field.fieldPath,
    ...(options.becomes === undefined ? {} : { becomes: options.becomes }),
    ...(options.edge === undefined ? {} : { edge: options.edge }),
    ...(options.forMs === undefined ? {} : { forMs: options.forMs }),
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
  }
}

function DeviceStateFields({ trigger, devices, onChange }: DeviceStateFieldsProps) {
  const { t } = useTranslation()
  const selection: FieldSelection = {
    deviceId: trigger.deviceId,
    cap: trigger.cap,
    fieldPath: trigger.fieldPath,
  }
  const descriptor = useFieldDescriptor(selection)
  const options: DeviceStateOptions = {
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
        onChange={(next) => onChange(buildStateTrigger(next, options))}
      />

      <div className="min-w-[11rem] flex-1">
        <PickerLabel>{t('automation.triggerEditor.becomes', 'Becomes')}</PickerLabel>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-foreground-subtle">
            <Checkbox
              checked={trigger.becomes === undefined}
              onChange={(e) =>
                onChange(
                  buildStateTrigger(selection, {
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
              onChange={(becomes) =>
                onChange(buildStateTrigger(selection, { ...options, becomes }))
              }
            />
          )}
        </div>
      </div>

      <label className="flex items-center gap-1.5 text-xs text-foreground-subtle">
        <Checkbox
          checked={trigger.edge === true}
          onChange={(e) =>
            onChange(
              buildStateTrigger(selection, {
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
            onChange(buildStateTrigger(selection, { ...options, forMs: toMs(e.target.value) }))
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
            onChange(buildStateTrigger(selection, { ...options, debounceMs: toMs(e.target.value) }))
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
  readonly trigger: DeviceEventTrigger
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: AutomationTrigger) => void
}

function DeviceEventFields({ trigger, devices, onChange }: DeviceEventFieldsProps) {
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
            { value: '', label: t('automation.triggerEditor.selectAnEvent', 'Select an event…') },
            ...EVENT_CATEGORIES.map((c) => ({ value: c, label: c })),
          ]}
        />
      </label>
      <label className="min-w-[11rem] flex-1">
        <PickerLabel>{t('automation.triggerEditor.fromDevice', 'From device')}</PickerLabel>
        <Select
          value={trigger.deviceId === undefined ? '' : String(trigger.deviceId)}
          onChange={(e) =>
            onChange({
              kind: 'device-event',
              category: trigger.category,
              ...(e.target.value === '' ? {} : { deviceId: Number(e.target.value) }),
            })
          }
          options={[
            { value: '', label: t('automation.triggerEditor.anyDevice', 'Any device') },
            ...devices.map((d) => ({ value: String(d.id), label: d.name })),
          ]}
        />
      </label>
    </>
  )
}
