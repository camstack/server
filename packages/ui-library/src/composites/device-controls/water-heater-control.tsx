/**
 * The device-list row of a `DeviceType.WaterHeater` device: a compact
 * `current°→target°` readout and the mode. The device-detail hero is the
 * device card (`WaterHeaterCardHero` in panel-controls.tsx).
 */
import type { ReactNode } from 'react'
import type { WaterHeaterStatus } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import type { DeviceControlProps } from './control-registry'

/** The mutations the `water-heater` cap exposes (deviceId injected by the proxy). */
interface WaterHeaterCap {
  readonly setTargetTemp: (input: { temp: number }) => Promise<void>
  readonly setOperationMode: (input: { mode: string }) => Promise<void>
  readonly setAway: (input: { on: boolean }) => Promise<void>
}

function useWaterHeater(trpc: DeviceControlProps['trpc'], deviceId: number) {
  return useDeviceCapability<WaterHeaterCap, WaterHeaterStatus>({
    trpc,
    deviceId,
    cap: (d) => d.waterHeater as WaterHeaterCap | undefined,
    slice: (d) => d.state.waterHeater,
  })
}

// ── Inline ──────────────────────────────────────────────────────────────────

/**
 * WaterHeaterInlineControl — compact current→target readout + mode hint
 * for a device-list row. Must NOT blow out the row width.
 */
export function WaterHeaterInlineControl({
  trpc,
  deviceId,
  optimistic,
}: DeviceControlProps): ReactNode {
  const { cap, slice } = useWaterHeater(trpc, deviceId)
  const { display } = useOptimisticSlice<WaterHeaterStatus>(slice, {
    enabled: optimistic ?? true,
  })

  if (cap === undefined) return null
  if (display === undefined) return null

  return (
    <div className="inline-flex items-center gap-1.5 text-xs text-foreground-subtle">
      <span className="tabular-nums">
        {display.currentTemp !== null && (
          <>
            {display.currentTemp}°<span className="mx-0.5">→</span>
          </>
        )}
        {display.targetTemp !== null ? `${display.targetTemp}°` : '—'}
      </span>
      {display.operationMode !== null && (
        <span className="capitalize text-foreground-subtle/80">
          · {display.operationMode.replace(/_/g, ' ')}
        </span>
      )}
    </div>
  )
}
