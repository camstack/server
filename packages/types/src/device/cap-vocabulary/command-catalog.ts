/**
 * The command catalogue (D1022): which cap methods are COMMANDS - the
 * vocabulary actions (D920/D983) of a device-scope cap - and which status
 * fields a command's effect or a boolean/enum state trigger names.
 *
 * Derived from the vocabulary, never kept as a second list: a method that
 * becomes an action is a command with no other edit, and the spec beside this
 * file fails when a device mutation is neither one nor excused. The audit in
 * the hub mirror reads `auditedFields` so a slice write on a cap without any
 * costs one map miss.
 */
import { actionEffect, allVocabActions, findVocabAction, vocabActionIdFor } from './action-index.js'
import { CAP_VOCABULARY_BY_NAME } from './vocabulary.js'
import type { LooseVocabSideEffect, VocabEffectCondition, VocabEffectValue } from './types.js'

/** The state a command leads to: a cap status field and the value it should hold. */
export interface CommandEffect {
  readonly field: string
  readonly value: VocabEffectValue
}

let commandKeys: ReadonlySet<string> | undefined
let fieldsByCap: ReadonlyMap<string, ReadonlySet<string>> | undefined
const NO_FIELDS: ReadonlySet<string> = new Set()

function commands(): ReadonlySet<string> {
  commandKeys ??= new Set(allVocabActions().map(({ cap, action }) => `${cap}.${action.method}`))
  return commandKeys
}

function buildAuditedFields(): ReadonlyMap<string, ReadonlySet<string>> {
  const byCap = new Map<string, Set<string>>()
  const add = (cap: string, field: string): void => {
    const set = byCap.get(cap) ?? new Set<string>()
    set.add(field)
    byCap.set(cap, set)
  }
  for (const { cap, action } of allVocabActions()) {
    if (action.effect !== undefined) add(cap, action.effect.field)
    for (const side of action.sideEffects ?? []) add(cap, side.field)
  }
  for (const [cap, entry] of Object.entries(CAP_VOCABULARY_BY_NAME)) {
    if (entry.scope !== 'device') continue
    for (const trigger of entry.state ?? []) {
      if (trigger.kind === 'boolean' || trigger.kind === 'enum') add(cap, trigger.field)
    }
  }
  return byCap
}

/** Is `cap.method` a vocabulary action of a device-scope cap? */
export function isCommand(cap: string, method: string): boolean {
  return commands().has(`${cap}.${method}`)
}

/**
 * The state the command `cap.method(args)` leads to, or `null` when it leads
 * to none (toggle, press, stop), is not a command, or the argument carrying
 * the value is missing.
 */
export function commandEffect(
  cap: string,
  method: string,
  args: Readonly<Record<string, unknown>> | undefined,
): CommandEffect | null {
  const actionId = vocabActionIdFor(cap, method, args)
  if (actionId === undefined) return null
  const effect = actionEffect(actionId, args)
  return effect === null ? null : { field: effect.field, value: effect.value }
}

/** The status fields of `cap` whose changes are recorded as transitions. */
export function auditedFields(cap: string): ReadonlySet<string> {
  fieldsByCap ??= buildAuditedFields()
  return fieldsByCap.get(cap) ?? NO_FIELDS
}

/** The current slice of the command's cap, as a condition reads it. */
export type CommandSlice = Readonly<Record<string, unknown>> | undefined

/** Does `slice` meet `when`? A field the slice lacks is in no list. */
export function effectConditionHolds(
  when: VocabEffectCondition | undefined,
  slice: CommandSlice,
): boolean {
  if (when === undefined) return true
  const raw = slice?.[when.field]
  const value =
    typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' ? raw : undefined
  if ('in' in when) return value !== undefined && when.in.includes(value)
  return value === undefined || !when.notIn.includes(value)
}

/** One side effect resolved against the args: `null` when the arg carrying its value is missing. */
export function resolveSideEffect(
  side: LooseVocabSideEffect,
  args: Readonly<Record<string, unknown>> | undefined,
): CommandEffect | null {
  if ('value' in side) return { field: side.field, value: side.value }
  const raw = args?.[side.fromArg]
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return { field: side.field, value: raw }
  }
  return null
}

/**
 * EVERY state the command `cap.method(args)` leads to (D1061): its `effect`
 * first, then each side effect whose condition holds on `current` (the cap's
 * slice when the command arrived). Empty when it leads to none. One field is
 * named once — the first entry for it wins.
 */
export function commandEffects(
  cap: string,
  method: string,
  args: Readonly<Record<string, unknown>> | undefined,
  current: CommandSlice,
): readonly CommandEffect[] {
  const actionId = vocabActionIdFor(cap, method, args)
  if (actionId === undefined) return []
  const out: CommandEffect[] = []
  const primary = actionEffect(actionId, args)
  if (primary !== null) out.push({ field: primary.field, value: primary.value })
  for (const side of findVocabAction(actionId)?.action.sideEffects ?? []) {
    if (!effectConditionHolds(side.when, current)) continue
    const resolved = resolveSideEffect(side, args)
    if (resolved !== null && !out.some((e) => e.field === resolved.field)) out.push(resolved)
  }
  return out
}
