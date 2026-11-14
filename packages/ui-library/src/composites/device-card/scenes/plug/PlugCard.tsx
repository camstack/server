import { NOT_REPORTED } from '@camstack/types'
import type { ReactElement } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { PlugIllustration } from '../../illustrations/PlugIllustration'
import { SwitchTimer } from '../../parts/SwitchTimer'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import { SCENE_DRAWING_CLASS } from '../../shell/scene-layout'
import { ScenePower } from '../../shell/ScenePower'
import type { PlugCardActions, PlugCardModel } from './model'

export interface PlugCardProps {
  readonly model: PlugCardModel
  readonly actions: PlugCardActions
  readonly orientation?: CardOrientation
  /** Draw the device name (default true); false when the host already names the device. */
  readonly showName?: boolean
}

/** The plug: on / off, the switch's timed run, and what the shell shows for any device. */
export function PlugCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: PlugCardProps): ReactElement {
  const t = useUiText()
  const on = model.on === true
  const label =
    model.on === null
      ? NOT_REPORTED.en
      : on
        ? t('uiLibrary.deviceCard.plug.on', 'On')
        : t('uiLibrary.deviceCard.plug.off', 'Off')
  return (
    <DeviceCard
      kind="plug"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={on ? 'on' : 'off'}
      state={{ label, since: model.since, tone: on ? 'primary' : 'muted' }}
      scene={{
        image: (
          <ScenePower
            on={on}
            label={t('uiLibrary.deviceCard.power', 'Power')}
            testId="dc-plug-power"
            onToggle={actions.onPower}
          >
            <PlugIllustration on={on} className={SCENE_DRAWING_CLASS} />
          </ScenePower>
        ),
        bottom: model.timer === null ? null : <SwitchTimer timer={model.timer} actions={actions} />,
      }}
    />
  )
}
