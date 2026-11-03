/**
 * PowerMeterLine — the ONE place a device's electrical draw is shown (D1004):
 * a slim line directly under the device page's hero card, for every device
 * bound to the `power-meter` capability, whatever its type. The cap declares
 * `ui: { kind:'widget', widgetId:'host/power-meter-line', placement:'hero' }`;
 * no device-controls hero card draws watts itself
 * (`scripts/check-no-hero-self-drawn-power.ts`).
 *
 * A reading the device never reported is not drawn as a number: no slice, or
 * a slice with neither power nor energy, renders nothing; a missing field
 * (power but no energy, or the reverse) is simply absent, never `0` or `NaN`.
 */
import { useUiText } from '../../contexts/ui-text'
import type { JSX } from 'react'
import { Zap } from 'lucide-react'
import type { PowerMeterStatus } from '@camstack/types'
import { useSystem } from '../../contexts/system-context'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { cn } from '../../lib/cn'
import type { CapSettingsComponentProps } from './index'

/** A finite number, or null: the one gate between a slice field and the screen. */
function known(value: number | undefined | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Whole watts below a kilowatt, one decimal above. */
export function formatPowerWatts(watts: number): { readonly value: string; readonly unit: string } {
  return Math.abs(watts) >= 1000
    ? { value: (watts / 1000).toFixed(1), unit: 'kW' }
    : { value: String(Math.round(watts)), unit: 'W' }
}

/** Two decimals under 100 kWh, whole kWh above. */
export function formatEnergyKwh(kwh: number): string {
  return Math.abs(kwh) >= 100 ? String(Math.round(kwh)) : kwh.toFixed(2)
}

export function PowerMeterLine({ deviceId }: CapSettingsComponentProps): JSX.Element | null {
  const t = useUiText()
  const system = useSystem()
  const { slice } = useDeviceCapability<object, PowerMeterStatus>({
    trpc: system.trpcClient,
    deviceId,
    cap: (d) => d.powerMeter,
    slice: (d) => d.state.powerMeter,
  })
  const power = known(slice?.power)
  const energy = known(slice?.energy)
  if (power === null && energy === null) return null
  const drawing = power !== null && power > 0
  const shown = power === null ? null : formatPowerWatts(power)

  return (
    <div
      data-testid="power-meter-line"
      className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2"
    >
      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
        {drawing && (
          <span
            aria-hidden="true"
            data-testid="power-meter-pulse"
            className="absolute inset-0 rounded-full bg-primary/20 motion-safe:animate-pulse"
          />
        )}
        <Zap
          className={cn(
            'relative h-3.5 w-3.5',
            drawing ? 'text-primary' : 'text-foreground-subtle',
          )}
          aria-hidden
        />
      </span>
      {shown !== null && (
        <span data-testid="power-meter-power" className="flex items-baseline gap-1 tabular-nums">
          <span className="text-lg font-semibold text-foreground">{shown.value}</span>
          <span className="text-xs text-foreground-muted">{shown.unit}</span>
        </span>
      )}
      {energy !== null && (
        <span
          data-testid="power-meter-energy"
          className="ml-auto flex items-baseline gap-1 tabular-nums"
          title={t('uiLibrary.powerMeterLine.energy', 'Energy')}
        >
          <span className="text-sm text-foreground-muted">{formatEnergyKwh(energy)}</span>
          <span className="text-xs text-foreground-subtle">kWh</span>
        </span>
      )}
    </div>
  )
}
