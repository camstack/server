import { isAlarmControllableCap, type NcAlarmSensorState } from '@camstack/types'
import { classifyCoveredOpening, type NcAlarmOpening } from './alarm-openings.js'

/**
 * One id's state as the table shows it — spec §3.4's hub table, nothing else.
 *
 * Built ON `classifyCoveredOpening`, the arm check's classifier: what is
 * unknown, open or skipped is decided there, and this only splits a skip into
 * `closed` / `not-opening` for the table. A later change to the classifier
 * therefore moves the table with the arm.
 */
export function alarmSensorStateOf(
  deviceId: number,
  opening: NcAlarmOpening | undefined,
  online: boolean | null,
): NcAlarmSensorState {
  const controllable = opening?.kind === 'reading' ? isAlarmControllableCap(opening.cap) : false
  const verdict = classifyCoveredOpening(opening)
  switch (verdict.kind) {
    // `undefined` is a read that THREW for this id — unknown, never closed (D49).
    case 'unknown':
      return {
        deviceId,
        reading: 'unknown',
        state: null,
        unknownWhy: verdict.why,
        online,
        controllable,
      }
    case 'open':
      return {
        deviceId,
        reading: 'open',
        state: verdict.state,
        unknownWhy: null,
        online,
        controllable: verdict.controllable,
      }
    case 'skip':
      return opening?.kind === 'reading'
        ? {
            deviceId,
            reading: 'closed',
            state: opening.state,
            unknownWhy: null,
            online,
            controllable,
          }
        : {
            deviceId,
            reading: 'not-opening',
            state: null,
            unknownWhy: null,
            online,
            controllable: false,
          }
  }
}

/** The asked ids, de-duplicated and ascending. */
export function alarmSensorReadIds(ids: readonly number[]): readonly number[] {
  return [...new Set(ids)].toSorted((a, b) => a - b)
}

export interface NcAlarmSensorsReadLogLine {
  readonly level: 'warn' | 'info'
  readonly message: string
  readonly meta: Readonly<Record<string, string | number>>
}

/**
 * The sensors read's health, logged on CHANGE only (the call is polled every
 * 5-15 s by every open tab). "Wholesale failure" = ids were asked and not one
 * was answered (the device manager is unreachable): WARN once when it starts,
 * ONE INFO when answers return. A partial answer is not a health change — those
 * ids already leave their own debug line and show as `unknown`.
 */
export class NcAlarmSensorsReadLog {
  private failing = false

  next(asked: number, answered: number): NcAlarmSensorsReadLogLine | null {
    const wholesale = asked > 0 && answered === 0
    if (wholesale === this.failing) return null
    this.failing = wholesale
    return wholesale
      ? {
          level: 'warn',
          message: 'alarm sensors read: no asked device answered — every row is unknown',
          meta: { asked },
        }
      : {
          level: 'info',
          message: 'alarm sensors read: devices answer again',
          meta: { asked, answered },
        }
  }
}
