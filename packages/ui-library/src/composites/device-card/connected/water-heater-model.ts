/** `water-heater` → the water-heater card. Pure. */
import type { WaterHeaterStatus } from '@camstack/types'
import type { UiTextFn } from '../../../contexts/ui-text'
import type { WaterHeaterActivity, WaterHeaterModeOption } from '../scenes/water-heater/model'

/** The mode that switches the heater off (the cap's power convention). */
export const WATER_HEATER_OFF_MODE = 'off'

/**
 * Off when its mode is off (or unknown), away when away is on, heating while
 * the water is under the target, otherwise at temperature.
 */
export function waterHeaterActivityOf(status: WaterHeaterStatus): WaterHeaterActivity {
  if (status.operationMode === null || status.operationMode === WATER_HEATER_OFF_MODE) return 'off'
  if (status.away === true) return 'away'
  const { currentTemp, targetTemp } = status
  if (currentTemp !== null && targetTemp !== null && currentTemp < targetTemp) return 'heat'
  return 'idle'
}

/** The words of a mode the device names; one not listed is drawn as the device wrote it. */
export function waterHeaterModeLabel(mode: string, t: UiTextFn): string {
  switch (mode) {
    case 'off':
      return t('uiLibrary.deviceCard.waterHeater.mode.off', 'Off')
    case 'eco':
      return t('uiLibrary.deviceCard.waterHeater.mode.eco', 'Eco')
    case 'electric':
      return t('uiLibrary.deviceCard.waterHeater.mode.electric', 'Electric')
    case 'gas':
      return t('uiLibrary.deviceCard.waterHeater.mode.gas', 'Gas')
    case 'heat_pump':
      return t('uiLibrary.deviceCard.waterHeater.mode.heatPump', 'Heat pump')
    case 'high_demand':
      return t('uiLibrary.deviceCard.waterHeater.mode.highDemand', 'High demand')
    case 'performance':
      return t('uiLibrary.deviceCard.waterHeater.mode.performance', 'Performance')
    case 'boost':
      return t('uiLibrary.deviceCard.waterHeater.mode.boost', 'Boost')
    case 'low':
      return t('uiLibrary.deviceCard.waterHeater.mode.low', 'Low')
    case 'high':
      return t('uiLibrary.deviceCard.waterHeater.mode.high', 'High')
    case 'auto':
      return t('uiLibrary.deviceCard.waterHeater.mode.auto', 'Auto')
    case 'manual':
      return t('uiLibrary.deviceCard.waterHeater.mode.manual', 'Manual')
    default:
      return mode
  }
}

export function waterHeaterModeOptions(
  modes: readonly string[],
  t: UiTextFn,
): readonly WaterHeaterModeOption[] {
  return modes.map((id) => ({ id, label: waterHeaterModeLabel(id, t) }))
}

/**
 * The mode "turn on" writes: the last mode it ran in, else the first mode that
 * is not off. Null when the device cannot be switched off through its modes.
 */
export function waterHeaterOnMode(status: WaterHeaterStatus): string | null {
  if (!status.availableModes.includes(WATER_HEATER_OFF_MODE)) return null
  const last = status.lastActiveMode
  if (last !== undefined && last !== WATER_HEATER_OFF_MODE && status.availableModes.includes(last))
    return last
  return status.availableModes.find((m) => m !== WATER_HEATER_OFF_MODE) ?? null
}
