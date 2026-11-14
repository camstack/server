import type { ReactElement } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { DropIllustration } from '../../illustrations/DropIllustration'
import { cn } from '../../../../lib/cn'
import { DIAL_BOX_CLASS } from '../../parts/Dial'
import { MenuButton } from '../../parts/MenuButton'
import { type ColumnItem, columnButton, columnStep } from '../../shell/column-items'
import { rowSelector } from '../../shell/bottom-rows'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation, CardTone } from '../../shell/model'
import type { HumidifierActivity, HumidifierCardActions, HumidifierCardModel } from './model'

export interface HumidifierCardProps {
  readonly model: HumidifierCardModel
  readonly actions: HumidifierCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

/** One press of the target moves it by one percent, as the previous card did. */
export const HUMIDITY_STEP = 1

const TONE: Readonly<Record<HumidifierActivity, CardTone>> = {
  humidify: 'info',
  dry: 'warning',
  idle: 'success',
  off: 'muted',
}

export function humidifierStateLabel(activity: HumidifierActivity, t: UiTextFn): string {
  switch (activity) {
    case 'humidify':
      return t('uiLibrary.deviceCard.humidifier.humidifying', 'Humidifying')
    case 'dry':
      return t('uiLibrary.deviceCard.humidifier.drying', 'Drying')
    case 'idle':
      return t('uiLibrary.deviceCard.humidifier.idle', 'On')
    case 'off':
      return t('uiLibrary.deviceCard.humidifier.off', 'Off')
  }
}

function targetColumn(
  model: HumidifierCardModel,
  actions: HumidifierCardActions,
  held: boolean,
  t: UiTextFn,
): readonly ColumnItem[] {
  const target = model.targetHumidity
  if (target === null) return []
  const min = model.minHumidity ?? 0
  const max = model.maxHumidity ?? 100
  const step = (delta: number) => (): void => {
    const next = Math.max(min, Math.min(max, target + delta))
    if (next !== target) actions.onTarget(next)
  }
  return columnStep('target', {
    testId: 'dc-humid-target',
    value: `${Math.round(target)}%`,
    caption: t('uiLibrary.deviceCard.humidifier.target', 'target'),
    up: {
      glyph: 'plus',
      label: t('uiLibrary.deviceCard.humidifier.raise', 'Raise target'),
      disabled: held || !model.targetSettable || target >= max,
      onPress: step(HUMIDITY_STEP),
    },
    down: {
      glyph: 'minus',
      label: t('uiLibrary.deviceCard.humidifier.lower', 'Lower target'),
      disabled: held || !model.targetSettable || target <= min,
      onPress: step(-HUMIDITY_STEP),
    },
  })
}

/**
 * A humidifier or dehumidifier: the target on the left, a drop filled to the
 * room's humidity in the middle, power and mode on the right. Mist rises while
 * it humidifies and drops fall while it dries; off greys the drop and holds
 * the target.
 */
export function HumidifierCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: HumidifierCardProps): ReactElement {
  const t = useUiText()
  const off = model.activity === 'off'
  const held = off && model.power !== null
  const on = model.power === true
  return (
    <DeviceCard
      kind="humidifier"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.activity}
      state={{
        label: humidifierStateLabel(model.activity, t),
        since: model.since,
        tone: TONE[model.activity],
      }}
      scene={{
        columns: {
          left: targetColumn(model, actions, held, t),
          right:
            model.power === null
              ? []
              : [
                  columnButton('power', {
                    glyph: 'power',
                    tone: on ? 'primary' : 'default',
                    label: on
                      ? t('uiLibrary.deviceCard.turnOff', 'Turn off')
                      : t('uiLibrary.deviceCard.turnOn', 'Turn on'),
                    testId: 'dc-humid-power',
                    onPress: () => actions.onPower(!on),
                  }),
                ],
        },
        image: (
          <div className={cn(DIAL_BOX_CLASS, 'grid justify-items-center')}>
            <DropIllustration
              fill={model.currentHumidity === null ? null : model.currentHumidity / 100}
              off={off}
              className="h-auto w-full"
            />
            <div
              data-testid="dc-humid-current"
              className="absolute inset-x-0 top-[58%] grid -translate-y-1/2 justify-items-center"
            >
              <b className="text-xl font-semibold tabular-nums text-foreground @[10rem]:text-3xl">
                {model.currentHumidity === null ? '—' : `${Math.round(model.currentHumidity)}%`}
              </b>
              <small className="text-xs text-foreground-muted @[10rem]:text-sm">
                {t('uiLibrary.deviceCard.humidifier.current', 'now')}
              </small>
            </div>
          </div>
        ),
        bottom:
          model.modes.length === 0
            ? []
            : [
                rowSelector('mode', {
                  control: (
                    <MenuButton
                      testId="dc-humid-mode"
                      layout="stacked"
                      ariaLabel={t('uiLibrary.deviceCard.humidifier.modeMenu', 'Mode')}
                      options={model.modes}
                      value={model.mode}
                      disabled={held}
                      onChange={actions.onMode}
                    />
                  ),
                }),
              ],
      }}
    />
  )
}
