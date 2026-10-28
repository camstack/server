/**
 * Read-only rows for the recipe parts the visual editor cannot author yet — the
 * `stationary` trigger and `stationary-present` condition (the editor is phase
 * P4), and the `detection` / `interval` triggers.
 *
 * They exist so that opening a recipe containing one never breaks the editor or
 * renders it as a different kind: the part is shown as what it is, kept exactly
 * as authored, and can still be removed.
 */

import type { AutomationConditionStationaryPresent, AutomationTrigger } from '@camstack/types'
import { Badge } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import type { AutomationDevice } from './automation-data'

interface FilterLine {
  readonly label: string
  readonly values: readonly string[]
}

function deviceNames(ids: readonly number[], devices: readonly AutomationDevice[]): string[] {
  return ids.map((id) => devices.find((d) => d.id === id)?.name ?? `#${String(id)}`)
}

function FilterLines({ lines }: { readonly lines: readonly FilterLine[] }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-foreground-subtle">
      {lines.map((line) => (
        <span key={line.label}>
          <span className="font-medium">{line.label}</span>{' '}
          {line.values.length === 0 ? t('automation.readOnly.any') : line.values.join(', ')}
        </span>
      ))}
    </div>
  )
}

export interface StationaryPresentRowProps {
  readonly leaf: AutomationConditionStationaryPresent
  readonly devices: readonly AutomationDevice[]
}

export function StationaryPresentRow({ leaf, devices }: StationaryPresentRowProps) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1">
      <Badge variant="default">{t('automation.readOnly.stationaryPresent')}</Badge>
      <FilterLines
        lines={[
          {
            label: t('automation.readOnly.cameras'),
            values: deviceNames([leaf.deviceId], devices),
          },
          { label: t('automation.readOnly.classes'), values: leaf.classes ?? [] },
          { label: t('automation.readOnly.zones'), values: leaf.zones ?? [] },
        ]}
      />
      <p className="text-xs text-foreground-subtle">{t('automation.readOnly.editInCode')}</p>
    </div>
  )
}

export interface ReadOnlyTriggerFieldsProps {
  readonly trigger: AutomationTrigger
  readonly devices: readonly AutomationDevice[]
}

/** The detail line of a trigger kind that has no visual editor. */
export function ReadOnlyTriggerFields({ trigger, devices }: ReadOnlyTriggerFieldsProps) {
  const { t } = useTranslation()
  if (trigger.kind === 'stationary') {
    return (
      <div className="space-y-1">
        <FilterLines
          lines={[
            {
              label: t('automation.readOnly.stationaryTrigger'),
              values: [
                trigger.phase === 'appeared'
                  ? t('automation.readOnly.phaseAppeared')
                  : t('automation.readOnly.phaseDeparted'),
              ],
            },
            {
              label: t('automation.readOnly.cameras'),
              values: deviceNames(trigger.deviceIds, devices),
            },
            { label: t('automation.readOnly.classes'), values: trigger.classes ?? [] },
            { label: t('automation.readOnly.zones'), values: trigger.zones ?? [] },
          ]}
        />
        <p className="text-xs text-foreground-subtle">{t('automation.readOnly.editInCode')}</p>
      </div>
    )
  }
  return <p className="text-xs text-foreground-subtle">{t('automation.readOnly.editInCode')}</p>
}
