import type { ReactElement } from 'react'
import { CardButton } from '../../parts/CardButton'
import { CardIcon } from '../../parts/CardIcon'
import { CardReadings } from '../../parts/Readings'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import type { IrTransmitterCardActions, IrTransmitterCardModel } from './model'

export interface IrTransmitterCardProps {
  readonly model: IrTransmitterCardModel
  readonly actions: IrTransmitterCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

/** A transmitter: which media it speaks, whether it can learn, and the last two attempts. */
export function IrTransmitterCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: IrTransmitterCardProps): ReactElement {
  return (
    <DeviceCard
      kind="ir-transmitter"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.tone}
      state={{ label: model.headline, since: model.since, tone: model.tone }}
      scene={{
        columns: {},
        image: (
          <div className="grid aspect-square w-full min-w-26 max-w-40 place-items-center rounded-2xl border border-border bg-surface text-foreground">
            <CardIcon glyph="remote" className="h-auto w-2/5" />
          </div>
        ),
        bottom: (
          <div className="flex w-full flex-col items-stretch gap-2" data-testid="dc-ir-facts">
            <CardButton
              glyph="remote"
              tone="primary"
              disabled={!model.learnEnabled}
              onClick={actions.onLearn}
              data-testid="dc-ir-learn"
            >
              {model.learnLabel}
            </CardButton>
            <CardReadings items={model.readings} testId="dc-ir-readings" />
            {model.learned === null ? null : (
              <p className="text-center text-sm text-foreground" data-testid="dc-ir-learned">
                {model.learned}
              </p>
            )}
          </div>
        ),
      }}
    />
  )
}
