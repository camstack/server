import type { CcuProgram } from '../ccu/ccu-schemas.js'

/**
 * A button only emits its presses to an outside listener while a CCU program
 * references its key (the "dummy program"). `ok`: an active program
 * references it; `inactive`: only disabled programs do; `missing`: none does;
 * `unknown`: the CCU could not be asked, which is never "none" (D315).
 */
export type KeyEventState = 'ok' | 'inactive' | 'missing' | 'unknown'

/** The one badge label per state, shared by the table column and the detail. */
export const EVENTS_LABEL: Readonly<
  Record<
    KeyEventState,
    | 'devices.eventsOk'
    | 'devices.eventsInactive'
    | 'devices.eventsMissing'
    | 'devices.eventsUnknown'
  >
> = {
  ok: 'devices.eventsOk',
  inactive: 'devices.eventsInactive',
  missing: 'devices.eventsMissing',
  unknown: 'devices.eventsUnknown',
}

export interface KeyEventStatus {
  readonly address: string
  readonly state: KeyEventState
  /** Names of the programs that reference the key, active ones first. */
  readonly programs: readonly string[]
}

/** Per key channel: which programs reference it. A pure function of the programs list. */
export function keyEventStatuses(
  keyAddresses: readonly string[],
  programs: readonly Pick<CcuProgram, 'name' | 'active' | 'channels'>[],
  referencesUnreadable = false,
): readonly KeyEventStatus[] {
  return keyAddresses.map((address) => {
    if (referencesUnreadable) return { address, state: 'unknown', programs: [] }
    const referencing = programs.filter((program) =>
      program.channels.some((channel) => channel.address === address),
    )
    const active = referencing.filter((program) => program.active)
    const inactive = referencing.filter((program) => !program.active)
    return {
      address,
      state: active.length > 0 ? 'ok' : inactive.length > 0 ? 'inactive' : 'missing',
      programs: [...active, ...inactive].map((program) => program.name),
    }
  })
}

/** One badge state for a device: the worst of its keys; `null` for a device without keys. */
export function deviceKeyEventState(statuses: readonly KeyEventStatus[]): KeyEventState | null {
  if (statuses.length === 0) return null
  if (statuses.some((status) => status.state === 'unknown')) return 'unknown'
  if (statuses.some((status) => status.state === 'missing')) return 'missing'
  if (statuses.some((status) => status.state === 'inactive')) return 'inactive'
  return 'ok'
}
