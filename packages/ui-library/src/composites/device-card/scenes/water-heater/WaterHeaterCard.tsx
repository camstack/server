import type { ReactElement, ReactNode } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { AmbientFx } from '../../illustrations/AmbientFx'
import { TankIllustration } from '../../illustrations/TankIllustration'
import { CardButton } from '../../parts/CardButton'
import { MenuButton } from '../../parts/MenuButton'
import { StepColumn } from '../../parts/StepColumn'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation, CardTone } from '../../shell/model'
import type { WaterHeaterActivity, WaterHeaterCardActions, WaterHeaterCardModel } from './model'

export interface WaterHeaterCardProps {
  readonly model: WaterHeaterCardModel
  readonly actions: WaterHeaterCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

const TONE: Readonly<Record<WaterHeaterActivity, CardTone>> = {
  heat: 'primary',
  idle: 'success',
  away: 'info',
  off: 'muted',
}

/** The coldest water the tank draws as a sliver; the scale runs from here to the maximum. */
const COLD_FLOOR = 10
const MIN_FILL = 0.08
const DEFAULT_MAX = 75

/** How much of the tank the current temperature fills, never empty. */
export function waterHeaterFill(current: number | null, max: number | null): number {
  if (current === null) return MIN_FILL
  const top = max ?? DEFAULT_MAX
  return Math.max(MIN_FILL, Math.min(1, (current - COLD_FLOOR) / (top - COLD_FLOOR)))
}

export function waterHeaterStateLabel(activity: WaterHeaterActivity, t: UiTextFn): string {
  switch (activity) {
    case 'heat':
      return t('uiLibrary.deviceCard.waterHeater.heating', 'Heating')
    case 'idle':
      return t('uiLibrary.deviceCard.waterHeater.ready', 'At temperature')
    case 'away':
      return t('uiLibrary.deviceCard.waterHeater.away', 'Away')
    case 'off':
      return t('uiLibrary.deviceCard.waterHeater.off', 'Off')
  }
}

function targetColumn(
  model: WaterHeaterCardModel,
  actions: WaterHeaterCardActions,
  held: boolean,
  t: UiTextFn,
): ReactNode {
  const target = model.targetTemp
  if (target === null) return null
  const step = (delta: number) => (): void => {
    let next = target + delta
    if (model.minTemp !== null) next = Math.max(model.minTemp, next)
    if (model.maxTemp !== null) next = Math.min(model.maxTemp, next)
    if (next !== target) actions.onTarget(next)
  }
  return (
    <StepColumn
      testId="dc-wh-target"
      value={`${target}°`}
      notes={[t('uiLibrary.deviceCard.waterHeater.target', 'target')]}
      up={{
        glyph: 'plus',
        label: t('uiLibrary.deviceCard.waterHeater.raise', 'Raise target'),
        disabled:
          held || !model.targetSettable || (model.maxTemp !== null && target >= model.maxTemp),
        onPress: step(1),
      }}
      down={{
        glyph: 'minus',
        label: t('uiLibrary.deviceCard.waterHeater.lower', 'Lower target'),
        disabled:
          held || !model.targetSettable || (model.minTemp !== null && target <= model.minTemp),
        onPress: step(-1),
      }}
    />
  )
}

function rightColumn(
  model: WaterHeaterCardModel,
  actions: WaterHeaterCardActions,
  held: boolean,
  t: UiTextFn,
): ReactNode {
  const on = model.power === true
  return (
    <>
      {model.power === null ? null : (
        <CardButton
          glyph="power"
          tone={on ? 'primary' : 'default'}
          data-testid="dc-wh-power"
          onClick={() => actions.onPower(!on)}
        >
          {on
            ? t('uiLibrary.deviceCard.turnOff', 'Turn off')
            : t('uiLibrary.deviceCard.turnOn', 'Turn on')}
        </CardButton>
      )}
      {model.modes.length === 0 ? null : (
        <MenuButton
          testId="dc-wh-mode"
          layout="stacked"
          ariaLabel={t('uiLibrary.deviceCard.waterHeater.modeMenu', 'Mode')}
          options={model.modes}
          value={model.mode}
          disabled={held}
          onChange={actions.onMode}
        />
      )}
      {model.away === null ? null : (
        <CardButton
          glyph="away"
          tone={model.away ? 'on' : 'default'}
          aria-pressed={model.away}
          disabled={held}
          data-testid="dc-wh-away"
          onClick={() => actions.onAway(model.away !== true)}
        >
          {t('uiLibrary.deviceCard.waterHeater.away', 'Away')}
        </CardButton>
      )}
    </>
  )
}

/**
 * A water heater: the target on the left (within the device's range), the
 * tank filled to the water's temperature in the middle, power, mode and away
 * on the right — each only when the device declares it. Off greys the tank
 * and holds the controls that would not take.
 */
export function WaterHeaterCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: WaterHeaterCardProps): ReactElement {
  const t = useUiText()
  const off = model.activity === 'off'
  // Off holds the controls only when the power button can bring it back; a
  // device with no off mode and no reported mode must still be able to pick one.
  const held = off && model.power !== null
  const heating = model.activity === 'heat'
  return (
    <DeviceCard
      kind="water-heater"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.activity}
      state={{
        label: waterHeaterStateLabel(model.activity, t),
        since: model.since,
        tone: TONE[model.activity],
      }}
      scene={{
        fx: heating ? <AmbientFx role="water-heater" activity="heat" swing={false} /> : null,
        left: targetColumn(model, actions, held, t),
        image: (
          <div className="relative grid w-25 justify-items-center">
            <TankIllustration
              fill={waterHeaterFill(model.currentTemp, model.maxTemp)}
              heating={heating}
              off={off}
              className="h-auto w-25"
            />
            <div
              data-testid="dc-wh-current"
              className="absolute inset-x-0 top-1/2 grid -translate-y-1/2 justify-items-center"
            >
              <b className="text-xl font-semibold tabular-nums text-foreground">
                {model.currentTemp === null ? '—' : `${model.currentTemp.toFixed(1)}°`}
              </b>
              <small className="text-xs text-foreground-muted">
                {t('uiLibrary.deviceCard.waterHeater.current', 'now')}
              </small>
            </div>
          </div>
        ),
        right: rightColumn(model, actions, held, t),
      }}
    />
  )
}
