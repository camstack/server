/**
 * `heat-pump-status` → the heat-pump card. Pure: the connected card reads the
 * slice, these turn it into words and selectors. Every selector exists only
 * where the gateway named values to choose from, so a write never leaves
 * `allowed` (the same rules the device page's hero followed, D1026).
 */
import type { HeatPumpCircuit, HeatPumpOptionSetting, HeatPumpStatus } from '@camstack/types'
import type { UiTextFn } from '../../../contexts/ui-text'
import {
  HEAT_PUMP_SYSTEM_MODES,
  type HeatPumpActivity,
  type HeatPumpCircuitPicker,
  type HeatPumpCircuitView,
  type HeatPumpOption,
  type HeatPumpSystemModeView,
} from '../scenes/heat-pump/model'

const PROGRAMME = /^hm(\d+)$/

/** The words of a value the gateway names; one not listed is drawn as the gateway wrote it. */
export function heatPumpValueLabel(value: string, t: UiTextFn): string {
  const programme = PROGRAMME.exec(value)
  if (programme?.[1] !== undefined)
    return t('uiLibrary.deviceCard.heatPump.programmeN', 'Programme {{n}}', { n: programme[1] })
  switch (value) {
    case 'off':
      return t('uiLibrary.deviceCard.heatPump.value.off', 'Off')
    case 'on':
      return t('uiLibrary.deviceCard.heatPump.value.on', 'On')
    case 'auto':
      return t('uiLibrary.deviceCard.heatPump.value.auto', 'Auto')
    case 'manual':
      return t('uiLibrary.deviceCard.heatPump.value.manual', 'Manual')
    case 'low':
      return t('uiLibrary.deviceCard.heatPump.value.low', 'Low')
    case 'high':
      return t('uiLibrary.deviceCard.heatPump.value.high', 'High')
    case 'eco':
      return t('uiLibrary.deviceCard.heatPump.value.eco', 'Eco')
    case 'heat':
      return t('uiLibrary.deviceCard.heatPump.value.heat', 'Heat')
    case 'cool':
      return t('uiLibrary.deviceCard.heatPump.value.cool', 'Cool')
    case 'heatCool':
      return t('uiLibrary.deviceCard.heatPump.value.heatCool', 'Heat/cool')
    case 'ownprogram':
      return t('uiLibrary.deviceCard.heatPump.value.programme', 'Programme')
    default:
      return value
  }
}

function choosable(setting: HeatPumpOptionSetting | null): setting is HeatPumpOptionSetting {
  return setting !== null && setting.allowed.length > 0
}

function options(allowed: readonly string[], t: UiTextFn): readonly HeatPumpOption[] {
  return allowed.map((id) => ({ id, label: heatPumpValueLabel(id, t) }))
}

/** Hot water with a temperature level picks the level; otherwise the operation mode. */
export function heatPumpCircuitPicker(
  circuit: HeatPumpCircuit,
  t: UiTextFn,
): HeatPumpCircuitPicker | null {
  if (circuit.kind === 'dhw' && choosable(circuit.temperatureLevel)) {
    const level = circuit.temperatureLevel
    return { kind: 'level', value: level.value, options: options(level.allowed, t) }
  }
  const mode = circuit.operationMode
  if (!choosable(mode)) return null
  return { kind: 'mode', value: mode.value, options: options(mode.allowed, t) }
}

const degrees = (value: number | null, digits: number): string | null =>
  value === null ? null : `${value.toFixed(digits)}°`

export function heatPumpCircuitView(circuit: HeatPumpCircuit, t: UiTextFn): HeatPumpCircuitView {
  const picker = heatPumpCircuitPicker(circuit, t)
  const chosen =
    picker === null || picker.value === null ? null : heatPumpValueLabel(picker.value, t)
  if (circuit.kind === 'dhw') {
    const target = degrees(circuit.targetTemp, 0)
    const current = degrees(circuit.currentTemp, 1)
    return {
      id: circuit.id,
      label: circuit.label,
      status:
        circuit.active === true
          ? t('uiLibrary.deviceCard.heatPump.charging', 'Charging')
          : (current ?? chosen ?? '—'),
      detail:
        circuit.active === true && current !== null && target !== null
          ? `${current} → ${target}`
          : chosen,
      picker,
    }
  }
  const working =
    circuit.kind === 'cooling'
      ? t('uiLibrary.deviceCard.heatPump.cooling', 'Cooling')
      : t('uiLibrary.deviceCard.heatPump.heating', 'Heating')
  return {
    id: circuit.id,
    label: circuit.label,
    status: circuit.active === true ? working : (chosen ?? '—'),
    detail: degrees(circuit.targetTemp, 0),
    picker,
  }
}

/**
 * A mode whose values are `off` and one other is a toggle. Holiday is off /
 * programme: "on" keeps the programme that is set, else the first allowed one
 * (the full hm1..hm8 pick stays out of the card, D1026).
 */
function toggleOn(setting: HeatPumpOptionSetting, holiday: boolean): string | null {
  if (!setting.allowed.includes('off')) return null
  const others = setting.allowed.filter((v) => v !== 'off')
  if (holiday) {
    const current =
      setting.value !== null && PROGRAMME.test(setting.value) ? setting.value : undefined
    return current ?? others.find((v) => PROGRAMME.test(v)) ?? null
  }
  return others.length === 1 ? (others[0] ?? null) : null
}

/** Only the modes the gateway declares, in the fixed order silent, away, additional heater, holiday. */
export function heatPumpSystemModes(
  system: HeatPumpStatus['system'],
  t: UiTextFn,
): readonly HeatPumpSystemModeView[] {
  const out: HeatPumpSystemModeView[] = []
  for (const id of HEAT_PUMP_SYSTEM_MODES) {
    const setting = system[id]
    if (!choosable(setting)) continue
    out.push({
      id,
      value: setting.value,
      options: options(setting.allowed, t),
      toggleOn: toggleOn(setting, id === 'holiday'),
    })
  }
  return out
}

/**
 * What the pump is doing: idle when the compressor (else the electrical draw)
 * says it is not running; otherwise the kind of the active circuit. The cap
 * reports no defrost, so the card never invents one.
 */
export function heatPumpActivityOf(status: HeatPumpStatus): HeatPumpActivity {
  const { compressorPct, electricalW } = status.power
  const running =
    compressorPct !== null ? compressorPct > 0 : electricalW !== null ? electricalW > 0 : null
  const active = status.circuits.find((c) => c.active === true)
  if (running === false || (running === null && active === undefined)) return 'idle'
  if (active?.kind === 'dhw') return 'dhw'
  if (active?.kind === 'cooling') return 'cool'
  return 'heat'
}
