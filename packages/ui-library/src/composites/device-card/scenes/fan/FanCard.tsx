import type { ReactElement } from 'react'
import { Checkbox } from '../../../../primitives/checkbox'
import { useUiText } from '../../../../contexts/ui-text'
import { AmbientFx } from '../../illustrations/AmbientFx'
import { type FanAxisDrawing, FanIllustration } from '../../illustrations/FanIllustration'
import { CardButton } from '../../parts/CardButton'
import { MenuButton } from '../../parts/MenuButton'
import { PopoverButton } from '../../parts/PopoverButton'
import { HorizontalSlider, VerticalSlider } from '../../parts/sliders'
import { SwitchTimer, useTimerSince } from '../../parts/SwitchTimer'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import {
  FAN_MIN_SWEEP,
  type FanAxisModel,
  type FanAxisName,
  type FanCardActions,
  type FanCardModel,
  signedDegrees,
} from './model'

export interface FanCardProps {
  readonly model: FanCardModel
  readonly actions: FanCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

/** One axis: its button says the sweep (or the held angle); the popover edits it. */
function AxisButton({
  name,
  axis,
  disabled,
  onAxis,
}: {
  readonly name: FanAxisName
  readonly axis: FanAxisModel
  readonly disabled: boolean
  readonly onAxis: FanCardActions['onAxis']
}): ReactElement {
  const t = useUiText()
  const title =
    name === 'horizontal'
      ? t('uiLibrary.deviceCard.fan.horizontal', 'Horizontal')
      : t('uiLibrary.deviceCard.fan.vertical', 'Vertical')
  const summary = axis.oscillating
    ? `${signedDegrees(axis.sweepFrom)} … ${signedDegrees(axis.sweepTo)}`
    : t('uiLibrary.deviceCard.fan.fixedAt', 'fixed {{angle}}', { angle: signedDegrees(axis.angle) })
  const range = { min: axis.min, max: axis.max, step: axis.step, valueLabel: signedDegrees }
  return (
    <PopoverButton
      glyph={name === 'horizontal' ? 'swingHorizontal' : 'swing'}
      tone={axis.oscillating ? 'on' : 'default'}
      ariaLabel={title}
      disabled={disabled}
      testId={`dc-fan-axis-${name}`}
      label={
        <>
          {title} <small className="text-foreground-muted tabular-nums">{summary}</small>
        </>
      }
    >
      <label className="flex items-center gap-2">
        <Checkbox
          checked={axis.oscillating}
          onChange={(e) => onAxis(name, { oscillating: e.currentTarget.checked })}
          data-testid={`dc-fan-axis-${name}-osc`}
        />
        {name === 'horizontal'
          ? t('uiLibrary.deviceCard.fan.oscillateHorizontal', 'Oscillate horizontally')
          : t('uiLibrary.deviceCard.fan.oscillateVertical', 'Oscillate vertically')}
      </label>
      {axis.oscillating ? (
        <>
          <HorizontalSlider
            {...range}
            label={t('uiLibrary.deviceCard.fan.from', 'From')}
            ariaLabel={t('uiLibrary.deviceCard.fan.from', 'From')}
            value={axis.sweepFrom}
            onCommit={(v) => onAxis(name, { sweepFrom: Math.min(v, axis.sweepTo - FAN_MIN_SWEEP) })}
          />
          <HorizontalSlider
            {...range}
            label={t('uiLibrary.deviceCard.fan.to', 'To')}
            ariaLabel={t('uiLibrary.deviceCard.fan.to', 'To')}
            value={axis.sweepTo}
            onCommit={(v) => onAxis(name, { sweepTo: Math.max(v, axis.sweepFrom + FAN_MIN_SWEEP) })}
          />
        </>
      ) : (
        <HorizontalSlider
          {...range}
          label={t('uiLibrary.deviceCard.fan.fixed', 'Fixed')}
          ariaLabel={t('uiLibrary.deviceCard.fan.fixed', 'Fixed')}
          value={axis.angle}
          onCommit={(v) => onAxis(name, { angle: v })}
        />
      )}
    </PopoverButton>
  )
}

function oscillationWord(t: ReturnType<typeof useUiText>, model: FanCardModel): string | null {
  const axes = model.axes
  if (axes !== null) {
    const h = axes.horizontal?.oscillating === true
    const v = axes.vertical?.oscillating === true
    if (h && v) return t('uiLibrary.deviceCard.fan.oscillates3d', 'oscillates 3D')
    if (h || v) return t('uiLibrary.deviceCard.fan.oscillates', 'oscillates')
    return t('uiLibrary.deviceCard.fan.still', 'fixed')
  }
  return null
}

/**
 * The fan: on / off, its speed beside it, the presets, the blade direction,
 * and the oscillation — one switch, or one popover per axis for a fan that
 * reports its axes — then the switch's timed run.
 */
export function FanCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: FanCardProps): ReactElement {
  const t = useUiText()
  const on = model.on === true
  const label =
    model.on === null
      ? t('uiLibrary.deviceCard.unknown', 'Unknown')
      : on
        ? t('uiLibrary.deviceCard.fan.on', 'On')
        : t('uiLibrary.deviceCard.fan.off', 'Off')
  const osc = oscillationWord(t, model)
  const running =
    model.speed === null ? osc : [`${model.speed}%`, osc].filter((x) => x !== null).join(' · ')
  const since = useTimerSince(model.timer, on ? running || null : model.since)
  const reverse = model.direction === 'reverse'
  const axes = model.axes
  const pending = model.pending === true
  const hasBottom = model.oscillating !== null || axes !== null || model.timer !== null
  return (
    <DeviceCard
      kind="fan"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={on ? 'run' : 'off'}
      state={{ label, since, tone: on ? 'info' : 'muted' }}
      scene={{
        fx: on ? (
          <AmbientFx role="fan" activity="run" swing={false} speed={model.speed ?? 60} />
        ) : null,
        left:
          model.speed === null ? null : (
            <VerticalSlider
              value={model.speed}
              min={0}
              max={100}
              step={model.speedStep}
              ariaLabel={t('uiLibrary.deviceCard.fan.speed', 'Speed')}
              disabled={!on || pending}
              valueLabel={(v) => (on && !pending ? `${v}%` : null)}
              onCommit={actions.onSpeed}
              testId="dc-fan-speed"
            />
          ),
        image: (
          <FanIllustration
            on={on}
            speed={model.speed}
            reverse={reverse}
            sway={model.oscillating === true}
            axes={
              axes === null
                ? null
                : {
                    horizontal: drawnAxis(axes.horizontal),
                    vertical: drawnAxis(axes.vertical),
                  }
            }
            className="h-31 w-31"
          />
        ),
        right: (
          <>
            <CardButton
              glyph="power"
              tone={on ? 'primary' : 'default'}
              data-testid="dc-fan-power"
              onClick={() => actions.onPower(!on)}
            >
              {on
                ? t('uiLibrary.deviceCard.turnOff', 'Turn off')
                : t('uiLibrary.deviceCard.turnOn', 'Turn on')}
            </CardButton>
            {model.presets.length === 0 ? null : (
              <MenuButton
                options={model.presets}
                value={model.preset}
                onChange={actions.onPreset}
                ariaLabel={t('uiLibrary.deviceCard.fan.preset', 'Preset')}
                disabled={!on}
                testId="dc-fan-preset"
                layout="stacked"
              />
            )}
            {model.direction === null ? null : (
              <CardButton
                glyph={reverse ? 'directionReverse' : 'directionForward'}
                disabled={!on || pending}
                data-testid="dc-fan-direction"
                onClick={() => actions.onDirection(reverse ? 'forward' : 'reverse')}
              >
                {pending
                  ? t('uiLibrary.deviceCard.fan.direction', 'Direction')
                  : reverse
                    ? t('uiLibrary.deviceCard.fan.winter', 'Winter')
                    : t('uiLibrary.deviceCard.fan.summer', 'Summer')}
              </CardButton>
            )}
          </>
        ),
        bottom: hasBottom ? (
          <>
            {model.oscillating === null || axes !== null ? null : (
              <CardButton
                glyph="swingHorizontal"
                tone={model.oscillating ? 'on' : 'default'}
                aria-pressed={model.oscillating}
                disabled={!on}
                data-testid="dc-fan-oscillate"
                onClick={() => actions.onOscillating(model.oscillating !== true)}
              >
                {t('uiLibrary.deviceCard.fan.oscillation', 'Oscillation')}
              </CardButton>
            )}
            {axes === null ? null : (
              <div className="flex flex-wrap justify-center gap-1.5">
                {axes.horizontal === null ? null : (
                  <AxisButton
                    name="horizontal"
                    axis={axes.horizontal}
                    disabled={!on}
                    onAxis={actions.onAxis}
                  />
                )}
                {axes.vertical === null ? null : (
                  <AxisButton
                    name="vertical"
                    axis={axes.vertical}
                    disabled={!on}
                    onAxis={actions.onAxis}
                  />
                )}
              </div>
            )}
            {model.timer === null ? null : <SwitchTimer timer={model.timer} actions={actions} />}
          </>
        ) : null,
      }}
    />
  )
}

const STILL_AXIS: FanAxisDrawing = { oscillating: false, from: 0, to: 0, fixed: 0 }

function drawnAxis(axis: FanAxisModel | null): FanAxisDrawing {
  if (axis === null) return STILL_AXIS
  return {
    oscillating: axis.oscillating,
    from: axis.sweepFrom,
    to: axis.sweepTo,
    fixed: axis.angle,
  }
}
