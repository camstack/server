/**
 * Which discovered candidate is ALREADY a target.
 *
 * A candidate is the same as an existing target of the same `kind` when every identifying value
 * of the candidate equals the target's value for that key. The identifying keys are the kind's
 * published `destinationKeys` (what decides where a target sends); a kind that declares none is
 * judged on every non-empty scalar of the candidate config. Only keys the candidate actually
 * carries are compared, and at least one must be: a candidate with nothing to compare never
 * matches. A secret on the target side is not a scalar and never matches.
 *
 * The existing list is `undefined` until its query ANSWERED: an unanswered list is not "none
 * added", so nothing is marked.
 */

type Scalar = string | number | boolean

export interface AdoptedTarget {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly values: Readonly<Record<string, unknown>>
}

function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function isFilled(value: unknown): value is Scalar {
  return isScalar(value) && (typeof value !== 'string' || value.trim().length > 0)
}

export function findAdoptedTarget(
  kind: string,
  candidateConfig: Readonly<Record<string, unknown>>,
  identityKeys: readonly string[] | undefined,
  existing: readonly AdoptedTarget[] | undefined,
): AdoptedTarget | null {
  if (existing === undefined) return null
  const keys =
    identityKeys !== undefined && identityKeys.length > 0
      ? identityKeys
      : Object.keys(candidateConfig)
  const compared = keys.filter((key) => isFilled(candidateConfig[key]))
  if (compared.length === 0) return null
  return (
    existing.find(
      (target) =>
        target.kind === kind &&
        compared.every((key) => target.values[key] === candidateConfig[key]),
    ) ?? null
  )
}
