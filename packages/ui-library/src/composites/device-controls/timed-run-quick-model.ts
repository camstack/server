/**
 * The one-tap run of a device (D993), as every surface that offers the timed run reads and
 * writes it: the row beside a device and the card of a device draw ONE control
 * (`TimedRunQuick`) over this model.
 *
 * The saved duration is the device's own `quickRun` (the cap's status slice), else the type's
 * default; the bound is the type's maximum. A change is saved through `setSettings` and Run
 * starts `runFor` with the value the control holds. Nothing here is drawn.
 */
import {
  timedRunMaxIn,
  type TimedRunLimit,
  type TimedRunRefusal,
  type TimedRunResult,
  type TimedRunStatus,
  type TimedRunUnit,
} from '@dominevo/types'

/** How long after the last keystroke an edited duration is saved (once). */
export const QUICK_RUN_SAVE_DEBOUNCE_MS = 600

/** What the control shows: the unit, the saved duration, the bound and the armed deadline. */
export interface TimedRunQuickView {
  readonly unit: TimedRunUnit
  /** The saved one-tap run, in `unit`. */
  readonly saved: number
  /** The longest run, in `unit`. */
  readonly max: number
  /** Epoch ms the running cycle ends at; null when none runs. */
  readonly activeUntil: number | null
}

/** What the control does: each call rejects with the reason it was refused. */
export interface TimedRunQuickCalls {
  readonly save: (duration: number) => Promise<void>
  readonly run: (duration: number) => Promise<TimedRunResult>
  readonly stop: () => Promise<void>
}

/** The structural part of the `timed-run` cap handle the surfaces call. */
export interface TimedRunQuickCap {
  readonly setSettings: (input: {
    readonly settings: { readonly quickRunDuration: number | null }
  }) => Promise<void>
  readonly runFor: (input: {
    readonly duration: number
    readonly unit: TimedRunUnit
  }) => Promise<TimedRunResult>
  readonly cancel: (input: Record<string, never>) => Promise<void>
}

export function timedRunQuickView(
  limit: TimedRunLimit,
  slice: Pick<TimedRunStatus, 'activeUntil' | 'quickRun'> | undefined,
): TimedRunQuickView {
  const max = timedRunMaxIn(limit)
  const stored = slice?.quickRun?.unit === limit.unit ? slice.quickRun.duration : null
  return {
    unit: limit.unit,
    saved: Math.min(stored ?? limit.quickRunDefault, max),
    max,
    activeUntil: slice?.activeUntil ?? null,
  }
}

export function timedRunQuickCalls(cap: TimedRunQuickCap, unit: TimedRunUnit): TimedRunQuickCalls {
  return {
    save: (duration) => cap.setSettings({ settings: { quickRunDuration: duration } }),
    run: (duration) => cap.runFor({ duration, unit }),
    stop: () => cap.cancel({}),
  }
}

/** A duration the hub would accept: a whole positive number up to the bound. */
export function isValidQuickRun(duration: number, max: number): boolean {
  return Number.isInteger(duration) && duration >= 1 && duration <= max
}

/** A refusal's message key, for the typed reasons the hub answers `runFor` with. */
export function quickRunRefusalKey(reason: TimedRunRefusal): string {
  switch (reason) {
    case 'over-max':
      return 'uiLibrary.timedRun.overMax'
    case 'command-failed':
      return 'uiLibrary.timedRun.commandFailed'
    case 'unsupported-device':
      return 'uiLibrary.timedRun.unsupported'
  }
}
