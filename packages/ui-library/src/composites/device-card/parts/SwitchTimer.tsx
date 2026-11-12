import { type ReactElement, useState } from 'react'
import { useUiText } from '../../../contexts/ui-text'
import { formatCountdown } from '../../device-controls/timed-run-control'
import { CardButton } from './CardButton'
import {
  splitSwitchTimerDuration,
  stepSwitchTimer,
  SWITCH_TIMER_MIN_MINUTES,
  type SwitchTimerActions,
  type SwitchTimerModel,
} from './switch-timer-model'
import { useCountdown } from './use-countdown'

export interface SwitchTimerProps {
  readonly timer: SwitchTimerModel
  readonly actions: SwitchTimerActions
}

/**
 * The switch's timed run — ONE control for every card whose power is a switch:
 * "- Run 25 min +" until it runs, then "Stop · mm:ss".
 */
export function SwitchTimer({ timer, actions }: SwitchTimerProps): ReactElement {
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
  const d = splitSwitchTimerDuration(minutes)
  const duration =
    d.hours === 0
      ? t('uiLibrary.deviceCard.plug.minutes', '{{m}} min', { m: d.minutes })
      : d.minutes === 0
        ? t('uiLibrary.deviceCard.plug.hours', '{{h}} h', { h: d.hours })
        : t('uiLibrary.deviceCard.plug.hoursMinutes', '{{h}} h {{m}}′', {
            h: d.hours,
            m: d.minutes,
          })
  return (
    <div className="flex items-center gap-2" data-testid="dc-plug-timer">
      <CardButton
        glyph="minus"
        aria-label={t('uiLibrary.deviceCard.plug.less', 'Shorter')}
        disabled={minutes <= SWITCH_TIMER_MIN_MINUTES}
        onClick={() => setMinutes((m) => stepSwitchTimer(m, -1, timer.maxMinutes))}
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
        onClick={() => setMinutes((m) => stepSwitchTimer(m, 1, timer.maxMinutes))}
      />
    </div>
  )
}

/**
 * The state corner's "since" while a timed run is counting down ("off in
 * 24:59"); otherwise the given one. The fan and the heater say when they stop.
 */
export function useTimerSince(timer: SwitchTimerModel | null, since: string | null): string | null {
  const t = useUiText()
  const remaining = useCountdown(timer?.endsAt ?? null)
  if (remaining === null || remaining <= 0) return since
  return t('uiLibrary.deviceCard.offIn', 'off in {{time}}', { time: formatCountdown(remaining) })
}
