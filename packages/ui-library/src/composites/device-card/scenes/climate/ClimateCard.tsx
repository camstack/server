import { type ReactElement, useState } from 'react'
import { cn } from '../../../../lib/cn'
import { useUiText } from '../../../../contexts/ui-text'
import { AmbientFx } from '../../illustrations/AmbientFx'
import { ClimateRoleGlyph } from '../../illustrations/ClimateRoleGlyph'
import { ButtonGroup } from '../../parts/ButtonGroup'
import { CardButton } from '../../parts/CardButton'
import { CardIcon } from '../../parts/CardIcon'
import { Dial, type DialTone } from '../../parts/Dial'
import { MenuButton } from '../../parts/MenuButton'
import { type DialRange, RangeDial } from '../../parts/RangeDial'
import { ValueChip } from '../../parts/ValueChip'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation, CardTone } from '../../shell/model'
import {
  type ClimateActivity,
  type ClimateCardActions,
  type ClimateCardModel,
  nextChoice,
} from './model'

export interface ClimateCardProps {
  readonly model: ClimateCardModel
  readonly actions: ClimateCardActions
  readonly orientation?: CardOrientation
}

const TONE: Readonly<Record<ClimateActivity, CardTone>> = {
  off: 'muted',
  idle: 'muted',
  unknown: 'muted',
  cool: 'info',
  heat: 'primary',
  window: 'warning',
}
const TEXT: Readonly<Record<CardTone, string>> = {
  muted: 'text-foreground-muted',
  info: 'text-info',
  primary: 'text-primary',
  warning: 'text-warning',
}

const degrees = (value: number, digits: number): string => `${value.toFixed(digits)}°`
/** A setpoint in a band readout: no trailing zero, so the pair fits one line. */
const bare = (value: number): string => String(Number(value.toFixed(1)))

/**
 * Climate, every role: the dial sets the target, the left column steps it, the
 * right column holds power / mode / fan, the bottom row presets and swing. A
 * block the device does not declare is not drawn.
 */
export function ClimateCard({
  model,
  actions,
  orientation = 'vertical',
}: ClimateCardProps): ReactElement {
  const t = useUiText()
  const [draft, setDraft] = useState<number | null>(null)
  const [bandDraft, setBandDraft] = useState<DialRange | null>(null)
  const { target, range, valve, activity } = model
  const band = range === null ? null : (bandDraft ?? { low: range.low, high: range.high })
  /** A valve that only reports: its opening is the number of the card. */
  const valveOnly = valve !== null && target === null && range === null && model.current === null
  const tone = TONE[activity]
  const dialTone: DialTone = activity === 'off' ? 'off' : tone
  /** A band is always drawn in a colour while the device is on: grey reads as no band. */
  const bandTone: DialTone = dialTone === 'muted' ? 'primary' : dialTone
  const shown = draft ?? target?.value ?? null
  const words: Readonly<Record<ClimateActivity, string>> = {
    off: t('uiLibrary.deviceCard.off', 'Off'),
    cool: t('uiLibrary.deviceCard.climate.cooling', 'Cooling'),
    heat: t('uiLibrary.deviceCard.climate.heating', 'Heating'),
    idle: t('uiLibrary.deviceCard.climate.idle', 'Idle'),
    window: t('uiLibrary.deviceCard.climate.window', 'Window open'),
    unknown: t('uiLibrary.deviceCard.on', 'On'),
  }
  const commit = (value: number): void => {
    setDraft(null)
    actions.onTarget(value)
  }
  const commitBand = (next: DialRange): void => {
    setBandDraft(null)
    actions.onRange(next.low, next.high)
  }
  const valveText =
    valve === null || valve.position === null ? '—' : `${Math.round(valve.position)}%`
  const stepBy = (direction: 1 | -1): void => {
    if (target === null) return
    const next = Math.min(target.max, Math.max(target.min, target.value + direction * target.step))
    if (next !== target.value) actions.onTarget(Number(next.toFixed(2)))
  }
  const centre =
    model.flow !== null ? (
      <>
        <span className="text-xl font-semibold tabular-nums">{degrees(model.flow, 0)}</span>
        <span className="text-xs text-foreground-muted">
          {t('uiLibrary.deviceCard.climate.flow', 'flow')}
        </span>
      </>
    ) : model.current !== null ? (
      <span className="text-xl font-semibold tabular-nums">{degrees(model.current, 1)}</span>
    ) : valveOnly ? (
      <>
        <span className="text-xl font-semibold tabular-nums" data-testid="dc-climate-valve">
          {valveText}
        </span>
        <span className="text-xs lowercase text-foreground-muted">
          {t('uiLibrary.deviceCard.climate.valve', 'Valve')}
        </span>
      </>
    ) : (
      <CardIcon
        glyph={model.mode?.options.find((o) => o.id === model.mode?.value)?.glyph ?? 'power'}
        className="h-8 w-8"
      />
    )
  const inside = (
    <>
      <div className={cn('flex flex-col items-center', !model.on && 'text-foreground-muted')}>
        {centre}
        {model.humidity === null ? null : (
          <span
            className="inline-flex items-center gap-0.5 text-xs text-foreground-muted"
            data-testid="dc-climate-humidity"
          >
            <CardIcon glyph="humidity" className="h-3 w-3 text-info" />
            {Math.round(model.humidity)}%
          </span>
        )}
      </div>
      <ClimateRoleGlyph role={model.role} className={cn('absolute bottom-1', TEXT[tone])} />
    </>
  )
  const image = (
    <div className="relative" data-testid="dc-climate-dial">
      {range !== null && band !== null ? (
        <RangeDial
          low={band.low}
          high={band.high}
          min={range.min}
          max={range.max}
          step={range.step}
          tone={bandTone}
          enabled={model.on && range.editable}
          lowLabel={t('uiLibrary.deviceCard.climate.rangeLow', 'Heat below')}
          highLabel={t('uiLibrary.deviceCard.climate.rangeHigh', 'Cool above')}
          onInput={setBandDraft}
          onCommit={commitBand}
          testId="dc-range-dial"
        >
          {inside}
        </RangeDial>
      ) : target === null || shown === null ? (
        <div className="relative flex h-26 w-26 flex-col items-center justify-center">{inside}</div>
      ) : (
        <Dial
          value={shown}
          min={target.min}
          max={target.max}
          step={target.step}
          tone={dialTone}
          enabled={model.on}
          ariaLabel={t('uiLibrary.deviceCard.climate.target', 'Target temperature')}
          onInput={setDraft}
          onCommit={commit}
          testId="dc-dial"
        >
          {inside}
        </Dial>
      )}
      {activity === 'window' ? (
        <span className="pointer-events-none absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-xs font-semibold text-warning">
          {t('uiLibrary.deviceCard.climate.resumes', 'Resumes when it closes')}
        </span>
      ) : null}
    </div>
  )
  const left =
    range !== null && band !== null ? (
      <span
        className="flex flex-col items-center text-center leading-tight"
        data-testid="dc-climate-range"
      >
        <b
          className={cn(
            'whitespace-nowrap text-sm tabular-nums',
            model.on ? 'text-primary' : 'text-foreground-muted',
          )}
        >
          {bare(band.low)}–{bare(band.high)}°
        </b>
        <small className="text-xs lowercase text-foreground-muted">
          {t('uiLibrary.deviceCard.climate.rangeShort', 'range')}
        </small>
      </span>
    ) : target === null || shown === null ? null : (
      <>
        <CardButton
          glyph="plus"
          aria-label={t('uiLibrary.deviceCard.climate.raise', 'Raise the target')}
          disabled={!model.on || target.value >= target.max}
          onClick={() => stepBy(1)}
        />
        <span className="flex flex-col items-center leading-tight" data-testid="dc-climate-target">
          <b
            className={cn(
              'text-sm tabular-nums',
              model.on ? 'text-primary' : 'text-foreground-muted',
            )}
          >
            {degrees(shown, 1)}
          </b>
          <small className="text-xs lowercase text-foreground-muted">
            {target.label ?? t('uiLibrary.deviceCard.climate.targetShort', 'target')}
          </small>
        </span>
        <CardButton
          glyph="minus"
          aria-label={t('uiLibrary.deviceCard.climate.lower', 'Lower the target')}
          disabled={!model.on || target.value <= target.min}
          onClick={() => stepBy(-1)}
        />
      </>
    )
  const right = (
    <>
      {model.canPower ? (
        <CardButton
          glyph="power"
          tone={model.on ? 'primary' : 'default'}
          data-testid="dc-climate-power"
          onClick={() => actions.onPower(!model.on)}
        >
          {model.on
            ? t('uiLibrary.deviceCard.turnOff', 'Turn off')
            : t('uiLibrary.deviceCard.turnOn', 'Turn on')}
        </CardButton>
      ) : null}
      {model.mode === null ? null : (
        <MenuButton
          options={model.mode.options}
          value={model.mode.value}
          onChange={actions.onMode}
          disabled={!model.on}
          ariaLabel={t('uiLibrary.deviceCard.climate.mode', 'Mode')}
          testId="dc-climate-mode"
        />
      )}
      {model.fan === null ? null : (
        <CardButton
          glyph="fan"
          disabled={!model.on}
          aria-label={t('uiLibrary.deviceCard.climate.fan', 'Fan')}
          data-testid="dc-climate-fan"
          onClick={() => {
            const next = model.fan === null ? null : nextChoice(model.fan)
            if (next !== null) actions.onFan(next)
          }}
        >
          {model.fan.options.find((o) => o.id === model.fan?.value)?.label ?? model.fan.value}
        </CardButton>
      )}
    </>
  )
  const valveChip = valve !== null && !valveOnly
  const hasBottom =
    model.preset !== null ||
    model.heatCool !== null ||
    model.swing !== null ||
    model.swingHorizontal !== null ||
    valveChip
  const bottom = hasBottom ? (
    <>
      {model.preset === null ? null : (
        <ButtonGroup
          options={model.preset.options}
          value={model.preset.value}
          onChange={actions.onPreset}
          disabled={!model.on}
          ariaLabel={t('uiLibrary.deviceCard.climate.preset', 'Preset')}
          testId="dc-climate-preset"
        />
      )}
      {model.heatCool === null ? null : (
        <ButtonGroup
          options={model.heatCool.options}
          value={model.heatCool.value}
          onChange={actions.onHeatCool}
          disabled={!model.on}
          ariaLabel={t('uiLibrary.deviceCard.climate.heatCool', 'Heating or cooling')}
          testId="dc-climate-heatcool"
        />
      )}
      {model.swing === null ? null : (
        <CardButton
          glyph="swing"
          tone={model.swing ? 'on' : 'default'}
          aria-pressed={model.swing}
          disabled={!model.on}
          data-testid="dc-climate-swing"
          onClick={() => actions.onSwing(model.swing !== true)}
        >
          {t('uiLibrary.deviceCard.climate.swing', 'Swing')}
        </CardButton>
      )}
      {model.swingHorizontal === null ? null : (
        <CardButton
          glyph="swingHorizontal"
          tone={model.swingHorizontal ? 'on' : 'default'}
          aria-pressed={model.swingHorizontal}
          disabled={!model.on}
          data-testid="dc-climate-swing-horizontal"
          onClick={() => actions.onSwingHorizontal(model.swingHorizontal !== true)}
        >
          {t('uiLibrary.deviceCard.climate.swingHorizontal', 'Side swing')}
        </CardButton>
      )}
      {valveChip ? (
        <ValueChip>
          <span data-testid="dc-climate-valve">
            {t('uiLibrary.deviceCard.climate.valve', 'Valve')} {valveText}
          </span>
        </ValueChip>
      ) : null}
    </>
  ) : null
  return (
    <DeviceCard
      kind="climate"
      common={model.common}
      actions={actions}
      orientation={orientation}
      activity={activity}
      state={{ label: words[activity], since: model.since, tone }}
      scene={{
        // A valve that only reports has no appliance drawn for an animation to rise from.
        fx: valveOnly ? null : (
          <AmbientFx role={model.role} activity={activity} swing={model.swing === true} />
        ),
        left,
        image,
        right,
        bottom,
      }}
    />
  )
}
