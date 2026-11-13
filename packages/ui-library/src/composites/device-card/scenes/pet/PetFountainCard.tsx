import type { ReactElement, ReactNode } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { PetFountainIllustration } from '../../illustrations/PetFountainIllustration'
import { CardButton } from '../../parts/CardButton'
import { LevelRow } from '../../parts/LevelRow'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation, CardTone } from '../../shell/model'
import {
  FOUNTAIN_LOW_PERCENT,
  fountainMillilitres,
  type PetFountainActivity,
  type PetFountainCardActions,
  type PetFountainCardModel,
  type PetFountainCycle,
} from './model'

/** A cycle longer than this is not offered; matches the previous stepper. */
const MAX_PUMP_MINUTES = 240

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

function pumpButtons(
  model: PetFountainCardModel,
  actions: PetFountainCardActions,
  t: UiTextFn,
): ReactNode {
  if (!model.pumpSwitchable) return null
  const on = t('uiLibrary.deviceCard.turnOn', 'Turn on')
  const off = t('uiLibrary.deviceCard.turnOff', 'Turn off')
  if (model.pump === null) {
    return (
      <>
        <CardButton
          glyph="power"
          data-testid="dc-fountain-pump-on"
          onClick={() => actions.onPump(true)}
        >
          {on}
        </CardButton>
        <CardButton
          glyph="power"
          data-testid="dc-fountain-pump-off"
          onClick={() => actions.onPump(false)}
        >
          {off}
        </CardButton>
      </>
    )
  }
  return (
    <CardButton
      glyph="power"
      tone={model.pump ? 'primary' : 'default'}
      data-testid="dc-fountain-pump"
      onClick={() => actions.onPump(model.pump !== true)}
    >
      {model.pump ? off : on}
    </CardButton>
  )
}

function minuteRow(
  testId: string,
  label: string,
  minutes: number | null,
  onChange: (minutes: number) => void,
  t: UiTextFn,
): ReactElement {
  const current = minutes ?? 0
  const step = (delta: number): void => {
    if (minutes === null) return
    onChange(Math.min(MAX_PUMP_MINUTES, Math.max(0, current + delta)))
  }
  return (
    <span data-testid={testId} className="inline-flex items-center justify-center gap-1 text-xs">
      <span>{label}</span>
      <CardButton
        glyph="minus"
        aria-label={t('uiLibrary.petFountain.decrease', 'Decrease {{label}}', { label })}
        disabled={minutes === null || current <= 0}
        onClick={() => step(-1)}
      />
      <b className="tabular-nums">
        {minutes === null
          ? '—'
          : t('uiLibrary.petFountain.minutes', '{{count}} min', { count: current })}
      </b>
      <CardButton
        glyph="plus"
        aria-label={t('uiLibrary.petFountain.increase', 'Increase {{label}}', { label })}
        disabled={minutes === null || current >= MAX_PUMP_MINUTES}
        onClick={() => step(1)}
      />
    </span>
  )
}

function cycleControls(
  cycle: PetFountainCycle,
  actions: PetFountainCardActions,
  t: UiTextFn,
): ReactElement {
  const on = cycle.enabled === true
  return (
    <div className="grid justify-items-center gap-1">
      <CardButton
        glyph="timer"
        tone={on ? 'on' : 'default'}
        aria-pressed={on}
        data-testid="dc-fountain-cycle"
        onClick={() => actions.onCycle(!on)}
      >
        {t('uiLibrary.petFountain.cycle', 'On / off cycle')}
      </CardButton>
      {on ? (
        <>
          {minuteRow(
            'dc-fountain-run',
            t('uiLibrary.petFountain.runMinutes', 'Runs for'),
            cycle.runMinutes,
            actions.onRunMinutes,
            t,
          )}
          {minuteRow(
            'dc-fountain-rest',
            t('uiLibrary.petFountain.restMinutes', 'Rests for'),
            cycle.restMinutes,
            actions.onRestMinutes,
            t,
          )}
        </>
      ) : null}
    </div>
  )
}

/**
 * A drinking fountain: the basin filled to the tank's level with a jet while
 * the pump runs, the pump switch on the right, the water level and — when the
 * device reports them — the volume and the on/off cycle under it.
 */
export function PetFountainCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: PetFountainCardProps): ReactElement {
  const t = useUiText()
  const volume = fountainMillilitres(model.waterVolume)
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
        right: pumpButtons(model, actions, t),
        bottom: (
          <div className="grid w-full justify-items-center gap-1.5">
            <LevelRow
              testId="dc-fountain-level"
              label={t('uiLibrary.deviceCard.petFountain.water', 'Water')}
              percent={model.waterLevel}
              warn={low}
            />
            {volume === null ? null : (
              <p
                data-testid="dc-fountain-volume"
                className="text-xs tabular-nums text-foreground-muted"
              >
                {volume}
              </p>
            )}
            {model.cycle === null ? null : cycleControls(model.cycle, actions, t)}
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
