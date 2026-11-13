import type { AlarmArmMode, AlarmPanelStatus, AlarmState } from '@camstack/types'
import type { AlarmActivity } from '../scenes/alarm/model'

export interface AlarmReading {
  readonly activity: AlarmActivity
  readonly mode: AlarmArmMode | null
}

const ARMED: Readonly<Partial<Record<AlarmState, AlarmArmMode>>> = {
  armed_home: 'home',
  armed_away: 'away',
  armed_night: 'night',
  armed_vacation: 'vacation',
  armed_custom_bypass: 'custom_bypass',
}

/** The card's activity and armed mode; arming shows the mode it is heading for. */
export function alarmReadingOf(
  status: Pick<AlarmPanelStatus, 'state' | 'targetMode'>,
): AlarmReading {
  const armedMode = ARMED[status.state]
  if (armedMode !== undefined) return { activity: 'armed', mode: armedMode }
  switch (status.state) {
    case 'disarmed':
      return { activity: 'disarmed', mode: null }
    case 'arming':
    case 'pending':
    case 'triggered':
      return { activity: status.state, mode: status.targetMode ?? null }
    default:
      return { activity: 'disarming', mode: null }
  }
}

/** The optimistic state for an arm command. */
export function alarmArmingPatch(
  mode: AlarmArmMode,
): Pick<AlarmPanelStatus, 'state' | 'targetMode'> {
  return { state: 'arming', targetMode: mode }
}
