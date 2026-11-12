import type { ReactElement, ReactNode } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { ApplianceIllustration } from '../../illustrations/ApplianceIllustration'
import { ArmedButton } from '../../parts/ArmedButton'
import { CardButton } from '../../parts/CardButton'
import { StepColumn } from '../../parts/StepColumn'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation, CardTone } from '../../shell/model'
import {
  type ApplianceCardActions,
  type ApplianceCardModel,
  type AppliancePhase,
  formatCycleMinutes,
} from './model'

export interface ApplianceCardProps {
  readonly model: ApplianceCardModel
  readonly actions: ApplianceCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

const TONE: Readonly<Record<AppliancePhase, CardTone>> = {
  idle: 'muted',
  run: 'primary',
  pause: 'warning',
  done: 'success',
  off: 'muted',
  error: 'danger',
  unknown: 'muted',
}

function runWord(model: ApplianceCardModel, t: UiTextFn): string {
  if (model.phaseLabel !== null) return model.phaseLabel
  return model.kind === 'dryer'
    ? t('uiLibrary.deviceCard.appliance.drying', 'Drying')
    : t('uiLibrary.deviceCard.appliance.washing', 'Washing')
}

export function appliancePhaseLabel(model: ApplianceCardModel, t: UiTextFn): string {
  switch (model.phase) {
    case 'run':
      return runWord(model, t)
    case 'pause':
      return t('uiLibrary.deviceCard.appliance.paused', 'Paused')
    case 'done':
      return t('uiLibrary.deviceCard.appliance.done', 'Finished')
    case 'off':
      return t('uiLibrary.deviceCard.appliance.off', 'Off')
    case 'idle':
      return t('uiLibrary.deviceCard.appliance.idle', 'Stopped')
    case 'error':
      return model.errorLabel ?? t('uiLibrary.deviceCard.appliance.error', 'Error')
    case 'unknown':
      return t('uiLibrary.deviceCard.unknown', 'Unknown')
  }
}

function programColumn({ model, actions }: ApplianceCardProps, t: UiTextFn): ReactNode {
  const program = model.program
  if (program === null || program.options.length === 0) return null
  const index = program.options.findIndex((p) => p.id === program.selected)
  const current = index < 0 ? null : (program.options[index] ?? null)
  const idle = model.phase === 'idle' || model.phase === 'done'
  const canStep = program.selectable && idle
  const step = (delta: number) => (): void => {
    const next = program.options[Math.max(0, index + delta)]
    if (next !== undefined && next.id !== program.selected) actions.onProgram(next.id)
  }
  const notes: ReactNode[] = idle
    ? current?.minutes == null
      ? []
      : [formatCycleMinutes(current.minutes)]
    : [
        ...(model.remainingMinutes === null
          ? []
          : [
              t('uiLibrary.deviceCard.appliance.remaining', '{{duration}} left', {
                duration: formatCycleMinutes(model.remainingMinutes),
              }),
            ]),
        ...(model.phase === 'pause'
          ? [t('uiLibrary.deviceCard.appliance.pausedNote', 'paused')]
          : model.endsAt === null
            ? []
            : [
                t('uiLibrary.deviceCard.appliance.endsAt', 'ends {{time}}', { time: model.endsAt }),
              ]),
      ]
  return (
    <StepColumn
      testId="dc-appliance-program"
      value={current?.label ?? program.selected}
      notes={notes}
      up={{
        glyph: 'up',
        label: t('uiLibrary.deviceCard.appliance.prevProgram', 'Previous program'),
        disabled: !canStep || index <= 0,
        ...(program.selectable ? { onPress: step(-1) } : {}),
      }}
      down={{
        glyph: 'down',
        label: t('uiLibrary.deviceCard.appliance.nextProgram', 'Next program'),
        disabled: !canStep || index < 0 || index >= program.options.length - 1,
        ...(program.selectable ? { onPress: step(1) } : {}),
      }}
    />
  )
}

function powerButton({ model, actions }: ApplianceCardProps, t: UiTextFn): ReactNode {
  if (model.power === null) return null
  if (!model.power.on) {
    return (
      <CardButton
        glyph="power"
        data-testid="dc-appliance-power"
        onClick={() => actions.onPower(true)}
      >
        {t('uiLibrary.deviceCard.turnOn', 'Turn on')}
      </CardButton>
    )
  }
  const label = t('uiLibrary.deviceCard.turnOff', 'Turn off')
  // Cutting the power ends a cycle, running or paused: it asks first.
  if (model.phase === 'run' || model.phase === 'pause') {
    return (
      <ArmedButton
        glyph="power"
        tone="primary"
        testId="dc-appliance-power"
        armedLabel={t('uiLibrary.deviceCard.appliance.confirmInterrupt', 'Confirm: interrupts')}
        onConfirm={() => actions.onPower(false)}
      >
        {label}
      </ArmedButton>
    )
  }
  return (
    <CardButton
      glyph="power"
      tone="primary"
      data-testid="dc-appliance-power"
      onClick={() => actions.onPower(false)}
    >
      {label}
    </CardButton>
  )
}

function cycleButtons({ model, actions }: ApplianceCardProps, t: UiTextFn): ReactNode {
  const c = model.controls
  if (c === null || (model.phase !== 'run' && model.phase !== 'pause')) return null
  return (
    <>
      {model.phase === 'run' && c.pause ? (
        <CardButton glyph="pause" data-testid="dc-appliance-pause" onClick={actions.onPause}>
          {t('uiLibrary.deviceCard.pause', 'Pause')}
        </CardButton>
      ) : null}
      {c.stop ? (
        <ArmedButton
          glyph="stop"
          testId="dc-appliance-stop"
          armedLabel={t('uiLibrary.deviceCard.appliance.confirmStop', 'Confirm: stop')}
          onConfirm={actions.onStop}
        >
          {t('uiLibrary.deviceCard.stop', 'Stop')}
        </ArmedButton>
      ) : null}
    </>
  )
}

function startBox({ model, actions }: ApplianceCardProps, t: UiTextFn): ReactNode {
  const c = model.controls
  if (c === null || model.phase === 'run') return null
  const resuming = model.phase === 'pause'
  if (resuming ? !c.resume : !c.start) return null
  const program = model.program?.options.find((p) => p.id === model.program?.selected) ?? null
  return (
    <div className="flex flex-col items-center gap-1">
      <CardButton
        glyph="play"
        tone="primary"
        data-testid="dc-appliance-start"
        disabled={model.startBlocked !== null}
        onClick={resuming ? actions.onResume : actions.onStart}
      >
        {resuming
          ? t('uiLibrary.deviceCard.resume', 'Resume')
          : program === null
            ? t('uiLibrary.deviceCard.start', 'Start')
            : t('uiLibrary.deviceCard.appliance.startProgram', 'Start {{program}}', {
                program: program.label,
              })}
      </CardButton>
      {model.startBlocked === null ? null : (
        <small className="text-center text-xs text-danger" data-testid="dc-appliance-why">
          {model.startBlocked}
        </small>
      )}
    </div>
  )
}

/**
 * A washer, a dryer or a dishwasher. Built on a plug it only knows whether a
 * cycle runs (from the draw) and powers the plug, arming before it cuts a
 * running cycle. Connected, it steps through the machine's programs, shows the
 * time left and its end, and starts, pauses and stops the cycle — the start
 * refused, with the machine's reason, when it does not allow a remote start.
 */
export function ApplianceCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: ApplianceCardProps): ReactElement {
  const t = useUiText()
  const label = appliancePhaseLabel(model, t)
  const cycle = model.phase === 'run' || model.phase === 'pause'
  const props = { model, actions }
  const right = (
    <>
      {powerButton(props, t)}
      {cycleButtons(props, t)}
    </>
  )
  const hasRight = model.power !== null || (model.controls !== null && cycle)
  return (
    <DeviceCard
      kind="appliance"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.phase}
      state={{ label, since: model.since, tone: TONE[model.phase] }}
      scene={{
        left: programColumn(props, t),
        image: (
          <ApplianceIllustration
            kind={model.kind}
            running={model.phase === 'run'}
            lit={cycle}
            progress={model.program === null || !cycle ? null : (model.progress ?? 0)}
            label={label}
          />
        ),
        right: hasRight ? right : null,
        bottom: startBox(props, t),
      }}
    />
  )
}
