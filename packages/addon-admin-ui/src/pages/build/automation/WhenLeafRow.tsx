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

import type { AutomationLeaf, AutomationLeafContext } from '@camstack/types'
import { isEventLeaf } from '@camstack/types'
import { Badge, Button } from '@camstack/ui-library'
import { Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AutomationDevice } from './automation-data'
import { DeviceIsFields } from './DeviceIsFields'
import { DeviceBecomesFields, DeviceEventFields, ManualFields, ScheduleFields } from './EventFields'
import { ExpressionLeafRow } from './ExpressionLeafRow'
import { PickerLabel } from './FieldPicker'
import { type MoveControls, MoveButtons } from './MoveButtons'
import { LeafKindPickerModal } from './LeafKindPickerModal'
import { leafKindLabel } from './recipe-parts'
import {
  DetectionFields,
  IntervalFields,
  StationaryFields,
  StationaryPresentFields,
} from './SceneFields'
import { TimeIsFields } from './TimeIsFields'
import { convertLeafKind } from './when-ops'

export interface WhenLeafRowProps {
  readonly leaf: AutomationLeaf
  readonly devices: readonly AutomationDevice[]
  /** Where the row lives: decides which kinds "Change type" may offer. */
  readonly context: Extract<AutomationLeafContext, 'trigger' | 'guard'>
  /** The row is the child of a NOT: an event cannot take its place. */
  readonly underNot: boolean
  readonly toneClass: string
  /** What the selected run held at this row, shown inside it. */
  readonly result?: ReactNode
  /** Null where a NOT is not offered (the row is already negated). */
  readonly onNegate: (() => void) | null
  /** Up / down among its siblings; absent where the row has none (the child of a NOT). */
  readonly move?: MoveControls
  readonly onChange: (next: AutomationLeaf) => void
  readonly onRemove: () => void
}

export function WhenLeafRow({
  leaf,
  devices,
  context,
  underNot,
  toneClass,
  result,
  onNegate,
  move,
  onChange,
  onRemove,
}: WhenLeafRowProps) {
  const { t } = useTranslation()
  const [changing, setChanging] = useState(false)
  const event = isEventLeaf(leaf)
  return (
    <div className={`rounded border p-2 ${toneClass}`} data-testid="when-row" data-kind={leaf.kind}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[13rem] max-w-xs flex-1">
          <PickerLabel>{t('automation.whenTree.rowType', 'Row type')}</PickerLabel>
          <Button
            variant="outline"
            data-testid="when-row-type"
            className="w-full justify-between"
            onClick={() => setChanging(true)}
            title={t('automation.leafPicker.changeType', 'Change type')}
          >
            <span className="truncate">{leafKindLabel(leaf.kind)}</span>
            <span className="text-foreground-subtle">
              {t('automation.leafPicker.changeType', 'Change type')}
            </span>
          </Button>
          <LeafKindPickerModal
            open={changing}
            onOpenChange={setChanging}
            mode="change"
            context={context}
            underNot={underNot}
            treeFull={false}
            onPick={(kind) => {
              if (kind !== leaf.kind) onChange(convertLeafKind(leaf, kind))
            }}
          />
        </div>
        <Badge variant={event ? 'info' : 'neutral'} data-testid="when-row-nature">
          {event
            ? t('automation.whenTree.natureEvent', 'Event')
            : t('automation.whenTree.natureState', 'State')}
        </Badge>
        <span className="flex-1" />
        {move !== undefined && <MoveButtons move={move} />}
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
      {result !== undefined && <div className="mt-2">{result}</div>}
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
    case 'time-is':
      return <TimeIsFields leaf={leaf} onChange={onChange} />
  }
}
