import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { ModelCatalogEntrySchema } from '../types/models.js'
import { MODEL_FORMATS } from '../types/models.js'

/**
 * `model-distributor` — singleton, hub-resident. Pushes a model FORMAT that is
 * already present on the hub's `/data/models` to a target agent node's
 * `/data/models`, sha256-verified, reusing the agent-pull machinery
 * (DeployStageRegistry + the one-time-token bundle route + the agent's
 * `fetchBundleFromHub`). Its provider is built in `server/backend` because it
 * needs the Moleculer broker + the deploy-stage registry, which a forked addon
 * can't reach. `addon-model-studio` drives it via `ctx.api` and owns the
 * per-node availability map.
 *
 * The destination is `targetNodeId`, NOT `nodeId`. Cap routers and the
 * Moleculer tRPC link strip an input field named `nodeId` and use it as a
 * route pin (resolve the provider ON that node). Naming the destination
 * `nodeId` routed the call to the agent — which does not host this
 * singleton — and handed the provider an input with the destination missing.
 */
export const ModelDistributeInputSchema = z.object({
  targetNodeId: z.string(),
  modelId: z.string(),
  format: z.enum(MODEL_FORMATS),
  entry: ModelCatalogEntrySchema,
})

export const ModelDistributeResultSchema = z.object({
  ok: z.boolean(),
  /** sha256 of the staged tarball (empty for a hub-local no-op). */
  sha256: z.string(),
  bytes: z.number(),
  /** The target node's modelsDir the artifact landed in. */
  path: z.string(),
})

export const modelDistributorCapability = {
  name: 'model-distributor',
  scope: 'system',
  mode: 'singleton',
  internal: true,
  methods: {
    distributeModel: method(ModelDistributeInputSchema, ModelDistributeResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type IModelDistributorProvider = InferProvider<typeof modelDistributorCapability>
export type ModelDistributeInput = z.infer<typeof ModelDistributeInputSchema>
export type ModelDistributeResult = z.infer<typeof ModelDistributeResultSchema>
