import { type HeatPumpStatus, heatPumpInstantCop } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOptimisticSlice } from '../../../hooks/use-optimistic-slice'
import type { HeatPumpSystemModeId } from '../scenes/heat-pump/model'
import { HeatPumpCard } from '../scenes/heat-pump/HeatPumpCard'
import type { CardCommon } from '../shell/model'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { heatPumpCircuitView, heatPumpActivityOf, heatPumpSystemModes } from './heat-pump-model'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'

/** The pump's own electrical draw stands in when no power meter is bound. */
function withPower(common: CardCommon, electricalW: number | null): CardCommon {
  if (common.power !== null || electricalW === null) return common
  return { ...common, power: { watts: electricalW, details: [] } }
}

const SYSTEM_METHOD = {
  silent: 'setSilentMode',
  away: 'setAwayMode',
  additionalHeater: 'setAdditionalHeaterMode',
  holiday: 'setHolidayMode',
} as const satisfies Readonly<Record<HeatPumpSystemModeId, string>>

/** Writes one system mode into the slice's `system`, for the optimistic patch. */
function withSystemMode(
  system: HeatPumpStatus['system'],
  id: HeatPumpSystemModeId,
  value: string,
): HeatPumpStatus['system'] {
  const setting = system[id]
  return setting === null ? system : { ...system, [id]: { ...setting, value } }
}

/** Writes one circuit's mode / level into the slice's `circuits`, for the optimistic patch. */
function withCircuit(
  circuits: HeatPumpStatus['circuits'],
  circuitId: string,
  kind: 'mode' | 'level',
  value: string,
): HeatPumpStatus['circuits'] {
  return circuits.map((c) => {
    if (c.id !== circuitId) return c
    if (kind === 'level')
      return c.temperatureLevel === null
        ? c
        : { ...c, temperatureLevel: { ...c.temperatureLevel, value } }
    return c.operationMode === null ? c : { ...c, operationMode: { ...c.operationMode, value } }
  })
}

/**
 * A heat pump (`heat-pump-status`): what it reports, and through
 * `heat-pump-control` each circuit's mode / hot-water level and the four
 * system modes — each only when the gateway declares it and the binding
 * implements the method.
 */
export function ConnectedHeatPumpCard({
  deviceId,
  canActuate = true,
  orientation,
  optimistic = true,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const slice = useDeviceStateSlice(
    dev?.heatPumpStatus === undefined ? undefined : dev.state.heatPumpStatus,
  )
  const { display, applyOptimisticAction } = useOptimisticSlice<HeatPumpStatus>(slice, {
    enabled: optimistic,
  })
  if (dev?.heatPumpStatus === undefined || display === undefined) return null
  const control = dev.heatPumpControl
  const send = reportedCommand(applyOptimisticAction, { fail: card.fail, succeed: card.succeed })
  const has = (method: string): boolean => card.implements('heat-pump-control', method)
  const circuits = display.circuits.map((c) => {
    const view = heatPumpCircuitView(c, t)
    if (view.picker === null) return view
    const method =
      view.picker.kind === 'level'
        ? 'setDhwTemperatureLevel'
        : c.kind === 'dhw'
          ? 'setDhwOperationMode'
          : 'setCircuitOperationMode'
    return has(method) ? view : { ...view, picker: null }
  })
  const system = heatPumpSystemModes(display.system, t).filter((m) => has(SYSTEM_METHOD[m.id]))
  return (
    <HeatPumpCard
      orientation={orientation}
      showName={showName}
      model={{
        common: withPower(card.common, display.power.electricalW),
        activity: heatPumpActivityOf(display),
        since: null,
        temperatures: {
          outdoor: display.temperatures.outdoor,
          supply: display.temperatures.supply,
          return: display.temperatures.return,
        },
        pressureBar: display.waterPressureBar,
        compressorPct: display.power.compressorPct,
        thermalW: display.power.thermalW,
        electricalW: display.power.electricalW,
        cop: heatPumpInstantCop(display.power),
        circuits,
        system,
      }}
      actions={{
        ...card.actions,
        onCircuit: (circuitId, kind, value) => {
          if (control === undefined) return
          const circuit = display.circuits.find((c) => c.id === circuitId)
          if (circuit === undefined) return
          send({ circuits: withCircuit(display.circuits, circuitId, kind, value) }, () =>
            kind === 'level'
              ? control.setDhwTemperatureLevel({ circuitId, level: value })
              : circuit.kind === 'dhw'
                ? control.setDhwOperationMode({ circuitId, mode: value })
                : control.setCircuitOperationMode({ circuitId, mode: value }),
          )
        },
        onSystemMode: (id, value) => {
          if (control === undefined) return
          send({ system: withSystemMode(display.system, id, value) }, () =>
            control[SYSTEM_METHOD[id]]({ mode: value }),
          )
        },
      }}
    />
  )
}
