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
import {
  type BottomRow,
  rowButtons,
  rowSelector,
  rowStats,
  rowTimer,
  rowTrend,
} from '../../shell/bottom-rows'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import { SCENE_DRAWING_CLASS } from '../../shell/scene-layout'
import {
  FAN_MIN_SWEEP,
  type FanAxisModel,
  type FanAxisName,
  type FanCardActions,
  type FanCardModel,
  type FanReading,
  signedDegrees,
} from './model'

/** The most readings one readout row holds: three keeps a long label such as "Temperatura" whole on a phone. */
const READOUT_PER_ROW = 3

/** The device's own readings as secondary rows under the fan's controls: read-only, never a control. */
function readoutRows(
  readings: readonly FanReading[],
  open: FanReadingOpen | undefined,
): readonly BottomRow[] {
  const rows: BottomRow[] = []
  for (let from = 0; from < readings.length; from += READOUT_PER_ROW) {
    rows.push(
      rowStats(`readings-${String(from)}`, {
        testId: 'dc-fan-readings',
        cellTestId: 'dc-fan-reading',
        stats: readings.slice(from, from + READOUT_PER_ROW).map((r) => ({
          id: r.id,
          name: r.name,
          value: r.value,
          ...(r.visual === undefined ? {} : { visual: r.visual }),
          ...(r.trend === undefined ? {} : { trend: r.trend }),
          ...(open === undefined
            ? {}
            : {
                onSelect: open.onSelect,
                selected: r.id === open.selectedId,
                dimmed: open.selectedId !== null && r.id !== open.selectedId,
              }),
        })),
      }),
    )
  }
  if (open?.detail !== undefined && open.detail !== null) {
    rows.push(rowTrend('readings-detail', { trend: open.detail }))
  }
  return rows
}

/** Which reading is open: a tap on a readout cell opens its chart under the readout rows. */
export interface FanReadingOpen {
  readonly selectedId: string | null
  readonly onSelect: (id: string) => void
  /** The open reading's chart; `null` = none open. */
  readonly detail: ReactElement | null
}

export interface FanCardProps {
  readonly model: FanCardModel
  readonly actions: FanCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
  /** Makes the readout cells buttons that open that reading's chart (absent = read-only). */
  readonly readingOpen?: FanReadingOpen
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
    : t('uiLibrary.deviceCard.fan.fixedAt', 'fixed {{angle}}', {
        angle: signedDegrees(axis.angle),
      })
  const range = {
    min: axis.min,
    max: axis.max,
    step: axis.step,
    valueLabel: signedDegrees,
  }
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
            onCommit={(v) =>
              onAxis(name, {
                sweepFrom: Math.min(v, axis.sweepTo - FAN_MIN_SWEEP),
              })
            }
          />
          <HorizontalSlider
            {...range}
            label={t('uiLibrary.deviceCard.fan.to', 'To')}
            ariaLabel={t('uiLibrary.deviceCard.fan.to', 'To')}
            value={axis.sweepTo}
            onCommit={(v) =>
              onAxis(name, {
                sweepTo: Math.max(v, axis.sweepFrom + FAN_MIN_SWEEP),
              })
            }
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
  readingOpen,
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
          ...readoutRows(model.readings ?? [], readingOpen),
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

const STILL_AXIS: FanAxisDrawing = {
  oscillating: false,
  from: 0,
  to: 0,
  fixed: 0,
}

function drawnAxis(axis: FanAxisModel | null): FanAxisDrawing {
  if (axis === null) return STILL_AXIS
  return {
    oscillating: axis.oscillating,
    from: axis.sweepFrom,
    to: axis.sweepTo,
    fixed: axis.angle,
  }
}
