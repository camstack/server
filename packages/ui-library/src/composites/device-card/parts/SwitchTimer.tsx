import type { ReactElement } from 'react'
import { useUiText } from '../../../contexts/ui-text'
import { formatCountdown } from '../../device-controls/timed-run-control'
import { TimedRunQuick } from '../../device-controls/timed-run-quick'
import { useCardGating } from '../shell/gating'
import type { SwitchTimerActions, SwitchTimerModel } from './switch-timer-model'
import { useCountdown } from './use-countdown'

export interface SwitchTimerProps {
  readonly timer: SwitchTimerModel
  readonly actions: SwitchTimerActions
}

/**
 * The switch's timed run — the one compact control every card shares with the device rows:
 * "⏱ 25 min ▶" until it runs, then "■ 12 min left". The number is editable and saved per device.
 */
export function SwitchTimer({ timer, actions }: SwitchTimerProps): ReactElement {
  const gating = useCardGating()
  return (
    <TimedRunQuick
      unit="min"
      saved={timer.defaultMinutes}
      max={timer.maxMinutes}
      activeUntil={timer.endsAt}
      save={actions.onTimerSave}
      run={actions.onTimerStart}
      stop={actions.onTimerStop}
      disabled={gating.blocked}
      disabledReason={gating.reason ?? undefined}
      testIdPrefix="dc-plug-timer"
    />
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
