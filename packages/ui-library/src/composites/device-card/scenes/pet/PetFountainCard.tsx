import type { ReactElement } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { PetFountainIllustration } from '../../illustrations/PetFountainIllustration'
import { CardButton } from '../../parts/CardButton'
import { LevelRow } from '../../parts/LevelRow'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation, CardTone } from '../../shell/model'
import {
  FOUNTAIN_LOW_PERCENT,
  type PetFountainActivity,
  type PetFountainCardActions,
  type PetFountainCardModel,
} from './model'

export interface PetFountainCardProps {
  readonly model: PetFountainCardModel
  readonly actions: PetFountainCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

const TONE: Readonly<Record<PetFountainActivity, CardTone>> = {
  running: 'info',
  stopped: 'muted',
  empty: 'warning',
  fault: 'danger',
  unknown: 'muted',
}

export function petFountainStateLabel(activity: PetFountainActivity, t: UiTextFn): string {
  switch (activity) {
    case 'running':
      return t('uiLibrary.deviceCard.petFountain.running', 'Pump running')
    case 'stopped':
      return t('uiLibrary.deviceCard.petFountain.stopped', 'Pump stopped')
    case 'empty':
      return t('uiLibrary.deviceCard.petFountain.empty', 'Tank empty')
    case 'fault':
      return t('uiLibrary.deviceCard.petFountain.fault', 'Fault')
    case 'unknown':
      return t('uiLibrary.deviceCard.petFountain.unknown', 'Pump state unknown')
  }
}

/**
 * A drinking fountain: the basin filled to the tank's level with a jet while
 * the pump runs, the pump switch on the right, the water level under it (a
 * warning under 10%, where the pump stops).
 */
export function PetFountainCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: PetFountainCardProps): ReactElement {
  const t = useUiText()
  const pumping = model.pump === true || model.activity === 'running'
  const low =
    model.activity === 'empty' ||
    (model.waterLevel !== null && model.waterLevel < FOUNTAIN_LOW_PERCENT)
  return (
    <DeviceCard
      kind="pet-fountain"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.activity}
      state={{
        label: petFountainStateLabel(model.activity, t),
        since: model.since,
        tone: TONE[model.activity],
      }}
      scene={{
        alert: model.activity === 'fault',
        image: (
          <PetFountainIllustration
            water={model.waterLevel === null ? null : model.waterLevel / 100}
            pumping={pumping}
            className="h-auto w-28"
          />
        ),
        right:
          model.pump === null ? null : (
            <CardButton
              glyph="power"
              tone={model.pump ? 'primary' : 'default'}
              data-testid="dc-fountain-pump"
              onClick={() => actions.onPump(model.pump !== true)}
            >
              {model.pump
                ? t('uiLibrary.deviceCard.turnOff', 'Turn off')
                : t('uiLibrary.deviceCard.turnOn', 'Turn on')}
            </CardButton>
          ),
        bottom: (
          <div className="grid w-full justify-items-center gap-1.5">
            <LevelRow
              testId="dc-fountain-level"
              label={t('uiLibrary.deviceCard.petFountain.water', 'Water')}
              percent={model.waterLevel}
              warn={low}
            />
            {model.fault === null ? null : (
              <p data-testid="dc-fountain-fault" className="text-xs text-danger">
                {model.fault}
              </p>
            )}
          </div>
        ),
      }}
    />
  )
}
