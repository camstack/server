/**
 * `model_studio_import` — finish importing a model that Model Studio already
 * holds: convert the engine formats it is missing (OpenVINO / Core ML from the
 * ONNX) and push every declared format to every online agent.
 *
 * What it is NOT: a way to get a bundle from this machine onto the hub.
 * `custom-model-registry.importModelBundle` takes its tar over a same-host
 * peer-bytes ticket (D806, D613) that only an addon on the hub can mint, and a
 * path handed across a trust boundary was rejected there on purpose. So the
 * bytes arrive by the trainer's own return flow or the Model Studio upload, and
 * this tool is the gated, described second half. It converts and copies
 * hundreds of MB to every agent: a cluster mutation, behind the gate.
 */
import { z } from 'zod'
import type { OpsHub, OpsMutator } from '../ops/hub.js'
import { toToolOutput } from '../ops/redact.js'
import { parseWire } from '../ops/wire.js'
import { runGated, type GatedResult, type MutationGate } from '../mutations/gate.js'

export interface StudioImportArgs {
  modelId: string
}

export const StudioImportArgsSchema: z.ZodType<StudioImportArgs> = z.object({
  modelId: z.string().min(1).max(200),
})

const ModelsSchema = z.array(
  z.looseObject({
    stepId: z.string(),
    entry: z.looseObject({
      id: z.string(),
      name: z.string().optional(),
      formats: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
)

const DirectorySchema = z.looseObject({
  nodes: z.array(z.looseObject({ id: z.string(), isOnline: z.boolean().optional() })),
})

const ActionResultSchema = z.looseObject({
  conversions: z.array(z.looseObject({ format: z.string(), ok: z.boolean() })).optional(),
  distributed: z
    .array(z.looseObject({ nodeId: z.string(), format: z.string(), ok: z.boolean() }))
    .optional(),
})

const LIST_PATH = 'customModelRegistry.listModels'
const DIRECTORY_PATH = 'nodes.directory'
const ACTION_PATH = 'addons.custom'

export interface StudioImportDeps {
  readonly gate: MutationGate
  readonly hub: () => OpsHub
  readonly mutator: () => OpsMutator
}

export function modelStudioImport(
  deps: StudioImportDeps,
  args: StudioImportArgs,
  confirmToken: string | undefined,
): Promise<GatedResult> {
  return runGated(
    deps.gate,
    {
      tool: 'model_studio_import',
      dryRun: async (a: StudioImportArgs) => {
        const models = parseWire(ModelsSchema, await deps.hub().query(LIST_PATH), LIST_PATH)
        const found = models.find((m) => m.entry.id === a.modelId)
        if (!found) {
          return {
            confirmable: false,
            describe: {
              modelId: a.modelId,
              problem:
                'no such model in the custom model registry. The bytes must already be on the hub (trainer return flow or Model Studio upload); this tool does not upload.',
              registered: models.map((m) => m.entry.id).slice(0, 50),
            },
          }
        }
        const directory = parseWire(
          DirectorySchema,
          await deps.hub().query(DIRECTORY_PATH),
          DIRECTORY_PATH,
        )
        const online = directory.nodes.filter((n) => n.isOnline === true).map((n) => n.id)
        return {
          confirmable: true,
          describe: toToolOutput({
            modelId: a.modelId,
            stepId: found.stepId,
            declaredFormats: Object.keys(found.entry.formats ?? {}),
            wouldCall: `${ACTION_PATH} model-studio.ensureFormatsThenDistribute`,
            effect:
              'converts missing OpenVINO / Core ML formats on the hub, then copies every declared format to each online agent (hub skipped). Disk and network on every node.',
            onlineNodes: online,
          }),
        }
      },
      execute: async (a: StudioImportArgs) => {
        const raw = await deps.mutator().mutate(ACTION_PATH, {
          addonId: 'model-studio',
          action: 'ensureFormatsThenDistribute',
          input: { modelId: a.modelId },
        })
        return toToolOutput(parseWire(ActionResultSchema, raw, ACTION_PATH))
      },
    },
    args,
    confirmToken,
  )
}
