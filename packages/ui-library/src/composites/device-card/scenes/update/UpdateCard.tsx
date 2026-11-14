import type { ReactElement } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { cn } from '../../../../lib/cn'
import { CardIcon } from '../../parts/CardIcon'
import { columnButton } from '../../shell/column-items'
import { rowStats } from '../../shell/bottom-rows'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import { SCENE_ICON_CLASS } from '../../shell/scene-layout'
import {
  type UpdateCardActions,
  type UpdateCardModel,
  type UpdateStateWord,
  type UpdateStep,
  updateStateWordOf,
} from './model'

function stepText(step: UpdateStep, t: UiTextFn): string {
  switch (step) {
    case 'sending':
      return t('uiLibrary.deviceCard.update.step.sending', 'Sending firmware')
    case 'ready':
      return t('uiLibrary.deviceCard.update.step.ready', 'Ready to install')
    case 'waiting':
      return t('uiLibrary.deviceCard.update.step.waiting', 'Waiting for the device')
    case 'applying':
      return t('uiLibrary.deviceCard.update.step.applying', 'Applying')
  }
}

/** The provider's word beside the phase, translated; never the raw code. */
function stateWordText(word: UpdateStateWord, t: UiTextFn): string | null {
  if (word === null) return null
  return word.kind === 'step' ? stepText(word.step, t) : word.text
}

export interface UpdateCardProps {
  readonly model: UpdateCardModel
  readonly actions: UpdateCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

/**
 * A firmware or software update: installed and available versions on the
 * left, the arrow in the middle, Install while one is pending.
 */
export function UpdateCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: UpdateCardProps): ReactElement {
  const t = useUiText()
  const pending = model.phase === 'available'
  return (
    <DeviceCard
      kind="update"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.phase}
      state={{
        label:
          model.phase === 'installing'
            ? t('uiLibrary.deviceCard.update.installing', 'Installing')
            : pending
              ? t('uiLibrary.deviceCard.update.available', 'Update available')
              : t('uiLibrary.deviceCard.update.current', 'Up to date'),
        since: stateWordText(updateStateWordOf(model.stateText), t),
        tone: model.phase === 'installing' ? 'primary' : pending ? 'warning' : 'success',
      }}
      scene={{
        image: (
          <CardIcon
            glyph="update"
            className={cn(
              SCENE_ICON_CLASS,
              model.phase === 'installing'
                ? 'animate-pulse text-primary'
                : pending
                  ? 'text-warning'
                  : 'text-foreground-muted',
            )}
          />
        ),
        columns: {
          right:
            pending && model.installable
              ? [
                  columnButton('install', {
                    glyph: 'install',
                    tone: 'primary',
                    label: t('uiLibrary.deviceCard.update.install', 'Install'),
                    testId: 'dc-update-install',
                    onPress: actions.onInstall,
                  }),
                ]
              : [],
        },
        bottom: [
          rowStats('versions', {
            stats: [
              {
                id: 'current',
                name: t('uiLibrary.deviceCard.update.installed', 'Installed'),
                value: model.current ?? '—',
                testId: 'dc-update-current',
              },
              {
                id: 'available',
                name: t('uiLibrary.deviceCard.update.latest', 'Available'),
                value: model.available ?? '—',
                tone: pending ? 'warning' : 'default',
                testId: 'dc-update-available',
              },
            ],
          }),
        ],
      }}
    />
  )
}
