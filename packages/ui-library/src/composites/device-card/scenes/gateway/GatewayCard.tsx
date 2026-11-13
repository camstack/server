import type { ReactElement } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { cn } from '../../../../lib/cn'
import { ArmedButton } from '../../parts/ArmedButton'
import { cardButtonClass } from '../../parts/CardButton'
import { CardIcon } from '../../parts/CardIcon'
import { InfoTile } from '../../parts/InfoTile'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardCommon, CardCommonActions, CardOrientation } from '../../shell/model'

/** What the box reports about itself; each fact is drawn only when present. */
export interface GatewayFacts {
  readonly model: string | null
  readonly firmware: string | null
  readonly address: string | null
}

export interface GatewayCardModel {
  readonly common: CardCommon
  readonly facts: GatewayFacts
  /** The device binds `reboot`. */
  readonly rebootable: boolean
  /** The box's own management page, from `device-admin-link`. */
  readonly adminLink: { readonly url: string; readonly label: string } | null
}

export interface GatewayCardActions extends CardCommonActions {
  readonly onReboot: () => void
}

export interface GatewayCardProps {
  readonly model: GatewayCardModel
  readonly actions: GatewayCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

/**
 * The bridge box of an ecosystem: connected or unreachable, its firmware and
 * address, a two-step restart and a link to its own page — each only when the
 * box declares it.
 */
export function GatewayCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: GatewayCardProps): ReactElement {
  const t = useUiText()
  const unreachable = model.common.online === false
  const facts = [
    {
      id: 'model',
      label: t('uiLibrary.deviceCard.gateway.model', 'Model'),
      value: model.facts.model,
    },
    {
      id: 'firmware',
      label: t('uiLibrary.deviceCard.gateway.firmware', 'Firmware'),
      value: model.facts.firmware,
    },
    {
      id: 'address',
      label: t('uiLibrary.deviceCard.gateway.address', 'Address'),
      value: model.facts.address,
    },
  ].filter((fact) => fact.value !== null)
  const showRight = model.rebootable || model.adminLink !== null
  return (
    <DeviceCard
      kind="gateway"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={unreachable ? 'unreachable' : 'connected'}
      state={{
        label:
          model.common.online === null
            ? t('uiLibrary.deviceCard.gateway.unknown', 'State unknown')
            : unreachable
              ? t('uiLibrary.deviceCard.gateway.unreachable', 'Unreachable')
              : t('uiLibrary.deviceCard.gateway.connected', 'Connected'),
        since: null,
        tone: unreachable ? 'danger' : 'primary',
      }}
      scene={{
        alert: unreachable,
        left:
          facts.length === 0 ? null : (
            <div className="grid w-full gap-1.5">
              {facts.map((fact) => (
                <InfoTile
                  key={fact.id}
                  label={fact.label}
                  value={fact.value}
                  testId={`dc-gateway-${fact.id}`}
                />
              ))}
            </div>
          ),
        image: (
          <CardIcon
            glyph="gateway"
            className={cn('h-20 w-20', unreachable ? 'text-danger' : 'text-foreground-muted')}
          />
        ),
        right: showRight ? (
          <>
            {model.rebootable ? (
              <ArmedButton testId="dc-gateway-reboot" glyph="restart" onConfirm={actions.onReboot}>
                {t('uiLibrary.deviceCard.gateway.reboot', 'Restart')}
              </ArmedButton>
            ) : null}
            {model.adminLink === null ? null : (
              <a
                href={model.adminLink.url}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="dc-gateway-admin"
                title={model.adminLink.label}
                aria-label={model.adminLink.label}
                className={cardButtonClass('default', false)}
              >
                <CardIcon glyph="open" />
                {t('uiLibrary.deviceCard.gateway.open', 'Open')}
              </a>
            )}
          </>
        ) : null,
      }}
    />
  )
}
