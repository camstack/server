/**
 * The READ projection of a stored rule whose `device-command` filter still names an outcome
 * the transition store retired (D1084): `confirmed`, `already` and `unconfirmed` all mean the
 * command went through, which is `ok` now. Zod would reject the row as a whole and the rule
 * would drop out of the mirror. The candidate is rewritten in RAM only; the stored row is
 * never touched (D49), and the first explicit save writes the current words.
 */
const RETIRED_OUTCOMES: ReadonlySet<string> = new Set(['confirmed', 'already', 'unconfirmed'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function withCurrentCommandOutcomes(candidate: unknown): unknown {
  if (!isRecord(candidate)) return candidate
  const conditions = candidate['conditions']
  if (!isRecord(conditions)) return candidate
  const systemEvent = conditions['systemEvent']
  if (!isRecord(systemEvent)) return candidate
  const outcomes = systemEvent['commandOutcomes']
  if (!Array.isArray(outcomes) || !outcomes.some((o) => RETIRED_OUTCOMES.has(String(o)))) {
    return candidate
  }
  const mapped = outcomes.map((o) => (RETIRED_OUTCOMES.has(String(o)) ? 'ok' : o))
  return {
    ...candidate,
    conditions: {
      ...conditions,
      systemEvent: { ...systemEvent, commandOutcomes: [...new Set(mapped)] },
    },
  }
}
