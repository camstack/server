import { type ReactElement, useState } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { formatCountdown } from '../../../device-controls/timed-run-control'
import { PlugIllustration } from '../../illustrations/PlugIllustration'
import { CardButton } from '../../parts/CardButton'
import { useCountdown } from '../../parts/use-countdown'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import {
  type PlugCardActions,
  type PlugCardModel,
  PLUG_TIMER_MIN_MINUTES,
  type PlugTimer,
  splitPlugDuration,
  stepPlugTimer,
} from './model'

export interface PlugCardProps {
  readonly model: PlugCardModel
  readonly actions: PlugCardActions
  readonly orientation?: CardOrientation
  /** Draw the device name (default true); false when the host already names the device. */
  readonly showName?: boolean
}

interface TimerProps {
  readonly timer: PlugTimer
  readonly actions: PlugCardActions
}

function TimerControl({ timer, actions }: TimerProps): ReactElement {
  const t = useUiText()
  const [minutes, setMinutes] = useState(timer.defaultMinutes)
  const remaining = useCountdown(timer.endsAt)
  if (remaining !== null) {
    return (
      <CardButton
        tone="on"
        glyph="stop"
        className="min-w-36 tabular-nums"
        aria-label={t('uiLibrary.deviceCard.plug.stopAria', 'Stop the timed run and turn off')}
        data-testid="dc-plug-timer-stop"
        onClick={actions.onTimerStop}
      >
        {t('uiLibrary.deviceCard.plug.stop', 'Stop')} · {formatCountdown(remaining)}
      </CardButton>
    )
  }
  const d = splitPlugDuration(minutes)
  const duration =
    d.hours === 0
      ? t('uiLibrary.deviceCard.plug.minutes', '{{m}} min', { m: d.minutes })
      : t('uiLibrary.deviceCard.plug.hoursMinutes', '{{h}} h {{m}}′', {
          h: d.hours,
          m: d.minutes,
        })
  return (
    <div className="flex items-center gap-2" data-testid="dc-plug-timer">
      <CardButton
        glyph="minus"
        aria-label={t('uiLibrary.deviceCard.plug.less', 'Shorter')}
        disabled={minutes <= PLUG_TIMER_MIN_MINUTES}
        onClick={() => setMinutes((m) => stepPlugTimer(m, -1, timer.maxMinutes))}
      />
      <CardButton
        glyph="timer"
        className="min-w-36"
        aria-label={t('uiLibrary.deviceCard.plug.startAria', 'Turn on for {{duration}}, then off', {
          duration,
        })}
        data-testid="dc-plug-timer-start"
        onClick={() => actions.onTimerStart(minutes)}
      >
        {t('uiLibrary.deviceCard.plug.start', 'Run {{duration}}', { duration })}
      </CardButton>
      <CardButton
        glyph="plus"
        aria-label={t('uiLibrary.deviceCard.plug.more', 'Longer')}
        disabled={minutes >= timer.maxMinutes}
        onClick={() => setMinutes((m) => stepPlugTimer(m, 1, timer.maxMinutes))}
      />
    </div>
  )
}

/** The plug: on / off, the switch's timed run, and what the shell shows for any device. */
export function PlugCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: PlugCardProps): ReactElement {
  const t = useUiText()
  const on = model.on === true
  const label =
    model.on === null
      ? t('uiLibrary.deviceCard.unknown', 'Unknown')
      : on
        ? t('uiLibrary.deviceCard.plug.on', 'On')
        : t('uiLibrary.deviceCard.plug.off', 'Off')
  return (
    <DeviceCard
      kind="plug"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={on ? 'on' : 'off'}
      state={{ label, since: model.since, tone: on ? 'primary' : 'muted' }}
      scene={{
        image: (
          <PlugIllustration
            on={on}
            className={orientation === 'vertical' ? 'h-24 w-24' : 'h-27.5 w-27.5'}
          />
        ),
        right: (
          <CardButton
            glyph="power"
            tone={on ? 'primary' : 'default'}
            data-testid="dc-plug-power"
            onClick={() => actions.onPower(!on)}
          >
            {on
              ? t('uiLibrary.deviceCard.turnOff', 'Turn off')
              : t('uiLibrary.deviceCard.turnOn', 'Turn on')}
          </CardButton>
        ),
        bottom:
          model.timer === null ? null : <TimerControl timer={model.timer} actions={actions} />,
      }}
    />
  )
}
