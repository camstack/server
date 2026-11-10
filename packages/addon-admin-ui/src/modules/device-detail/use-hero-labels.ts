import type { HeroConfirm } from '@camstack/types'
import type { HeroConfirmLabels, HeroLabels } from '@camstack/ui-library'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

const CONFIRM_COPY: Readonly<Record<HeroConfirm, HeroConfirmLabels>> = {
  'off-while-running': {
    title: 'Turn off while running?',
    message: 'The device is running. Cutting its power now interrupts what it is doing.',
    confirm: 'Turn off',
  },
  unlock: {
    title: 'Unlock?',
    message: 'The lock will open.',
    confirm: 'Unlock',
  },
  install: {
    title: 'Install the update?',
    message: 'The device may restart and be unavailable for a while.',
    confirm: 'Install',
  },
  press: {
    title: 'Run it now?',
    message: 'The device acts as soon as you confirm.',
    confirm: 'Run',
  },
}

/** The i18n namespace of a confirmation; the first one predates the others. */
const confirmKey = (kind: HeroConfirm): string =>
  kind === 'off-while-running' ? 'deviceHero.model.confirmOff' : `deviceHero.model.confirm.${kind}`

/** The hero card's strings in the admin UI's language (`deviceHero.*`, en + it in the admin catalog). */
export function useHeroLabels(): HeroLabels {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  return useMemo((): HeroLabels => {
    const confirmOf = (kind: HeroConfirm): HeroConfirmLabels => ({
      title: t(`${confirmKey(kind)}.title`, CONFIRM_COPY[kind].title),
      message: t(`${confirmKey(kind)}.message`, CONFIRM_COPY[kind].message),
      confirm: t(`${confirmKey(kind)}.confirm`, CONFIRM_COPY[kind].confirm),
    })
    return {
      noValue: t('deviceHero.model.noValue', '–'),
      callFailed: t('deviceHero.model.callFailed', 'The device did not accept the command'),
      historyTooltip: t('deviceHero.utility.history.tooltip', 'Opens the history of this device.'),
      consumables: {
        label: t('deviceHero.utility.consumables.label', 'Consumables'),
        low: (count) => t('deviceHero.utility.consumables.low', '{{count}} low', { count }),
        ok: t('deviceHero.utility.consumables.ok', 'OK'),
        tooltip: t(
          'deviceHero.utility.consumables.tooltip',
          'Shows the level of each consumable and which ones need attention.',
        ),
      },
      power: {
        label: t('deviceHero.utility.power.label', 'Power source'),
        on: t('deviceHero.utility.power.on', 'On'),
        off: t('deviceHero.utility.power.off', 'Off'),
        tooltip: t(
          'deviceHero.utility.power.tooltip',
          'Opens a menu to cut or restore the power feeding this device, or to restart it.',
        ),
        tooltipReadOnly: t(
          'deviceHero.utility.power.tooltipReadOnly',
          'Whether the power source feeding this device is on. Your session cannot change it.',
        ),
      },
      confirm: {
        'off-while-running': confirmOf('off-while-running'),
        unlock: confirmOf('unlock'),
        install: confirmOf('install'),
        press: confirmOf('press'),
      },
    }
    // `t` changes with the language; `language` keeps the memo honest when it does not.
  }, [t, language])
}
