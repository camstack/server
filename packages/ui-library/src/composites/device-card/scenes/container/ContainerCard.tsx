import type { ReactElement } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { cn } from '../../../../lib/cn'
import { CardIcon } from '../../parts/CardIcon'
import { rowStats } from '../../shell/bottom-rows'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardCommon, CardCommonActions, CardOrientation } from '../../shell/model'
import { SCENE_ICON_CLASS } from '../../shell/scene-layout'
import type { ContainerCounts } from './container-model'

export interface ContainerCardModel {
  readonly common: CardCommon
  /** `null` = the children have not been read yet (never drawn as zero). */
  readonly counts: ContainerCounts | null
}

export interface ContainerCardProps {
  readonly model: ContainerCardModel
  readonly actions?: CardCommonActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

/** A device that holds others: how many of them are online, offline and low on battery. */
export function ContainerCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: ContainerCardProps): ReactElement {
  const t = useUiText()
  const { counts } = model
  const attention = counts !== null && (counts.offline > 0 || counts.lowBattery > 0)
  const value = (n: number | undefined): string => (n === undefined ? '—' : String(n))
  return (
    <DeviceCard
      kind="container"
      common={model.common}
      orientation={orientation}
      showName={showName}
      activity={attention ? 'attention' : 'ok'}
      {...(actions === undefined ? {} : { actions })}
      state={{
        label:
          counts === null
            ? t('uiLibrary.deviceCard.container.unknown', 'Counting…')
            : t('uiLibrary.deviceCard.container.summary', '{{online}} of {{total}} online', {
                online: counts.online,
                total: counts.total,
              }),
        since: null,
        tone: counts === null ? 'muted' : attention ? 'warning' : 'success',
      }}
      scene={{
        columns: {},
        image: (
          <CardIcon
            glyph="container"
            className={cn(SCENE_ICON_CLASS, attention ? 'text-warning' : 'text-foreground-muted')}
          />
        ),
        bottom: [
          rowStats('counts', {
            stats: [
              {
                id: 'online',
                name: t('uiLibrary.deviceCard.container.online', 'Online'),
                value: value(counts?.online),
                testId: 'dc-container-online',
              },
              {
                id: 'offline',
                name: t('uiLibrary.deviceCard.container.offline', 'Offline'),
                value: value(counts?.offline),
                tone: counts !== null && counts.offline > 0 ? 'warning' : 'default',
                testId: 'dc-container-offline',
              },
              {
                id: 'low',
                name: t('uiLibrary.deviceCard.container.lowBattery', 'Low battery'),
                value: value(counts?.lowBattery),
                tone: counts !== null && counts.lowBattery > 0 ? 'warning' : 'default',
                testId: 'dc-container-low',
              },
            ],
          }),
        ],
      }}
    />
  )
}
