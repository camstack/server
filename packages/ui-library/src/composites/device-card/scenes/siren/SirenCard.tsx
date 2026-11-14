import type { ReactElement } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { SirenIllustration } from '../../illustrations/SirenIllustration'
import { type ColumnItem, columnArmedButton, columnButton } from '../../shell/column-items'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import { SCENE_DRAWING_CLASS } from '../../shell/scene-layout'
import type { SirenCardActions, SirenCardModel } from './model'

export interface SirenCardProps {
  readonly model: SirenCardModel
  readonly actions: SirenCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

function sirenCommands(
  model: SirenCardModel,
  actions: SirenCardActions,
  t: UiTextFn,
): readonly ColumnItem[] {
  if (!model.switchable) return []
  const sound = columnArmedButton('sound', {
    glyph: 'siren',
    label: t('uiLibrary.deviceCard.siren.sound', 'Sound'),
    testId: 'dc-siren-sound',
    onConfirm: () => actions.onSound(true),
  })
  const silence = columnButton('silence', {
    glyph: 'mute',
    tone: 'primary',
    label: t('uiLibrary.deviceCard.siren.silence', 'Silence'),
    testId: 'dc-siren-silence',
    onPress: () => actions.onSound(false),
  })
  if (model.activity === 'sounding') return [silence]
  if (model.activity === 'unknown') return [sound, silence]
  return [sound]
}

/**
 * A siren: the horn, waves and a red scene while it sounds. Sounding it is
 * armed (a second press confirms); silencing it is one press. An unknown
 * state offers both, because neither sounding nor silent is known.
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
        image: <SirenIllustration sounding={sounding} className={SCENE_DRAWING_CLASS} />,
        columns: { right: sirenCommands(model, actions, t) },
      }}
    />
  )
}
