/**
 * The device-list row of a `DeviceType.EnergySystem` device: what the panels
 * produce and the storage's charge, read from the `energy-system` model. The
 * storage is the model's `storage` part, never the `battery` cap (#522). The
 * device-detail hero is the device card (`EnergyCardHero` in panel-controls.tsx).
 */
import type { ReactNode } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { ValueChip } from '../device-card/parts/ValueChip'
import { formatKw } from '../device-card/scenes/energy/model'
import type { DeviceControlProps } from './control-registry'

interface EnergyReading {
  readonly id: string
  readonly text: string
}

/**
 * EnergySystemInlineControl — one pill per reading ("Solar 4.2 kW",
 * "Storage 74%") for a device-list row. A part the system does not report
 * is left out. Natural width.
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
  const readings: EnergyReading[] = []
  if (solarW !== null) {
    readings.push({
      id: 'solar',
      text: `${t('uiLibrary.deviceCard.energy.solar', 'Solar')} ${formatKw(solarW)}`,
    })
  }
  if (pct !== null) {
    readings.push({
      id: 'storage',
      text: `${t('uiLibrary.deviceCard.energy.storage', 'Storage')} ${Math.round(pct)}%`,
    })
  }
  if (readings.length === 0) return null
  return (
    <span data-testid="energy-system-inline" className="inline-flex flex-wrap items-center gap-1">
      {readings.map((reading) => (
        <span key={reading.id} data-testid="energy-value-chip">
          <ValueChip>{reading.text}</ValueChip>
        </span>
      ))}
    </span>
  )
}
