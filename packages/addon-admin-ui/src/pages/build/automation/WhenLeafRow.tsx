/**
 * One row of the `when` tree. Every row is ONE type picked from ONE menu —
 * events (something happens) and states (something is true) side by side — and
 * reads as a sentence: "<device value> becomes <value>", "<device value> is
 * <value>", "<class> detected [label] on <cameras>".
 *
 * Switching the type keeps what carries over (the field a "becomes" row watches
 * is the one an "is" row compares) and starts every other switch blank, so an
 * accidental pick costs at most one row.
 */

import type { AutomationLeaf } from '@camstack/types'
import { isEventLeaf } from '@camstack/types'
import { Badge, Button, OptionSelect, type OptionSelectOption } from '@camstack/ui-library'
import { Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AutomationDevice } from './automation-data'
import { DeviceIsFields } from './DeviceIsFields'
import { DeviceBecomesFields, DeviceEventFields, ManualFields, ScheduleFields } from './EventFields'
import { ExpressionLeafRow } from './ExpressionLeafRow'
import { PickerLabel } from './FieldPicker'
import { EVENT_LEAF_KINDS, LEAF_KINDS, type LeafKind, leafKindLabel } from './recipe-parts'
import {
  DetectionFields,
  IntervalFields,
  StationaryFields,
  StationaryPresentFields,
} from './SceneFields'
import { convertLeafKind } from './when-ops'

function useKindOptions(): readonly OptionSelectOption[] {
  const { t } = useTranslation()
  const hint: Readonly<Record<LeafKind, string>> = {
    detection: t('flow.triggerHint.detection', 'An object class is detected on a camera'),
    stationary: t('flow.triggerHint.stationary', 'An object stops, or leaves'),
    'device-becomes': t('automation.whenTree.hint_device_becomes', 'A device value takes a value'),
    'device-event': t('flow.triggerHint.deviceEvent', 'An event on the system'),
    schedule: t('flow.triggerHint.schedule', 'At a time of day'),
    interval: t('flow.triggerHint.interval', 'Again and again, every few minutes'),
    manual: t('flow.triggerHint.manual', 'Only when you run it'),
    'device-is': t('automation.whenTree.hint_device_is', 'A device value is, right now'),
    'stationary-present': t(
      'automation.whenTree.hint_stationary_present',
      'An object is parked on a camera, right now',
    ),
    expression: t(
      'automation.whenTree.hint_expression',
      'Arithmetic across device values, right now',
    ),
  }
  const events = t('automation.whenTree.groupEvents', 'Happens (an event)')
  const states = t('automation.whenTree.groupStates', 'Is true (a state)')
  return LEAF_KINDS.map((kind) => ({
    value: kind,
    label: leafKindLabel(kind),
    description: hint[kind],
    group: EVENT_LEAF_KINDS.includes(kind) ? events : states,
  }))
}

function asLeafKind(value: string): LeafKind | null {
  return LEAF_KINDS.find((k) => k === value) ?? null
}

export interface WhenLeafRowProps {
  readonly leaf: AutomationLeaf
  readonly devices: readonly AutomationDevice[]
  readonly toneClass: string
  /** Null where a NOT is not offered (the row is already negated). */
  readonly onNegate: (() => void) | null
  readonly onChange: (next: AutomationLeaf) => void
  readonly onRemove: () => void
}

export function WhenLeafRow({
  leaf,
  devices,
  toneClass,
  onNegate,
  onChange,
  onRemove,
}: WhenLeafRowProps) {
  const { t } = useTranslation()
  const options = useKindOptions()
  const event = isEventLeaf(leaf)
  return (
    <div className={`rounded border p-2 ${toneClass}`} data-testid="when-row" data-kind={leaf.kind}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[13rem] max-w-xs flex-1">
          <PickerLabel>{t('automation.whenTree.rowType', 'Row type')}</PickerLabel>
          <OptionSelect
            mode="single"
            singleDisplay="field"
            options={options}
            value={leaf.kind}
            testId="when-row-type"
            optionTestIdPrefix="when-kind"
            onChange={(value) => {
              const kind = asLeafKind(value)
              if (kind !== null && kind !== leaf.kind) onChange(convertLeafKind(leaf, kind))
            }}
          />
        </div>
        <Badge variant={event ? 'info' : 'neutral'} data-testid="when-row-nature">
          {event
            ? t('automation.whenTree.natureEvent', 'Event')
            : t('automation.whenTree.natureState', 'State')}
        </Badge>
        <span className="flex-1" />
        {onNegate !== null && (
          <Button
            variant="ghost"
            onClick={onNegate}
            title={t('automation.whenTree.negateRow', 'Invert this row (NOT)')}
          >
            {'NOT'}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={onRemove}
          title={t('automation.whenTree.removeRow', 'Remove this row')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <LeafFields leaf={leaf} devices={devices} onChange={onChange} />
      </div>
    </div>
  )
}

interface LeafFieldsProps {
  readonly leaf: AutomationLeaf
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: AutomationLeaf) => void
}

function LeafFields({ leaf, devices, onChange }: LeafFieldsProps) {
  switch (leaf.kind) {
    case 'device-becomes':
      return <DeviceBecomesFields leaf={leaf} devices={devices} onChange={onChange} />
    case 'device-event':
      return <DeviceEventFields leaf={leaf} devices={devices} onChange={onChange} />
    case 'schedule':
      return <ScheduleFields leaf={leaf} onChange={onChange} />
    case 'interval':
      return <IntervalFields leaf={leaf} onChange={onChange} />
    case 'manual':
      return <ManualFields />
    case 'detection':
      return <DetectionFields leaf={leaf} devices={devices} onChange={onChange} />
    case 'stationary':
      return <StationaryFields leaf={leaf} devices={devices} onChange={onChange} />
    case 'device-is':
      return <DeviceIsFields leaf={leaf} devices={devices} onChange={onChange} />
    case 'stationary-present':
      return <StationaryPresentFields leaf={leaf} devices={devices} onChange={onChange} />
    case 'expression':
      return <ExpressionLeafRow leaf={leaf} devices={devices} onChange={onChange} />
  }
}
