/**
 * The device-list row of a `DeviceType.EnergySystem` device: what the panels
 * produce and the storage's charge, read from the `energy-system` model. The
 * storage is the model's `storage` part, never the `battery` cap (#522). The
 * device-detail hero is the device card (`EnergyCardHero` in panel-controls.tsx).
 */
import type { ReactNode } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { formatKw } from '../device-card/scenes/energy/model'
import type { DeviceControlProps } from './control-registry'

/**
 * EnergySystemInlineControl — "Solar 4.2 kW · Storage 74%" for a device-list
 * row; a part the system does not report is left out. Natural width.
 */
export function EnergySystemInlineControl({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.energySystem,
    slice: (d) => d.state.energySystem,
  })
  if (cap === undefined || slice === undefined) return null
  const solarW = slice.solar?.powerW ?? null
  const pct = slice.storage?.stateOfChargePct ?? null
  const parts: string[] = []
  if (solarW !== null)
    parts.push(`${t('uiLibrary.deviceCard.energy.solar', 'Solar')} ${formatKw(solarW)}`)
  if (pct !== null)
    parts.push(`${t('uiLibrary.deviceCard.energy.storage', 'Storage')} ${Math.round(pct)}%`)
  if (parts.length === 0) return null
  return (
    <span
      data-testid="energy-system-inline"
      className="inline-flex items-center text-xs tabular-nums text-foreground-subtle"
    >
      {parts.join(' · ')}
    </span>
  )
}
