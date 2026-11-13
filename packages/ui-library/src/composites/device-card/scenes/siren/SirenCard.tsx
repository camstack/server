import type { ReactElement } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { SirenIllustration } from '../../illustrations/SirenIllustration'
import { ArmedButton } from '../../parts/ArmedButton'
import { CardButton } from '../../parts/CardButton'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import type { SirenCardActions, SirenCardModel } from './model'

export interface SirenCardProps {
  readonly model: SirenCardModel
  readonly actions: SirenCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

/**
 * A siren: the horn, waves and a red scene while it sounds. Sounding it is
 * armed (a second press confirms); silencing it is one press.
 */
export function SirenCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: SirenCardProps): ReactElement {
  const t = useUiText()
  const sounding = model.activity === 'sounding'
  return (
    <DeviceCard
      kind="siren"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.activity}
      state={{
        label: sounding
          ? t('uiLibrary.deviceCard.siren.sounding', 'Sounding')
          : model.activity === 'unknown'
            ? t('uiLibrary.deviceCard.siren.unknown', 'State unknown')
            : t('uiLibrary.deviceCard.siren.silent', 'Silent'),
        since: model.since,
        tone: sounding ? 'danger' : 'muted',
      }}
      scene={{
        alert: sounding,
        image: <SirenIllustration sounding={sounding} className="h-auto w-28" />,
        right: !model.switchable ? null : sounding ? (
          <CardButton
            glyph="mute"
            tone="primary"
            data-testid="dc-siren-silence"
            onClick={() => actions.onSound(false)}
          >
            {t('uiLibrary.deviceCard.siren.silence', 'Silence')}
          </CardButton>
        ) : (
          <ArmedButton
            testId="dc-siren-sound"
            glyph="siren"
            onConfirm={() => actions.onSound(true)}
          >
            {t('uiLibrary.deviceCard.siren.sound', 'Sound')}
          </ArmedButton>
        ),
      }}
    />
  )
}
