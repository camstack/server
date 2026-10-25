/**
 * The cluster model rule, enforced on the node that has to obey it.
 *
 * ## What is different about a cluster-scoped step
 *
 * For every other step, `resolveModelForFormat` is a kindness: a chosen model
 * with no build for this node's format is quietly swapped for the format's
 * default, one info line, and the camera keeps detecting. That is the right
 * trade when the output is a box, because two nodes producing boxes with two
 * detectors are not producing anything that gets compared.
 *
 * `face-embedding` and `clip-embedding` produce vectors that land in ONE shared
 * index and are ranked against each other by cosine. There the same kindness is
 * corruption: the substituted node writes a second feature space into the index
 * and nothing in the data says so. So for a step whose definition declares
 * `modelScope: 'cluster'` this module replaces the substitution with a
 * **refusal** — the rule `runStatelessStep` already applies to a pinned model
 * ([D54](../../../../docs/decisions/adr-0056.md)), extended to the live detail
 * plane, which is the other writer into the same indexes.
 *
 * ## What "refused" means here, exactly
 *
 * It means **refused to substitute**, not "dropped". The step keeps the pinned
 * model id, and the placement machinery that already exists —
 * `resolveStepsForDispatch`'s node-local engine fallback and the detail plane's
 * `resolveDetailStepDevice` jump — keeps doing its job, both of which key off a
 * step whose model has no build for the candidate format. That is how a
 * `face-embedding` dispatched at a Coral gets rescued onto the node's onnx
 * engine today, and taking that rescue away in the name of safety would stop
 * producing faces on every mixed-accelerator node.
 *
 * What the refusal removes is the LAST resort: after the fallback and the jump,
 * a step whose model this node truly cannot serve fails loudly
 * (`assertStepsRunnable`, D39) instead of quietly running a different encoder.
 *
 * A refusal is COUNTED and logged by the caller, with `tags: { deviceId }`.
 * Silence would read as "never happened" (CLAUDE.md: a branch that drops work
 * logs it).
 */
import {
  type ClusterStepModels,
  type ModelFormat,
  resolveClusterStepModelId,
  type StepDefinition,
} from '@camstack/types'
import { getStepDefinition } from './registry/step-definitions.js'

/** Catalog lookup that answers `null` instead of throwing — injectable for tests. */
export type StepDefinitionLookup = (stepId: string) => StepDefinition | null

const defaultLookup: StepDefinitionLookup = (stepId) => {
  try {
    return getStepDefinition(stepId)
  } catch {
    return null
  }
}

/**
 * What this node may do with one step's model.
 *
 * Three cases, and keeping them apart is the point: `node-scoped` means "not my
 * business, use your normal resolution", which is emphatically not the same as
 * `pinned` with the default — that distinction is what stops the cluster row
 * from silently overriding every per-device model in the fleet.
 */
export type ClusterStepModelVerdict =
  | { readonly kind: 'node-scoped' }
  | { readonly kind: 'pinned'; readonly modelId: string }
  | {
      readonly kind: 'refused'
      readonly modelId: string
      readonly format: ModelFormat
      /** The formats the catalog ships for the PINNED model — the operator's next question. */
      readonly formatsShipped: readonly string[]
    }

/**
 * Decide what `stepId` runs on a node dispatching in `format`.
 *
 * An unknown step is `node-scoped`: a custom addon owns its own format
 * compatibility and this module has no catalog entry to reason about.
 */
export function resolveClusterStepModel(
  stepId: string,
  clusterModels: ClusterStepModels,
  format: ModelFormat,
  lookup: StepDefinitionLookup = defaultLookup,
): ClusterStepModelVerdict {
  const def = lookup(stepId)
  if (def === null || def.modelScope !== 'cluster') return { kind: 'node-scoped' }
  const modelId = resolveClusterStepModelId(stepId, clusterModels)
  if (modelId === null) return { kind: 'node-scoped' }
  const entry = def.models.find((m) => m.id === modelId)
  // A model the catalog does not list is a custom/operator-supplied build: the
  // operator owns its compatibility, exactly as `resolveModelForFormat` does.
  // Refusing here would make a legitimate custom encoder unusable cluster-wide.
  if (entry === undefined) return { kind: 'pinned', modelId }
  if (entry.formats[format] !== undefined) return { kind: 'pinned', modelId }
  return { kind: 'refused', modelId, format, formatsShipped: Object.keys(entry.formats) }
}

/** One step this node will not run, with everything the log line needs. */
export interface ClusterModelRefusal {
  readonly stepId: string
  readonly modelId: string
  readonly format: ModelFormat
  readonly formatsShipped: readonly string[]
}
