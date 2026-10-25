/**
 * Test fixture: the cluster model row is KNOWN and equals the catalog defaults.
 *
 * Since D658 a runner refuses a cluster-scoped step until the owner has
 * answered which model the cluster runs; a provider built with no addon
 * context never asks, so every cluster step would be refused. Specs about
 * something else (the capability gate, the node refusal) state the row they
 * assume with this, instead of relying on a default nobody answered.
 */
import { DEFAULT_CLUSTER_STEP_MODELS } from '@camstack/types'
import { vi } from 'vitest'
import { ClusterModelSource } from '../../../shared/cluster-model-source.js'

export function assumeKnownClusterRowIsDefaults(): void {
  vi.spyOn(ClusterModelSource.prototype, 'current').mockReturnValue(DEFAULT_CLUSTER_STEP_MODELS)
  vi.spyOn(ClusterModelSource.prototype, 'unknownSteps').mockReturnValue(new Map())
}
