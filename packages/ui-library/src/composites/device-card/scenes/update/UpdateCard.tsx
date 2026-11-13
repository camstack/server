import type { ReactElement } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { cn } from '../../../../lib/cn'
import { CardButton } from '../../parts/CardButton'
import { CardIcon } from '../../parts/CardIcon'
import { InfoTile } from '../../parts/InfoTile'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import type { UpdateCardActions, UpdateCardModel } from './model'

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
        since: model.stateText,
        tone: model.phase === 'installing' ? 'primary' : pending ? 'warning' : 'success',
      }}
      scene={{
        left: (
          <div className="grid w-full gap-1.5">
            <InfoTile
              label={t('uiLibrary.deviceCard.update.installed', 'Installed')}
              value={model.current}
              testId="dc-update-current"
            />
            <InfoTile
              label={t('uiLibrary.deviceCard.update.latest', 'Available')}
              value={model.available}
              tone={pending ? 'warning' : 'default'}
              testId="dc-update-available"
            />
          </div>
        ),
        image: (
          <CardIcon
            glyph="update"
            className={cn(
              'h-20 w-20',
              model.phase === 'installing'
                ? 'animate-pulse text-primary'
                : pending
                  ? 'text-warning'
                  : 'text-foreground-muted',
            )}
          />
        ),
        right:
          pending && model.installable ? (
            <CardButton
              glyph="install"
              tone="primary"
              data-testid="dc-update-install"
              onClick={actions.onInstall}
            >
              {t('uiLibrary.deviceCard.update.install', 'Install')}
            </CardButton>
          ) : null,
      }}
    />
  )
}
