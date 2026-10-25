/**
 * The owner's answer to "which model did the operator choose for this
 * cluster-scoped step?" (D651 fix round 3).
 *
 * The orchestrator owns `clusterModel:*`: it renders the form and stores the
 * row. A consumer that REWRITES an index on this answer (the face re-embed,
 * the CLIP rebuild) must not read the orchestrator's private store layout,
 * and must not read its hydrated settings view either — that answers
 * `value ?? default`, so a default nobody chose and a failed read both look
 * like a choice. So the owner answers, from a three-way read of its own store.
 *
 * The stored VALUE is read with the runtime's own interpretation
 * (`interpretStoredClusterModel`, fix round 4): a cleared field (`null`, `''`)
 * is absent, any non-empty string is the choice — verbatim, as the runner pins
 * it — and only a non-string is `invalid-stored`. Checking the id against the
 * dropdown here would give one stored key two meanings: the runner deliberately
 * pins an id the catalog does not list (a custom encoder), so an owner that
 * called it invalid would refuse a pass on the very model the fleet is running.
 */
import {
  CLUSTER_MODEL_SCOPED_STEPS,
  type ClusterModelChoice,
  interpretStoredClusterModel,
  type StoredKeyRead,
} from '@camstack/types'

/**
 * Turn a three-way read of `clusterModel:<stepId>` into the cap answer.
 * `'owner-not-ready'` is the caller's statement that its boot has not settled.
 */
export function decideClusterModelChoice(
  stepId: string,
  read: StoredKeyRead | 'owner-not-ready',
): ClusterModelChoice {
  const step = CLUSTER_MODEL_SCOPED_STEPS.find((s) => s.stepId === stepId)
  if (step === undefined) return { kind: 'unreadable', reason: 'not-cluster-scoped' }
  if (read === 'owner-not-ready') return { kind: 'unreadable', reason: 'owner-not-ready' }
  if (read.kind === 'unreadable') {
    return read.error !== undefined
      ? { kind: 'unreadable', reason: read.reason, error: read.error }
      : { kind: 'unreadable', reason: read.reason }
  }
  const stored = interpretStoredClusterModel(read.kind === 'absent' ? undefined : read.value)
  if (stored.kind === 'absent') return { kind: 'absent', defaultModelId: step.defaultModelId }
  if (stored.kind === 'chosen') return { kind: 'stored', modelId: stored.modelId }
  return { kind: 'unreadable', reason: 'invalid-stored' }
}
