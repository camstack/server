import { heatPumpInstantCop } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useDeviceCommand } from '../../../hooks/use-device-command'
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
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const slice = useDeviceStateSlice(
    dev?.heatPumpStatus === undefined ? undefined : dev.state.heatPumpStatus,
  )
  const display = slice
  const runCommand = useDeviceCommand()
  if (dev?.heatPumpStatus === undefined || display === undefined) return null
  const control = dev.heatPumpControl
  const send = reportedCommand(runCommand, {
    fail: card.fail,
    succeed: card.succeed,
  })
  const has = (method: string): boolean => card.implements('heat-pump-control', method)
  const circuits = display.circuits.map((c) => {
    const view = heatPumpCircuitView(c, t, card.common.precision)
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
          send(() =>
            kind === 'level'
              ? control.setDhwTemperatureLevel({ circuitId, level: value })
              : circuit.kind === 'dhw'
                ? control.setDhwOperationMode({ circuitId, mode: value })
                : control.setCircuitOperationMode({ circuitId, mode: value }),
          )
        },
        onSystemMode: (id, value) => {
          if (control === undefined) return
          send(() => control[SYSTEM_METHOD[id]]({ mode: value }))
        },
      }}
    />
  )
}
