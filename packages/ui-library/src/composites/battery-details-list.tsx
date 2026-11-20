/**
 * BatteryDetails — label/value list of the known battery facts
 * (see `batteryDetailRows`). Rendered inside the full BatteryBadge popover.
 */
import type { JSX } from 'react'
import { useUiText } from '../contexts/ui-text'
import type { BatteryDetailId, BatteryDetailRow, BatteryDetailValue } from './battery-details'

const LABELS: Readonly<Record<BatteryDetailId, readonly [string, string]>> = {
  source: ['uiLibrary.batteryDetails.source', 'Power source'],
  cell: ['uiLibrary.batteryDetails.cell', 'Battery'],
  voltage: ['uiLibrary.batteryDetails.voltage', 'Voltage'],
  current: ['uiLibrary.batteryDetails.current', 'Current'],
  temperature: ['uiLibrary.batteryDetails.temperature', 'Temperature'],
  sleep: ['uiLibrary.batteryDetails.sleep', 'Sleep state'],
  lastContact: ['uiLibrary.batteryDetails.lastContact', 'Last contact'],
}

const PHRASES: Readonly<Record<string, readonly [string, string]>> = {
  mains: ['uiLibrary.batteryDetails.mains', 'Mains'],
  solar: ['uiLibrary.batteryDetails.solar', 'Solar'],
  batteryOnly: ['uiLibrary.batteryDetails.batteryOnly', 'Battery only'],
  charging: ['uiLibrary.batteryDetails.charging', 'Charging'],
  full: ['uiLibrary.batteryDetails.full', 'Full'],
  notCharging: ['uiLibrary.batteryDetails.notCharging', 'Not charging'],
  asleep: ['uiLibrary.batteryDetails.asleep', 'Asleep'],
  awake: ['uiLibrary.batteryDetails.awake', 'Awake'],
}

export interface BatteryDetailsProps {
  readonly rows: readonly BatteryDetailRow[]
}

export function BatteryDetails({ rows }: BatteryDetailsProps): JSX.Element | null {
  const t = useUiText()
  if (rows.length === 0) return null

  const valueText = (value: BatteryDetailValue): string => {
    if (value.kind === 'number') return value.text
    if (value.kind === 'phrase') {
      const [key, fallback] = PHRASES[value.phrase] ?? ['', value.phrase]
      return t(key, fallback)
    }
    switch (value.unit) {
      case 'now':
        return t('uiLibrary.batteryDetails.agoNow', 'just now')
      case 'minutes':
        return t('uiLibrary.batteryDetails.agoMinutes', '{{count}}m ago', { count: value.count })
      case 'hours':
        return t('uiLibrary.batteryDetails.agoHours', '{{count}}h ago', { count: value.count })
      case 'days':
        return t('uiLibrary.batteryDetails.agoDays', '{{count}}d ago', { count: value.count })
    }
  }

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
      {rows.map((row) => {
        const [key, fallback] = LABELS[row.id]
        return (
          <div key={row.id} className="contents">
            <dt className="text-foreground-subtle">{t(key, fallback)}</dt>
            <dd className="text-right font-medium text-foreground">{valueText(row.value)}</dd>
          </div>
        )
      })}
    </dl>
  )
}
