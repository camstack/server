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
import type {
  LooseVocabActionHold,
  LooseVocabOpenArg,
  LooseVocabSideEffect,
  VocabEffectCondition,
  VocabEffectValue,
} from './types.js'

/** The state a command leads to: a cap status field and the value it should hold. */
export interface CommandEffect {
  readonly field: string
  readonly value: VocabEffectValue
  /**
   * How far a numeric reading may sit from `value` and still confirm it (D1061):
   * the step of the number arg the value was copied from (brightness 1, a
   * temperature target 0.5). Absent = the reading must equal the value.
   */
  readonly tolerance?: number
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

/** The step of the number open arg `key`, when the action offers one. */
function stepOf(
  openArgs: readonly LooseVocabOpenArg[] | undefined,
  key: string,
): number | undefined {
  const offer = openArgs?.find((a) => a.key === key)?.offer
  return offer?.kind === 'number' && offer.step !== undefined && offer.step > 0
    ? offer.step
    : undefined
}

/**
 * One side effect resolved against the args and the slice the command acts
 * on: `null` when the arg carrying its value is missing, or a `negate` names a
 * field the slice holds no boolean in. `openArgs` lends a copied number its
 * step as the tolerance.
 */
export function resolveSideEffect(
  side: LooseVocabSideEffect,
  args: Readonly<Record<string, unknown>> | undefined,
  shown?: CommandSlice,
  openArgs?: readonly LooseVocabOpenArg[],
): CommandEffect | null {
  if ('value' in side) return { field: side.field, value: side.value }
  if ('negate' in side) {
    const raw = shown?.[side.field]
    return typeof raw === 'boolean' ? { field: side.field, value: !raw } : null
  }
  const raw = args?.[side.fromArg]
  if (typeof raw === 'string' || typeof raw === 'boolean') return { field: side.field, value: raw }
  if (typeof raw === 'number') {
    // An arg in another unit (minutes → seconds) scales its value and step.
    const scale = side.scale ?? 1
    const step = stepOf(openArgs, side.fromArg)
    return step === undefined
      ? { field: side.field, value: raw * scale }
      : { field: side.field, value: raw * scale, tolerance: step * scale }
  }
  return null
}

/**
 * The hold limit the vocabulary declares for `cap.method(args)` (its action's
 * `hold.holdMs`), or `undefined` for the default.
 */
export function commandHoldMs(
  cap: string,
  method: string,
  args: Readonly<Record<string, unknown>> | undefined,
): number | undefined {
  return holdFor(cap, method, args)?.holdMs
}

/**
 * The hold the vocabulary declares for `cap.method(args)`: the matched
 * action's, or — when several actions share the method and the args cannot
 * tell them apart (`petFeeder.feed` / `feedHoppers`) — the one they all
 * declare alike. Different holds on such actions resolve to none.
 */
function holdFor(
  cap: string,
  method: string,
  args: Readonly<Record<string, unknown>> | undefined,
): LooseVocabActionHold | undefined {
  const actionId = vocabActionIdFor(cap, method, args)
  if (actionId !== undefined) return findVocabAction(actionId)?.action.hold
  const holds = allVocabActions()
    .filter(({ cap: c, action }) => c === cap && action.method === method)
    .map(({ action }) => action.hold)
  const first = holds[0]
  if (first === undefined) return undefined
  const key = JSON.stringify(first)
  return holds.every((h) => JSON.stringify(h) === key) ? first : undefined
}

/**
 * EVERY state the command `cap.method(args)` leads to (D1061): its `effect`
 * first, then each side effect whose condition holds on `current` (the cap's
 * slice the device reported when the command arrived). Empty when it leads to
 * none. One field is named once — the first entry for it wins. A `negate`
 * side effect flips what `shown` (the slice the person saw, held values
 * included) holds, so a second toggle before the first is confirmed undoes it.
 * An action that declares `hold.effects` is held as THOSE instead (a lock
 * holds `locking`, not `locked`).
 */
export function commandEffects(
  cap: string,
  method: string,
  args: Readonly<Record<string, unknown>> | undefined,
  current: CommandSlice,
  shown: CommandSlice = current,
): readonly CommandEffect[] {
  const out: CommandEffect[] = []
  const hold = holdFor(cap, method, args)
  if (hold?.effects !== undefined) {
    for (const entry of hold.effects) {
      if (!effectConditionHolds(entry.when, current)) continue
      const resolved = resolveSideEffect(entry, args, shown)
      if (resolved !== null && !out.some((e) => e.field === resolved.field)) out.push(resolved)
    }
    return out
  }
  const actionId = vocabActionIdFor(cap, method, args)
  if (actionId === undefined) return []
  const action = findVocabAction(actionId)?.action
  if (action?.effect !== undefined) {
    const primary = resolveSideEffect(action.effect, args, shown, action.openArgs)
    if (primary !== null) out.push(primary)
  }
  for (const side of action?.sideEffects ?? []) {
    if (!effectConditionHolds(side.when, current)) continue
    const resolved = resolveSideEffect(side, args, shown, action?.openArgs)
    if (resolved !== null && !out.some((e) => e.field === resolved.field)) out.push(resolved)
  }
  return out
}
