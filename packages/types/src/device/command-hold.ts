/**
 * The command hold (D1061): the core shows a commanded value at once, by
 * default, until the device confirms it, the call is refused, or the limit
 * elapses. The vocabulary says WHAT a command leads to (`effect`,
 * `sideEffects`); a provider may say, at its registration, that a method is
 * never held, held longer or shorter, or leads to other fields. Never in a
 * `*.cap.ts` or a manifest (D4).
 *
 * Pure: the resolution below reads the vocabulary and the option only, so the
 * hub mirror and a spec ask the same question.
 */
import type { CapabilityDefinition } from '../capabilities/capability-definition.js'
import {
  type CommandEffect,
  type CommandSlice,
  commandEffects,
  commandHoldMs,
  effectConditionHolds,
  resolveSideEffect,
} from './cap-vocabulary/command-catalog.js'
import type { LooseVocabSideEffect } from './cap-vocabulary/types.js'
import type { StateRefreshPolicy } from './state-refresh.js'

/**
 * How long a command is held when nothing says otherwise. Equal to the
 * transition correlator's match window (D1022), so a hold that reverts and a
 * command recorded `unconfirmed` are the same event.
 */
export const DEFAULT_COMMAND_HOLD_MS = 30_000

/** The longest hold a provider may ask for: a value the device never confirms is not shown for long. */
export const MAX_COMMAND_HOLD_MS = 120_000

/** A provider's word on one command method. */
export type CommandHoldOption =
  /** Never held: the slice moves only when the device reports. */
  | { readonly hold: 'never' }
  | {
      readonly hold?: undefined
      /** The limit, in ms (clamped to 1 … {@link MAX_COMMAND_HOLD_MS}); absent = {@link DEFAULT_COMMAND_HOLD_MS}. */
      readonly holdMs?: number
      /** REPLACES the vocabulary's effects for this method. */
      readonly effects?: readonly LooseVocabSideEffect[]
      /** Held IN ADDITION to the vocabulary's effects (a field already named keeps the first). */
      readonly extraEffects?: readonly LooseVocabSideEffect[]
    }

/** A provider's options, keyed by cap method name. Wire-safe (plain data). */
export type CommandHoldOptions = Readonly<Record<string, CommandHoldOption>>

/** The options `registerNativeCap` takes, method names checked against the cap. */
export interface NativeCapOptions<TCap extends CapabilityDefinition = CapabilityDefinition> {
  readonly commands?: Partial<Readonly<Record<keyof TCap['methods'] & string, CommandHoldOption>>>
  /**
   * The device's refresh policy (D1062). Read only on the `device-state-refresh`
   * registration: the core schedules that device's refreshes by it.
   */
  readonly stateRefresh?: StateRefreshPolicy
}

/** What the core holds for one command: the fields and the limit. */
export interface ResolvedCommandHold {
  readonly effects: readonly CommandEffect[]
  readonly holdMs: number
}

function clampHoldMs(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return DEFAULT_COMMAND_HOLD_MS
  return Math.min(MAX_COMMAND_HOLD_MS, Math.max(1, Math.round(ms)))
}

function resolveList(
  list: readonly LooseVocabSideEffect[],
  args: Readonly<Record<string, unknown>> | undefined,
  current: CommandSlice,
  shown: CommandSlice,
  into: CommandEffect[],
): void {
  for (const entry of list) {
    if (!effectConditionHolds(entry.when, current)) continue
    const resolved = resolveSideEffect(entry, args, shown)
    if (resolved !== null && !into.some((e) => e.field === resolved.field)) into.push(resolved)
  }
}

/**
 * What to hold for `cap.method(args)` given the cap's slice when it arrived
 * (`current`, as the device reported it; `shown`, with the held values over
 * it — what a `negate` flips) and the provider's option for the method.
 * `null` = hold nothing (`never`, or a command that leads to no state).
 */
export function resolveCommandHold(
  cap: string,
  method: string,
  args: Readonly<Record<string, unknown>> | undefined,
  current: CommandSlice,
  option: CommandHoldOption | undefined,
  shown: CommandSlice = current,
): ResolvedCommandHold | null {
  if (option?.hold === 'never') return null
  const effects: CommandEffect[] = []
  if (option?.effects !== undefined) resolveList(option.effects, args, current, shown, effects)
  else effects.push(...commandEffects(cap, method, args, current, shown))
  if (option?.extraEffects !== undefined) {
    resolveList(option.extraEffects, args, current, shown, effects)
  }
  if (effects.length === 0) return null
  return { effects, holdMs: clampHoldMs(option?.holdMs ?? commandHoldMs(cap, method, args)) }
}
