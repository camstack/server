/**
 * The node-attributed view of the towers' terminal states (D649 rounds 4–5).
 *
 * `embedding-encoder` is a global collection with ONE provider per node, and a
 * call is answered by one node — the `nodeId` selector's, else the hub's.
 * Before round 4, `getInfo().failedModels` and `resetFailedModels` answered
 * with no node on them, so a model failing on agent B looked healthy whenever
 * the hub answered, and a reset could not say whose state it had cleared.
 * Every row and every reset result names the node; a fleet view is one call
 * per node, and a node the reader could not ask is UNKNOWN to it, never
 * "none".
 *
 * Two terminal states share the exits (`resetFailedModels`, a model change, a
 * runner respawn): a tower past its crash budget (`failedModels`) and a model
 * whose requirements can never be met (`failedRequirements`).
 */
import type { EmbeddingFailedRequirement } from '@camstack/types'
import type { CrashBudget, FailedModel } from './crash-budget.js'
import type { RequirementsGate } from './model-requirements.js'

export interface TowerBudgets {
  readonly image: CrashBudget
  readonly text: CrashBudget
}

export interface TowerRequirements {
  readonly image: RequirementsGate
  readonly text: RequirementsGate
}

/** Everything on this node that can be terminally refused. */
export interface EncoderTowers {
  readonly budgets: TowerBudgets
  readonly requirements: TowerRequirements
}

export interface FailedModelsReset {
  readonly cleared: string[]
  readonly nodeId: string
}

/**
 * Every failed tower on this node. Each row already names the node: the budget
 * stamps it when the model goes `failed` (it is in the refusal too), and this
 * report does not re-derive it — one authority for the fact.
 */
export function reportFailedModels(budgets: TowerBudgets): readonly FailedModel[] {
  return [...budgets.image.failed(), ...budgets.text.failed()]
}

/** Every model whose requirements are terminally unmeetable on this node; rows stamped by the gate. */
export function reportFailedRequirements(
  requirements: TowerRequirements,
): readonly EmbeddingFailedRequirement[] {
  return [...requirements.image.failed(), ...requirements.text.failed()]
}

/** The operator's clear (one model, or all) of BOTH terminal states on this node — the result names it. */
export function resetFailedModelsOn(
  nodeId: string,
  towers: EncoderTowers,
  modelId?: string,
): FailedModelsReset {
  const cleared = [
    ...towers.budgets.image.reset(modelId),
    ...towers.budgets.text.reset(modelId),
    ...towers.requirements.image.reset(modelId),
    ...towers.requirements.text.reset(modelId),
  ]
  return { cleared: [...new Set(cleared)], nodeId }
}

/**
 * The cluster row now names `modelId`: a fresh start for THAT model's towers
 * only (D6's second exit from `failed`). The model the row left keeps its
 * state — a rollback to a model that crashed three times must not buy three
 * more spawns nobody asked for, and a search that still names it
 * (`searchObjectEvents({ modelId })`) is refused with the reset hint, as
 * before the flip.
 */
export function clearFailedOnModelChange(
  towers: EncoderTowers,
  modelId: string,
): readonly string[] {
  return [
    ...new Set([
      ...towers.budgets.image.reset(modelId, 'model-change'),
      ...towers.budgets.text.reset(modelId, 'model-change'),
      ...towers.requirements.image.reset(modelId, 'model-change'),
      ...towers.requirements.text.reset(modelId, 'model-change'),
    ]),
  ]
}
