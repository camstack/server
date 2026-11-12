import type { ApplianceKind } from '../../illustrations/ApplianceIllustration'
import type { CardCommon, CardCommonActions } from '../../shell/model'

/**
 * Where the cycle is. `done` = it ran and stopped while the machine stays
 * powered; `off` = the switch feeding it is off; `unknown` = nothing reported
 * (never drawn as idle, D393).
 */
export type AppliancePhase = 'idle' | 'run' | 'pause' | 'done' | 'off' | 'error' | 'unknown'

export interface ApplianceProgram {
  readonly id: string
  readonly label: string
  /** How long the program takes, when the device says. */
  readonly minutes: number | null
}

/** The machine's own programs, when it declares them (a connected appliance). */
export interface ApplianceProgramModel {
  readonly options: readonly ApplianceProgram[]
  readonly selected: string | null
  /** The device binds a program setter. */
  readonly selectable: boolean
}

/** What the cycle controls the device binds. */
export interface ApplianceControls {
  readonly start: boolean
  readonly pause: boolean
  readonly resume: boolean
  readonly stop: boolean
}

export interface ApplianceCardModel {
  readonly common: CardCommon
  readonly kind: ApplianceKind
  readonly phase: AppliancePhase
  /** The device's own word for the step it is in ("Rinse"); null uses the kind's word. */
  readonly phaseLabel: string | null
  readonly since: string | null
  /** A plug-built appliance: the switch that powers it. Null when it binds none. */
  readonly power: { readonly on: boolean } | null
  readonly program: ApplianceProgramModel | null
  readonly controls: ApplianceControls | null
  readonly remainingMinutes: number | null
  /** The wall-clock end of the cycle ("11:58"), already formatted. */
  readonly endsAt: string | null
  /** 0..100 of the cycle done. */
  readonly progress: number | null
  /** Why the machine refuses a remote start (remote start off, door open); null when it may. */
  readonly startBlocked: string | null
  readonly errorLabel: string | null
}

export interface ApplianceCardActions extends CardCommonActions {
  readonly onPower: (on: boolean) => void
  readonly onProgram: (id: string) => void
  readonly onStart: () => void
  readonly onPause: () => void
  readonly onResume: () => void
  readonly onStop: () => void
}

/** "2 h 35" / "38 min". */
export function formatCycleMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`
}
