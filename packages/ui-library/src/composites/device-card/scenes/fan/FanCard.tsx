import { NOT_REPORTED } from '@camstack/types'
import type { ReactElement } from 'react'
import { Checkbox } from '../../../../primitives/checkbox'
import { useUiText } from '../../../../contexts/ui-text'
import { AmbientFx } from '../../illustrations/AmbientFx'
import { type FanAxisDrawing, FanIllustration } from '../../illustrations/FanIllustration'
import { MenuButton } from '../../parts/MenuButton'
import { PopoverButton } from '../../parts/PopoverButton'
import { HorizontalSlider } from '../../parts/sliders'
import { useTimerSince } from '../../parts/SwitchTimer'
import { columnButton, columnSlider } from '../../shell/column-items'
import { rowButtons, rowSelector, rowTimer } from '../../shell/bottom-rows'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import { SCENE_DRAWING_CLASS } from '../../shell/scene-layout'
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
      ? NOT_REPORTED.en
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
        columns: {
          left:
            model.speed === null
              ? []
              : [
                  columnSlider('speed', {
                    value: model.speed,
                    min: 0,
                    max: 100,
                    step: model.speedStep,
                    ariaLabel: t('uiLibrary.deviceCard.fan.speed', 'Speed'),
                    disabled: !on || pending,
                    valueLabel: (v) => (on && !pending ? `${v}%` : null),
                    onCommit: actions.onSpeed,
                    testId: 'dc-fan-speed',
                  }),
                ],
          right: [
            columnButton('power', {
              glyph: 'power',
              tone: on ? 'primary' : 'default',
              label: on
                ? t('uiLibrary.deviceCard.turnOff', 'Turn off')
                : t('uiLibrary.deviceCard.turnOn', 'Turn on'),
              testId: 'dc-fan-power',
              onPress: () => actions.onPower(!on),
            }),
            ...(model.oscillating === null || axes !== null
              ? []
              : [
                  columnButton('oscillate', {
                    glyph: 'swingHorizontal',
                    tone: model.oscillating ? 'on' : 'default',
                    pressed: model.oscillating,
                    disabled: !on,
                    label: t('uiLibrary.deviceCard.fan.oscillation', 'Oscillation'),
                    testId: 'dc-fan-oscillate',
                    onPress: () => actions.onOscillating(model.oscillating !== true),
                  }),
                ]),
            ...(model.direction === null
              ? []
              : [
                  columnButton('direction', {
                    glyph: reverse ? 'directionReverse' : 'directionForward',
                    disabled: !on || pending,
                    label: pending
                      ? t('uiLibrary.deviceCard.fan.direction', 'Direction')
                      : reverse
                        ? t('uiLibrary.deviceCard.fan.winter', 'Winter')
                        : t('uiLibrary.deviceCard.fan.summer', 'Summer'),
                    testId: 'dc-fan-direction',
                    onPress: () => actions.onDirection(reverse ? 'forward' : 'reverse'),
                  }),
                ]),
          ],
        },
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
            className={SCENE_DRAWING_CLASS}
          />
        ),
        bottom: [
          ...(model.presets.length === 0
            ? []
            : [
                rowSelector('preset', {
                  control: (
                    <MenuButton
                      options={model.presets}
                      value={model.preset}
                      onChange={actions.onPreset}
                      ariaLabel={t('uiLibrary.deviceCard.fan.preset', 'Preset')}
                      disabled={!on}
                      testId="dc-fan-preset"
                      layout="stacked"
                    />
                  ),
                }),
              ]),
          ...(axes === null
            ? []
            : [
                rowButtons('axes', {
                  buttons: [
                    ...(axes.horizontal === null
                      ? []
                      : [
                          <AxisButton
                            key="horizontal"
                            name="horizontal"
                            axis={axes.horizontal}
                            disabled={!on}
                            onAxis={actions.onAxis}
                          />,
                        ]),
                    ...(axes.vertical === null
                      ? []
                      : [
                          <AxisButton
                            key="vertical"
                            name="vertical"
                            axis={axes.vertical}
                            disabled={!on}
                            onAxis={actions.onAxis}
                          />,
                        ]),
                  ],
                }),
              ]),
          ...(model.timer === null ? [] : [rowTimer('timer', { timer: model.timer, actions })]),
        ],
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
