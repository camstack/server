/**
 * The fields of a `triggered-by` row: one toggle per trigger row of the
 * automation. The row is true for the run one of the pressed triggers started.
 */
import type { TriggeredByLeaf } from '@camstack/types'
import { Button } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import type { AutomationDevice } from './automation-data'
import { PickerLabel } from './FieldPicker'
import { leafKindLabel } from './recipe-parts'
import { useTriggerRows } from './trigger-rows-context'
import { missingTriggers, toggleTrigger, type TriggerRow } from './triggered-by-model'

export interface TriggeredByFieldsProps {
  readonly leaf: TriggeredByLeaf
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: TriggeredByLeaf) => void
}

/** What tells two trigger rows of one kind apart: the event they wait for and the device they watch. */
function rowDetail(row: TriggerRow, devices: readonly AutomationDevice[]): string | undefined {
  const leaf = row.leaf
  if (leaf.kind !== 'device-becomes' && leaf.kind !== 'device-event') return undefined
  const device = devices.find((candidate) => candidate.id === leaf.deviceId)?.name
  if (leaf.kind === 'device-becomes') return device
  return device === undefined ? leaf.category : `${leaf.category} · ${device}`
}

export function TriggeredByFields({ leaf, devices, onChange }: TriggeredByFieldsProps) {
  const { t } = useTranslation()
  const rows = useTriggerRows()
  const rowIds = rows.map((row) => row.id)
  const missing = missingTriggers(leaf, rowIds)
  const label = t('automation.triggeredBy.triggers', 'Started by')
  return (
    <div>
      <PickerLabel>{label}</PickerLabel>
      {rows.length === 0 ? (
        <p className="text-xs text-warning" data-testid="triggered-by-no-rows">
          {t(
            'automation.triggeredBy.noRows',
            'This automation has no trigger row to choose. Add one to the rules first.',
          )}
        </p>
      ) : (
        <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
          {rows.map((row) => {
            const on = leaf.leafIds.includes(row.id)
            const detail = rowDetail(row, devices)
            return (
              <Button
                key={row.id}
                size="sm"
                variant={on ? 'primary' : 'outline'}
                aria-pressed={on}
                className="h-auto min-h-8 whitespace-normal py-1 text-left"
                onClick={() => onChange(toggleTrigger(leaf, row.id, rowIds))}
              >
                {`${row.ordinal}. ${leafKindLabel(row.leaf.kind)}${detail === undefined ? '' : ` · ${detail}`}`}
              </Button>
            )
          })}
        </div>
      )}
      {rows.length > 0 && leaf.leafIds.length === 0 && (
        <p className="mt-1 text-xs text-warning" data-testid="triggered-by-none-picked">
          {t('automation.triggeredBy.nonePicked', 'Pick at least one trigger.')}
        </p>
      )}
      {missing.length > 0 && (
        <p className="mt-1 text-xs text-warning" data-testid="triggered-by-missing">
          {t('automation.triggeredBy.missing', {
            count: missing.length,
            defaultValue_one:
              '{{count}} chosen trigger no longer exists. Press a trigger to drop it.',
            defaultValue_other:
              '{{count}} chosen triggers no longer exist. Press a trigger to drop them.',
          })}
        </p>
      )}
    </div>
  )
}
