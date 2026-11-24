import type { SirenDurationRange, SirenOptions, SirenStatus } from '@camstack/types'
import type { SwitchTimerActions, SwitchTimerModel } from '../../parts/switch-timer-model'
import type { CardCommon, CardCommonActions } from '../../shell/model'

/** `unknown`: neither the siren nor its switch has reported whether it sounds. */
export type SirenActivity = 'sounding' | 'silent' | 'unknown'

/** What a trigger may count: seconds, or the camera's plays. */
export type SirenAmountUnit = 'seconds' | 'plays'

/** The amount one trigger asks for. `null` where it is taken means the camera default. */
export interface SirenAmount {
  readonly unit: SirenAmountUnit
  readonly value: number
}

/** The values the device declares for one unit. None picked: the trigger asks neither and the camera applies its default. */
export interface SirenAmountChoices {
  readonly values: readonly number[]
}

/** What the device declares adjustable; `null` draws no chip for that unit. */
export interface SirenAdjustable {
  readonly durations: SirenAmountChoices | null
  readonly plays: SirenAmountChoices | null
}

/** A siren sounding now, as the server reports it. `endsAt` is null when open-ended or unknown. */
export interface SirenRun {
  readonly endsAt: number | null
  /** The whole run in ms; null when neither a duration nor a trigger time was reported. */
  readonly totalMs: number | null
  /** The end comes from an estimated seconds-per-play factor. */
  readonly estimated: boolean
}

/**
 * What the ring draws. `timed`: a count (and a fill when the whole run is
 * known). `open`: the siren sounds with no known end — a busy ring, no count.
 */
export type SirenCountdown =
  | {
      readonly kind: 'timed'
      readonly remainingSeconds: number
      /** Share of the run still to sound, 0..1; null when the run's length is unknown. */
      readonly fraction: number | null
      readonly estimated: boolean
    }
  | { readonly kind: 'open' }

export interface SirenCardModel {
  readonly common: CardCommon
  readonly activity: SirenActivity
  readonly since: string | null
  /** The binding can sound it. */
  readonly canTrigger: boolean
  /** The binding can silence it. */
  readonly canStop: boolean
  /** A trigger or stop is in flight: the button waits for the server. */
  readonly commandPending: boolean
  /** The sounding run; null while silent. */
  readonly run: SirenRun | null
  readonly adjustable: SirenAdjustable
  /** The siren's options were asked and failed: the chips are unknown, not absent. */
  readonly optionsUnavailable: boolean
  /** The switch's timed run; null when the device binds none. */
  readonly timer: SwitchTimerModel | null
}

export interface SirenCardActions extends CardCommonActions, SwitchTimerActions {
  readonly onTrigger: (amount: SirenAmount | null) => void
  readonly onStop: () => void
}

const NO_ADJUSTABLE: SirenAdjustable = { durations: null, plays: null }

/** A declared range spelled out by its step (min and max included). */
function rangeValues(range: SirenDurationRange): readonly number[] {
  const count = Math.floor((range.max - range.min) / range.step + 1e-9) + 1
  return Array.from({ length: Math.max(0, count) }, (_, i) =>
    Number((range.min + i * range.step).toFixed(3)),
  )
}

function choicesOf(
  list: readonly number[] | null,
  range: SirenDurationRange | null,
): SirenAmountChoices | null {
  const declared = list ?? (range === null ? [] : rangeValues(range))
  const values = [...new Set(declared)].sort((a, b) => a - b)
  // One value is not a choice: no chip.
  return values.length < 2 ? null : { values }
}

/** The chips the siren's own options declare; nothing until they answered. */
export function sirenAdjustableOf(options: SirenOptions | undefined): SirenAdjustable {
  if (options === undefined) return NO_ADJUSTABLE
  return {
    durations: choicesOf(options.allowedSeconds, options.rangeSeconds),
    plays: choicesOf(options.allowedPlays, options.rangePlays),
  }
}

type SirenRunStatus = Pick<
  SirenStatus,
  'active' | 'activeUntil' | 'durationSeconds' | 'activeUntilEstimated' | 'lastTriggeredAt'
>

/**
 * The run the server reports. With the `siren` slice: its end and its length
 * (the reported duration, else the span from the trigger to the end). Without
 * it (a siren that is only a switch): sounding is open-ended.
 */
export function sirenRunOf(status: SirenRunStatus | undefined, sounding: boolean): SirenRun | null {
  if (!sounding) return null
  if (status === undefined) return { endsAt: null, totalMs: null, estimated: false }
  const endsAt = status.activeUntil
  const reported =
    status.durationSeconds !== null && status.durationSeconds > 0
      ? status.durationSeconds * 1000
      : null
  const span =
    endsAt !== null && status.lastTriggeredAt > 0 && endsAt > status.lastTriggeredAt
      ? endsAt - status.lastTriggeredAt
      : null
  return {
    endsAt,
    totalMs: endsAt === null ? null : (reported ?? span),
    estimated: status.activeUntilEstimated,
  }
}

/** The ring for a run, `remainingMs` being what `useCountdown(run.endsAt)` reads. */
export function sirenCountdownOf(run: SirenRun, remainingMs: number | null): SirenCountdown {
  if (run.endsAt === null || remainingMs === null) return { kind: 'open' }
  const left = Math.max(0, remainingMs)
  return {
    kind: 'timed',
    remainingSeconds: Math.ceil(left / 1000),
    fraction: run.totalMs === null ? null : Math.min(1, left / run.totalMs),
    estimated: run.estimated,
  }
}

/** The served state: the siren slice when it answered, else the switch. */
export function sirenActivityOf(
  sirenActive: boolean | undefined,
  switchOn: boolean | null | undefined,
): SirenActivity {
  const on = sirenActive ?? switchOn
  if (on === undefined || on === null) return 'unknown'
  return on ? 'sounding' : 'silent'
}

export interface SirenTriggerArgs {
  readonly durationSeconds?: number
  readonly plays?: number
}

/** A trigger asks seconds OR plays; neither is the camera default. */
export function sirenTriggerInputOf(amount: SirenAmount | null): SirenTriggerArgs {
  if (amount === null) return {}
  return amount.unit === 'plays' ? { plays: amount.value } : { durationSeconds: amount.value }
}
