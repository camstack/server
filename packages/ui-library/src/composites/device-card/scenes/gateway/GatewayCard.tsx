import type { ReactElement } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { cn } from '../../../../lib/cn'
import { CardIcon } from '../../parts/CardIcon'
import { columnArmedButton, columnLink } from '../../shell/column-items'
import { rowStats } from '../../shell/bottom-rows'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardCommon, CardCommonActions, CardOrientation } from '../../shell/model'
import { SCENE_ICON_CLASS } from '../../shell/scene-layout'

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
  ].flatMap((fact) =>
    fact.value === null ? [] : [{ id: fact.id, name: fact.label, value: fact.value }],
  )
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
        columns: {
          right: [
            ...(model.rebootable
              ? [
                  columnArmedButton('reboot', {
                    glyph: 'restart',
                    label: t('uiLibrary.deviceCard.gateway.reboot', 'Restart'),
                    testId: 'dc-gateway-reboot',
                    onConfirm: actions.onReboot,
                  }),
                ]
              : []),
            ...(model.adminLink === null
              ? []
              : [
                  columnLink('admin', {
                    glyph: 'open',
                    label: model.adminLink.label,
                    href: model.adminLink.url,
                    testId: 'dc-gateway-admin',
                  }),
                ]),
          ],
        },
        image: (
          <CardIcon
            glyph="gateway"
            className={cn(SCENE_ICON_CLASS, unreachable ? 'text-danger' : 'text-foreground-muted')}
          />
        ),
        bottom:
          facts.length === 0
            ? []
            : [
                rowStats('facts', {
                  stats: facts.map((fact) => ({ ...fact, testId: `dc-gateway-${fact.id}` })),
                }),
              ],
      }}
    />
  )
}
