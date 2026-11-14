import type { ReactElement } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { cn } from '../../../../lib/cn'
import { CardIcon } from '../../parts/CardIcon'
import { columnButton, columnValue } from '../../shell/column-items'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardCommon, CardCommonActions, CardOrientation } from '../../shell/model'
import { SCENE_ICON_CLASS } from '../../shell/scene-layout'
import { withError } from '../action/model'

export interface NotifierCardModel {
  readonly common: CardCommon
  /** Since the last delivery; null when it never sent. */
  readonly lastSent: string | null
  /** Why the last delivery failed; null when it went through. */
  readonly lastError: string | null
  /** Notifications waiting to go out. */
  readonly queued: number
  /** The binding implements `send`: a test can be sent. */
  readonly testable: boolean
}

export interface NotifierCardActions extends CardCommonActions {
  readonly onTest: () => void
}

export interface NotifierCardProps {
  readonly model: NotifierCardModel
  readonly actions: NotifierCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

/**
 * A notification destination (`notifier`): ready or failing, its last
 * delivery, what is queued, and a test message.
 */
export function NotifierCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: NotifierCardProps): ReactElement {
  const t = useUiText()
  const failed = model.lastError !== null && model.lastError !== ''
  return (
    <DeviceCard
      kind="notifier"
      common={withError(model.common, model.lastError)}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={failed ? 'failed' : 'ready'}
      state={{
        label: failed
          ? t('uiLibrary.deviceCard.notifier.failed', 'Delivery failed')
          : t('uiLibrary.deviceCard.notifier.ready', 'Ready'),
        since:
          model.lastSent === null
            ? t('uiLibrary.deviceCard.notifier.neverSent', 'never sent')
            : t('uiLibrary.deviceCard.notifier.lastSent', 'last sent {{since}} ago', {
                since: model.lastSent,
              }),
        tone: failed ? 'danger' : 'primary',
      }}
      scene={{
        alert: failed,
        columns: {
          left:
            model.queued > 0
              ? [
                  columnValue('queued', {
                    value: String(model.queued),
                    caption: t('uiLibrary.deviceCard.notifier.queued', 'Queued'),
                    testId: 'dc-notifier-queued',
                  }),
                ]
              : [],
          right: model.testable
            ? [
                columnButton('test', {
                  glyph: 'send',
                  label: t('uiLibrary.deviceCard.notifier.test', 'Send test'),
                  testId: 'dc-notifier-test',
                  onPress: actions.onTest,
                }),
              ]
            : [],
        },
        image: (
          <CardIcon
            glyph="send"
            className={cn(SCENE_ICON_CLASS, failed ? 'text-danger' : 'text-foreground-muted')}
          />
        ),
      }}
    />
  )
}
