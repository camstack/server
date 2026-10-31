/**
 * Vocabulary actions by id (D983). An action step names a vocabulary action
 * (`cover.open`), never a raw cap method; this is the one lookup that turns the
 * id into its cap, method and effect — and a persisted legacy `cap` + `method`
 * pair back into the action id when exactly one action matches.
 */
import { CAP_VOCABULARY_BY_NAME } from './vocabulary.js'
import type { LooseVocabAction, LooseVocabEffect, VocabEffectValue } from './types.js'

/** A vocabulary action with the cap that offers it. */
export interface IndexedVocabAction {
  readonly cap: string
  readonly action: LooseVocabAction
}

/** The state an action leads to, resolved against the args the step carries. */
export interface ActionEffect {
  readonly cap: string
  readonly field: string
  readonly value: VocabEffectValue
}

function buildIndex(): ReadonlyMap<string, IndexedVocabAction> {
  const byId = new Map<string, IndexedVocabAction>()
  for (const [cap, entry] of Object.entries(CAP_VOCABULARY_BY_NAME)) {
    if (entry.scope !== 'device') continue
    for (const action of entry.actions ?? []) byId.set(action.id, { cap, action })
  }
  return byId
}

let index: ReadonlyMap<string, IndexedVocabAction> | undefined

function actionIndex(): ReadonlyMap<string, IndexedVocabAction> {
  index ??= buildIndex()
  return index
}

/** Every vocabulary action id, with its cap. */
export function allVocabActions(): readonly IndexedVocabAction[] {
  return [...actionIndex().values()]
}

/** The vocabulary action with this id, or `undefined`. */
export function findVocabAction(actionId: string): IndexedVocabAction | undefined {
  return actionIndex().get(actionId)
}

/**
 * The action id a stored `cap` + `method` (+ args) pair stands for, when
 * exactly ONE vocabulary action matches it: same cap, same method, and every
 * arg the action bakes in equals the stored one. Two matches (`cover.position`
 * and … none today, but `switch.on` / `switch.off` share a method and differ
 * by their baked arg) are told apart by the baked args; still ambiguous, or
 * none, gives `undefined`.
 */
export function vocabActionIdFor(
  cap: string,
  method: string,
  args: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const matches = allVocabActions().filter(
    ({ cap: c, action }) =>
      c === cap &&
      action.method === method &&
      Object.entries(action.args ?? {}).every(
        ([key, value]) => JSON.stringify(args?.[key]) === JSON.stringify(value),
      ),
  )
  if (matches.length === 1) return matches[0]?.action.id
  // Several fit (an open-arg action beside baked ones): the most specific wins
  // only when it bakes strictly more args than every other.
  const baked = matches.map((m) => Object.keys(m.action.args ?? {}).length)
  const most = Math.max(...baked)
  const best = matches.filter((_, i) => baked[i] === most)
  return best.length === 1 ? best[0]?.action.id : undefined
}

function isLiteral(
  effect: LooseVocabEffect,
): effect is Extract<LooseVocabEffect, { value: VocabEffectValue }> {
  return 'value' in effect
}

/**
 * The state `actionId` leads to with these args, or `null` when the action
 * declares none (toggle, press, stop), is unknown, or the arg carrying the
 * value is missing.
 */
export function actionEffect(
  actionId: string,
  args: Readonly<Record<string, unknown>> | undefined,
): ActionEffect | null {
  const found = findVocabAction(actionId)
  const effect = found?.action.effect
  if (found === undefined || effect === undefined) return null
  if (isLiteral(effect)) return { cap: found.cap, field: effect.field, value: effect.value }
  const raw = args?.[effect.fromArg]
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return { cap: found.cap, field: effect.field, value: raw }
  }
  return null
}
