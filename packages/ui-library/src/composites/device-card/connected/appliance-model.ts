/**
 * Pure mapping from the caps a washer, a dryer or a dishwasher binds to the
 * appliance scene's model — kept out of the components so each rule is
 * tested on its own.
 */
import { DeviceType, type DishwasherStatus } from '@camstack/types'
import type { UiTextFn } from '../../../contexts/ui-text'
import type { ApplianceKind } from '../illustrations/ApplianceIllustration'
import type { AppliancePhase, ApplianceProgramModel } from '../scenes/appliance/model'

export function applianceKindOf(deviceType: string | null): ApplianceKind {
  if (deviceType === DeviceType.Dryer) return 'dryer'
  if (deviceType === DeviceType.Dishwasher) return 'dish'
  return 'washer'
}

/**
 * A plug-built appliance: `running-state` says whether a cycle runs, the
 * `switch` whether the machine is powered at all. Unknown is never idle.
 */
export function plugAppliancePhase(
  running: boolean | null | undefined,
  switchOn: boolean | null | undefined,
): AppliancePhase {
  if (switchOn === false) return 'off'
  if (running === true) return 'run'
  if (running === false) return switchOn === true ? 'done' : 'idle'
  return 'unknown'
}

const DISH_PHASE: Readonly<Record<DishwasherStatus['state'], AppliancePhase>> = {
  idle: 'idle',
  running: 'run',
  paused: 'pause',
  finished: 'done',
  error: 'error',
  unavailable: 'unknown',
}

export function dishwasherPhase(status: DishwasherStatus): AppliancePhase {
  if (status.powerOn === false && status.state === 'idle') return 'off'
  return DISH_PHASE[status.state]
}

export function dishwasherPrograms(
  status: DishwasherStatus,
  selectable: boolean,
): ApplianceProgramModel | null {
  const selected = status.selectedProgram ?? status.program
  const names =
    status.availablePrograms.length > 0
      ? status.availablePrograms
      : selected === null
        ? []
        : [selected]
  if (names.length === 0) return null
  return {
    options: names.map((name) => ({ id: name, label: name, minutes: null })),
    selected,
    selectable: selectable && status.availablePrograms.length > 1,
  }
}

/** Why the machine refuses a remote start, or null when it may start. */
export function dishwasherStartBlocked(status: DishwasherStatus, t: UiTextFn): string | null {
  if (status.doorOpen === true) return t('uiLibrary.deviceCard.appliance.doorOpen', 'Door open')
  if (status.remoteStartAllowed === false)
    return t(
      'uiLibrary.deviceCard.appliance.remoteStartOff',
      'Remote start is not enabled on the machine',
    )
  return null
}

/** The wall-clock end of a cycle with `remainingSec` to go ("11:58"). */
export function cycleEndsAt(remainingSec: number, now: number = Date.now()): string {
  return new Date(now + remainingSec * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}
