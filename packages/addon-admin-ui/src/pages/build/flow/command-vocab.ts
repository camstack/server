/**
 * The cap vocabulary (D920) as an editing model for one "device command" step.
 *
 * A step is stored as `{ kind: 'cap', deviceId, cap, method, args }`. The
 * operator does not see that: they pick a device, pick one of the phrased
 * commands the device's bound caps offer ("Turn on {device}", "Feed {device}
 * {grams} g"), and fill the open args inline. This file is the pure mapping
 * between the two, so the screen holds no cap-specific knowledge and the
 * round trip (step → command + values → step) is testable.
 *
 * A step the vocabulary cannot represent — a `{ $var }` or multi-device target,
 * or a cap/method the device no longer offers — returns `null` from
 * {@link matchVocabCommand}; the caller falls back to the generic row and the
 * step is kept as it is.
 */

import type {
  AutomationAction,
  LooseVocabOffer,
  LooseVocabOpenArg,
  ReadingQuantity,
  ResolvedVocabAction,
  VocabLocale,
} from '@camstack/types'

export type CapStep = Extract<AutomationAction, { kind: 'cap' }>

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

/** The command's own id: unique across caps (two caps may share a local id). */
export function commandId(action: Pick<ResolvedVocabAction, 'cap' | 'id'>): string {
  return `${action.cap}:${action.id}`
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

export function defaultArgValues(action: ResolvedVocabAction): StepArgValues {
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

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The vocabulary command a stored step is, with its open args read back.
 * Several commands may share a method (an "on" and an "off" that bake
 * different args); the one with the most baked args that all match wins.
 */
export function matchVocabCommand(
  actions: readonly ResolvedVocabAction[],
  step: CapStep,
): VocabCommandMatch | null {
  if (typeof step.deviceId !== 'number') return null
  const args = step.args ?? {}
  let best: ResolvedVocabAction | null = null
  let bestBaked = -1
  for (const action of actions) {
    if (action.cap !== step.cap || action.method !== step.method) continue
    const baked = Object.entries(action.args)
    if (!baked.every(([key, value]) => sameValue(args[key], value))) continue
    if (baked.length > bestBaked) {
      best = action
      bestBaked = baked.length
    }
  }
  if (best === null) return null
  const values = Object.fromEntries(
    best.openArgs.map((a) => [a.key, readArgValue(args[a.key], a, step.argUnits?.[a.key])]),
  )
  return { action: best, values }
}

function rawOf(value: StepArgValue): string | number | boolean | { readonly $var: string } {
  return value.kind === 'var' ? { $var: value.name } : value.value
}

function isBlank(value: StepArgValue): boolean {
  return value.kind === 'fixed' && value.value === ''
}

/** The stored step for a command: baked args first, then the operator's. */
export function buildCapStep(
  action: ResolvedVocabAction,
  deviceId: number,
  values: StepArgValues,
): CapStep {
  const open: Record<string, unknown> = {}
  const argUnits: Record<string, string> = {}
  for (const arg of action.openArgs) {
    const value = values[arg.key] ?? defaultArgValue(arg)
    if (arg.optional === true && isBlank(value)) continue
    open[arg.key] = rawOf(value)
    if (value.kind === 'fixed' && value.unit !== undefined && quantityOffer(arg) !== undefined) {
      argUnits[arg.key] = value.unit
    }
  }
  const args = { ...action.args, ...open }
  return {
    kind: 'cap',
    deviceId,
    cap: action.cap,
    method: action.method,
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
  action: ResolvedVocabAction,
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
