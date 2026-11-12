import { NOT_REPORTED } from '@camstack/types'
import type { ReactElement } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { AmbientFx } from '../../illustrations/AmbientFx'
import { HeaterIllustration } from '../../illustrations/HeaterIllustration'
import { CardButton } from '../../parts/CardButton'
import { SwitchTimer, useTimerSince } from '../../parts/SwitchTimer'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import type { HeaterCardActions, HeaterCardModel } from './model'

export interface HeaterCardProps {
  readonly model: HeaterCardModel
  readonly actions: HeaterCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

/**
 * The heater on a switch: the plug's controls (power, the timed run) drawn
 * as a heater, the floor warming behind it while it heats.
 */
export function HeaterCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: HeaterCardProps): ReactElement {
  const t = useUiText()
  const on = model.on === true
  const label =
    model.on === null
      ? NOT_REPORTED.en
      : on
        ? t('uiLibrary.deviceCard.heater.heating', 'Heating')
        : t('uiLibrary.deviceCard.heater.off', 'Off')
  const since = useTimerSince(model.timer, model.since)
  return (
    <DeviceCard
      kind="heater"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={on ? 'heat' : 'off'}
      state={{ label, since, tone: on ? 'primary' : 'muted' }}
      scene={{
        fx: on ? <AmbientFx role="switch-heater" activity="heat" swing={false} /> : null,
        image: <HeaterIllustration on={on} className="h-28 w-30" />,
        right: (
          <CardButton
            glyph="power"
            tone={on ? 'primary' : 'default'}
            data-testid="dc-heater-power"
            onClick={() => actions.onPower(!on)}
          >
            {on
              ? t('uiLibrary.deviceCard.turnOff', 'Turn off')
              : t('uiLibrary.deviceCard.turnOn', 'Turn on')}
          </CardButton>
        ),
        bottom: model.timer === null ? null : <SwitchTimer timer={model.timer} actions={actions} />,
      }}
    />
  )
}
