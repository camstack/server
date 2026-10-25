import type { ReactNode } from 'react'
import { useDeviceCapability } from '../../hooks/use-device-capability.js'
import { useUiText } from '../../contexts/ui-text.js'
import type { ControlPanelProps } from './types.js'

export function formatHeatingValvePosition(position: number | null): string {
  return position !== null ? `${position}%` : '—'
}

export function HeatingValveReadout({
  trpc,
  deviceId,
  layout,
}: Pick<ControlPanelProps, 'trpc' | 'deviceId' | 'layout'>): ReactNode {
  const t = useUiText()
  const { cap, slice } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.heatingValve,
    slice: (d) => d.state.heatingValve,
  })

  if (cap === undefined || slice === undefined) return null

  const label = t('uiLibrary.heatingValveReadout.valve', 'Valve')
  const value = formatHeatingValvePosition(slice.position)

  if (layout === 'compact') {
    return (
      <span
        className="inline-flex items-center text-xs tabular-nums text-foreground-subtle"
        aria-label={`${label} ${value}`}
      >
        {value}
      </span>
    )
  }

  return (
    <div className="flex items-center gap-2 text-xs tabular-nums text-foreground-subtle">
      <span>{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  )
}
