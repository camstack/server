/**
 * Compact → full. A draft names a vocabulary action (`cover.open`) and its
 * target; the cap, method and baked args follow from the vocabulary, so a model
 * is not asked to repeat them. `expandDraft` writes them in, anywhere a cap
 * step appears (an automation's actions, an action's steps, a scheduler
 * point's steps), and leaves everything else untouched.
 */
import { findVocabAction } from '../../device/cap-vocabulary/action-index.js'

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expandStep(step: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const actionId = step['actionId']
  if (step['kind'] !== 'cap' || typeof actionId !== 'string') return step
  const found = findVocabAction(actionId)
  if (found === undefined) return step
  const given = isRecord(step['args']) ? step['args'] : {}
  const args = { ...found.action.args, ...given }
  return {
    ...step,
    cap: typeof step['cap'] === 'string' ? step['cap'] : found.cap,
    method: typeof step['method'] === 'string' ? step['method'] : found.action.method,
    ...(Object.keys(args).length === 0 ? {} : { args }),
  }
}

export function expandDraft(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expandDraft)
  if (!isRecord(value)) return value
  const mapped = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandDraft(v)]))
  return expandStep(mapped)
}
