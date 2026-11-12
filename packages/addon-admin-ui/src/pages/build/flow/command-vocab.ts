/**
 * The cap vocabulary (D920) as an editing model for one "device command" step.
 *
 * A step is stored as `{ kind: 'command', target, actionId, args }`: the
 * vocabulary action it performs (`cover.position`), who it acts on, and the
 * values of the action's OPEN args. The step runner turns the action id into
 * a cap method when the step runs (`vocabCall`); nothing here names a method.
 * The operator picks a target and one of the phrased commands it offers ("Open
 * {device} to {position} %") and fills the open args; this file is the pure
 * mapping between the two, so the screen holds no cap-specific knowledge and
 * the round trip (step -> command + values -> step) is testable.
 */

import { REPEAT_ITEM_VAR } from '@camstack/types'
import type {
  ActionTarget,
  AutomationAction,
  LooseVocabOffer,
  LooseVocabOpenArg,
  ReadingQuantity,
  ResolvedVocabAction,
  VocabLocale,
} from '@camstack/types'

export type CommandStep = Extract<AutomationAction, { kind: 'command' }>

/** The variable a run binds to the device that triggered it. */
export const TRIGGER_DEVICE_VAR = 'deviceId'

/** The single device a step names, or null (several, a variable, a domain). */
export function singleDeviceOf(step: Pick<CommandStep, 'target'>): number | null {
  const target = step.target
  if (target.kind === 'devices' && target.ids.length === 1) return target.ids[0] ?? null
  return null
}

/** The target "the device of this round" of a repeat over devices (#500). */
export const ROUND_TARGET: ActionTarget = { kind: 'var', name: REPEAT_ITEM_VAR }

/** The target "the device that triggered this run". */
export const TRIGGER_TARGET: ActionTarget = { kind: 'var', name: TRIGGER_DEVICE_VAR }

/** Whether the step is aimed at the device of the round. */
export function isRoundTarget(step: Pick<CommandStep, 'target'>): boolean {
  return step.target.kind === 'var' && step.target.name === REPEAT_ITEM_VAR
}

/**
 * The commands EVERY device of a list offers, so one step can run on each of
 * them. With more than one device, a command whose argument is answered per
 * device (a `dynamic` offer: one device's presets are not another's) is left
 * out: no single value could be picked for the whole list.
 */
export function commonVocabActions(
  perDevice: readonly (readonly ResolvedVocabAction[])[],
): readonly ResolvedVocabAction[] {
  const [first, ...rest] = perDevice
  if (first === undefined) return []
  const others = rest.map((actions) => new Set(actions.map((a) => a.id)))
  return first.filter(
    (action) =>
      others.every((ids) => ids.has(action.id)) &&
      (rest.length === 0 || action.openArgs.every((arg) => arg.offer.kind !== 'dynamic')),
  )
}

/** One argument as the operator holds it: a typed value or a variable. */
export type StepArgValue =
  | {
      readonly kind: 'fixed'
      readonly value: string | number | boolean
      /** A quantity number: the unit the person picked (`argUnits`); `value` is in the offer's unit. */
      readonly unit?: string
    }
  | { readonly kind: 'var'; readonly name: string }

export type StepArgValues = Readonly<Record<string, StepArgValue>>

export type PhraseToken =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'slot'; readonly key: string }

export interface VocabCommandMatch {
  readonly action: ResolvedVocabAction
  readonly values: StepArgValues
}

const SLOT_RE = /(\{[A-Za-z0-9_]+\})/

export function vocabLocale(language: string): VocabLocale {
  return language.toLowerCase().startsWith('it') ? 'it' : 'en'
}

export function isVarRef(value: unknown): value is { readonly $var: string } {
  if (typeof value !== 'object' || value === null) return false
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === '$var' && typeof Reflect.get(value, '$var') === 'string'
}

/** "Turn on {device}" → text, slot(device), …; empty text parts are dropped. */
export function splitPhrase(phrase: string): readonly PhraseToken[] {
  const tokens: PhraseToken[] = []
  for (const part of phrase.split(SLOT_RE)) {
    if (part === '') continue
    if (part.startsWith('{') && part.endsWith('}')) {
      tokens.push({ kind: 'slot', key: part.slice(1, -1) })
    } else {
      tokens.push({ kind: 'text', text: part })
    }
  }
  return tokens
}

/** What an arg holds before the operator touches it. */
export function defaultArgValue(arg: LooseVocabOpenArg): StepArgValue {
  const offer = arg.offer
  switch (offer.kind) {
    case 'number':
      return {
        kind: 'fixed',
        value: offer.min ?? 0,
        ...(offer.quantity === undefined || offer.unit === undefined ? {} : { unit: offer.unit }),
      }
    case 'enum': {
      const first = offer.values[0]
      return { kind: 'fixed', value: first === undefined ? '' : first.value }
    }
    case 'boolean':
      return { kind: 'fixed', value: false }
    default:
      return { kind: 'fixed', value: '' }
  }
}

export function defaultArgValues(action: Pick<ResolvedVocabAction, 'openArgs'>): StepArgValues {
  return Object.fromEntries(action.openArgs.map((a) => [a.key, defaultArgValue(a)]))
}

function readArgValue(
  raw: unknown,
  arg: LooseVocabOpenArg,
  pickedUnit: string | undefined,
): StepArgValue {
  if (isVarRef(raw)) return { kind: 'var', name: raw.$var }
  const quantity = quantityOffer(arg)
  if (typeof raw === 'number' && quantity !== undefined) {
    return { kind: 'fixed', value: raw, unit: pickedUnit ?? quantity.unit }
  }
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return { kind: 'fixed', value: raw }
  }
  return defaultArgValue(arg)
}

/** The quantity and the stored unit of a number arg, when its offer names both (D972). */
export interface QuantityArgOffer {
  readonly quantity: ReadingQuantity
  /** The unit the method stores the number in. */
  readonly unit: string
  readonly min?: number
  readonly max?: number
}

export function quantityOffer(arg: LooseVocabOpenArg): QuantityArgOffer | undefined {
  const offer = arg.offer
  if (offer.kind !== 'number' || offer.quantity === undefined || offer.unit === undefined) {
    return undefined
  }
  return { quantity: offer.quantity, unit: offer.unit, min: offer.min, max: offer.max }
}

/**
 * The vocabulary command a stored step is, among `actions` (what its target
 * offers), with its open args read back; null when the target does not offer
 * the step's action.
 */
export function matchCommand(
  actions: readonly ResolvedVocabAction[],
  step: Pick<CommandStep, 'actionId' | 'args' | 'argUnits'>,
): VocabCommandMatch | null {
  const action = actions.find((a) => a.id === step.actionId)
  if (action === undefined) return null
  const args = step.args ?? {}
  const values = Object.fromEntries(
    action.openArgs.map((a) => [a.key, readArgValue(args[a.key], a, step.argUnits?.[a.key])]),
  )
  return { action, values }
}

function rawOf(value: StepArgValue): string | number | boolean | { readonly $var: string } {
  return value.kind === 'var' ? { $var: value.name } : value.value
}

function isBlank(value: StepArgValue): boolean {
  return value.kind === 'fixed' && value.value === ''
}

/** The stored step for a command: its id, its target and the OPEN args (baked ones are added at run). */
export function buildCommandStep(
  action: Pick<ResolvedVocabAction, 'id' | 'openArgs'>,
  target: ActionTarget,
  values: StepArgValues,
): CommandStep {
  const args: Record<string, unknown> = {}
  const argUnits: Record<string, string> = {}
  for (const arg of action.openArgs) {
    const value = values[arg.key] ?? defaultArgValue(arg)
    if (arg.optional === true && isBlank(value)) continue
    args[arg.key] = rawOf(value)
    if (value.kind === 'fixed' && value.unit !== undefined && quantityOffer(arg) !== undefined) {
      argUnits[arg.key] = value.unit
    }
  }
  return {
    kind: 'command',
    target,
    actionId: action.id,
    ...(Object.keys(args).length === 0 ? {} : { args }),
    ...(Object.keys(argUnits).length === 0 ? {} : { argUnits }),
  }
}

export type ArgIssue = 'empty' | 'below' | 'above'

/** What is wrong with a typed value, judged by its offer. A variable is not judged here. */
export function argIssue(arg: LooseVocabOpenArg, value: StepArgValue): ArgIssue | null {
  if (value.kind === 'var') return null
  const offer: LooseVocabOffer = arg.offer
  if (offer.kind === 'number') {
    if (typeof value.value !== 'number' || !Number.isFinite(value.value)) return 'empty'
    if (offer.min !== undefined && value.value < offer.min) return 'below'
    if (offer.max !== undefined && value.value > offer.max) return 'above'
    return null
  }
  if (offer.kind === 'text' || offer.kind === 'dynamic') {
    return arg.optional === true || value.value !== '' ? null : 'empty'
  }
  return null
}

/** The first open arg that cannot be saved as it stands, or null. */
export function firstArgIssue(
  action: Pick<ResolvedVocabAction, 'openArgs'>,
  values: StepArgValues,
): { readonly key: string; readonly issue: ArgIssue } | null {
  for (const arg of action.openArgs) {
    const value = values[arg.key]
    if (value === undefined) continue
    const issue = argIssue(arg, value)
    if (issue !== null) return { key: arg.key, issue }
  }
  return null
}
