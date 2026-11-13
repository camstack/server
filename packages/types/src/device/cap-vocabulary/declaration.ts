/**
 * How a capability DECLARES its vocabulary in its own `*.cap.ts` (D1050). The
 * cap vocabulary (D920) is generated from these declarations by
 * `npm run codegen` into `generated/cap-vocabulary.ts`; nothing hand-writes an
 * entry of the map any more (`scripts/check-no-handwritten-cap-vocabulary.ts`).
 *
 * Three places, each next to what it phrases:
 *
 * - an ACTION is declared on the method it calls — `method(input, output,
 *   { kind: 'mutation', actions: [...] })`, typed against that method's Zod
 *   input (fixed `args` and `openArgs` keys) — and a mutation that must never
 *   become a step says why with `notOperatorFacing` there. A method with
 *   neither is refused by `check-cap-vocabulary`: no mutation is offered by
 *   default.
 * - an EVENT's trigger wording (or its excuse) sits on the event declaration.
 * - the rest — the cap's noun, its state triggers, wording overrides by device
 *   type or role, bus events with no declared cap event, and the picker order —
 *   is the cap's `vocabulary` block. A system-scoped cap's block is only the
 *   reason it is never a device's vocabulary.
 *
 * These shapes are string-keyed: a status field, a dynamic-offer method or an
 * effect field cannot be named by its cap's TYPE inside the very object that
 * defines the cap. The generated map is typed `CapVocabularyMap`, which checks
 * every one of those names against the cap definition, and
 * `check-cap-vocabulary` checks values against the Zod schemas.
 */
import type {
  L10n,
  LooseVocabEffect,
  LooseVocabOffer,
  LooseVocabOverrides,
  LooseVocabStateTrigger,
  VocabEffectValue,
  VocabEventTrigger,
  VocabIcon,
} from './types.js'

/** The operator-supplied keys of a method input (`deviceId` is the target). */
export type MethodActionArgs<TInput> = TInput extends object
  ? Omit<TInput, 'deviceId'>
  : Record<never, never>

/** An open arg of a method action, keyed by the method's own input. */
export interface MethodActionOpenArg<TKey extends string = string> {
  readonly key: TKey
  readonly label: L10n
  readonly offer: LooseVocabOffer
  /** The method accepts the call without it. */
  readonly optional?: boolean
}

/** The state a method action leads to (D983) — see `VocabEffectFor`. */
export type MethodActionEffect<TKey extends string = string> =
  | { readonly field: string; readonly value: VocabEffectValue }
  | { readonly field: string; readonly fromArg: TKey }

/**
 * One operator-facing action declared on the method it calls. `TInput` is the
 * method's Zod input; the action's `method` is the key the method is declared
 * under, filled in by codegen.
 */
export interface MethodActionDecl<TInput = Readonly<Record<string, unknown>>> {
  /** Stable id — persisted by steps as their `actionId` (`switch.on`). */
  readonly id: string
  /** Short label for a picker ("Turn on"). */
  readonly label: L10n
  /** The sentence ("Turn on {device}"); placeholders are `{device}` and arg keys. */
  readonly phrase: L10n
  readonly icon: VocabIcon
  /** Args baked into the action — never asked. */
  readonly args?: Partial<MethodActionArgs<TInput>>
  /** Args the operator fills. */
  readonly openArgs?: readonly MethodActionOpenArg<keyof MethodActionArgs<TInput> & string>[]
  /** The state this action leads to, when it is one. */
  readonly effect?: MethodActionEffect<keyof MethodActionArgs<TInput> & string>
}

/** A method action as codegen reads it off a method schema, string-keyed. */
export interface LooseMethodActionDecl {
  readonly id: string
  readonly label: L10n
  readonly phrase: L10n
  readonly icon: VocabIcon
  readonly args?: Readonly<Record<string, unknown>>
  readonly openArgs?: readonly MethodActionOpenArg[]
  readonly effect?: LooseVocabEffect
}

/** What a declared cap event is to an automation: a trigger, or an excuse. */
export type EventVocabularyDecl =
  | { readonly trigger: VocabEventTrigger; readonly notOperatorFacing?: undefined }
  | { readonly notOperatorFacing: string; readonly trigger?: undefined }

/** The `vocabulary` block of a device-scoped cap. */
export interface DeviceCapVocabularyDecl {
  /** What the cap is, for grouping ("Switch" / "Interruttore"). */
  readonly noun: L10n
  /**
   * Where the cap's actions and triggers sit among a device's caps in a
   * picker — lower first. Caps of one family share a thousand
   * (actuators 1xxx, appliances 2xxx, camera 3xxx, heat pump 4xxx, sensors 5xxx).
   */
  readonly order: number
  readonly state?: readonly LooseVocabStateTrigger[]
  /** Bus events the cap's devices emit with no declared cap event behind them. */
  readonly extraEvents?: readonly VocabEventTrigger[]
  /** Wording that differs for a device type or role (a switch that is a siren). */
  readonly overrides?: LooseVocabOverrides
  readonly notOperatorFacing?: undefined
}

/** The `vocabulary` block of a system-scoped cap: why it is no device's vocabulary. */
export interface SystemCapVocabularyDecl {
  readonly notOperatorFacing: string
  readonly noun?: undefined
}

/** A cap's `vocabulary` block. */
export type CapVocabularyDecl = DeviceCapVocabularyDecl | SystemCapVocabularyDecl
