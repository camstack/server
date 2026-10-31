import { usePowerSourceGetStatus } from '@camstack/ui-library'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * One line above the hero: the state of the smart switch feeding this device.
 * Rendered only where a switch is linked AND its state is known — an unknown
 * state is never drawn as "off" (D393).
 */
export function DeviceHeroPowerLine({ deviceId }: { readonly deviceId: number }): ReactElement {
  const { t } = useTranslation()
  const status = usePowerSourceGetStatus({ deviceId }, { staleTime: 15_000 })
  const data = status.data
  if (data === undefined || data.linked !== true || data.switchOn === null) return <></>
  const state =
    data.switchOn === true
      ? t('deviceHero.powerLine.on', 'Power switch on')
      : t('deviceHero.powerLine.off', 'Power switch off')
  const text =
    data.switchName === null || data.switchName === ''
      ? state
      : t('deviceHero.powerLine.withName', '{{state}} · {{name}}', {
          state,
          name: data.switchName,
        })
  return <p className="px-3 pt-1 text-[11px] text-foreground-muted sm:px-4">{text}</p>
}
