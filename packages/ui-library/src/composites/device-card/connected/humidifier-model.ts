import type { HumidifierStatus } from '@camstack/types'
import type { UiTextFn } from '../../../contexts/ui-text'
import type { HumidifierActivity, HumidifierModeOption } from '../scenes/humidifier/model'

/** The card's activity: off when it is off, else what its `action` reports. */
export function humidifierActivityOf(
  status: Pick<HumidifierStatus, 'on' | 'action'>,
): HumidifierActivity {
  if (!status.on) return 'off'
  if (status.action === 'humidifying') return 'humidify'
  if (status.action === 'drying') return 'dry'
  if (status.action === 'off') return 'off'
  return 'idle'
}

export function humidifierModeLabel(mode: string, t: UiTextFn): string {
  switch (mode) {
    case 'auto':
      return t('uiLibrary.deviceCard.humidifier.mode.auto', 'Auto')
    case 'normal':
      return t('uiLibrary.deviceCard.humidifier.mode.normal', 'Normal')
    case 'eco':
      return t('uiLibrary.deviceCard.humidifier.mode.eco', 'Eco')
    case 'away':
      return t('uiLibrary.deviceCard.humidifier.mode.away', 'Away')
    case 'boost':
      return t('uiLibrary.deviceCard.humidifier.mode.boost', 'Boost')
    case 'comfort':
      return t('uiLibrary.deviceCard.humidifier.mode.comfort', 'Comfort')
    case 'home':
      return t('uiLibrary.deviceCard.humidifier.mode.home', 'Home')
    case 'sleep':
      return t('uiLibrary.deviceCard.humidifier.mode.sleep', 'Sleep')
    case 'baby':
      return t('uiLibrary.deviceCard.humidifier.mode.baby', 'Baby')
    default:
      return mode
  }
}

export function humidifierModeOptions(
  modes: readonly string[],
  t: UiTextFn,
): readonly HumidifierModeOption[] {
  return modes.map((id) => ({ id, label: humidifierModeLabel(id, t) }))
}
