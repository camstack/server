/** The `models` toolset: floors, eval, export (all non-mutating) and the two gated mutations. */
import { z } from 'zod'
import { textError, text } from '../text.js'
import type { HubProvider, HubReady, RegisterTool, ToolResult } from '../ops/register.js'
import type { OpsMutator } from '../ops/hub.js'
import { QueryRefusedError } from '../ops/hub.js'
import type { GatedResult, MutationGate } from '../mutations/gate.js'
import { BenchmarkPlanSchema, benchmarkRun, benchmarkStatus } from './benchmark.js'
import { evalModel, EvalArgsSchema, type ProcessRunner } from './eval.js'
import { fetchRetrainExport, FetchExportArgsSchema } from './export.js'
import { modelFloors } from './floors.js'
import { modelStudioImport, StudioImportArgsSchema } from './studio-import.js'
import { objectShape } from '../zod-shape.js'

export interface ModelToolDeps {
  readonly root: () => string
  readonly getHub: HubProvider
  /** Awaited before a tool touches the hub; absent when there is no connection to settle. */
  readonly ready?: HubReady
  /** Dereferenced only on a confirmed call; absent when mutations are off. */
  readonly getMutator: () => OpsMutator
  readonly gate: MutationGate
  readonly run: ProcessRunner
}

function describeError(err: unknown): string {
  if (err instanceof QueryRefusedError) return `refused: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}

async function guardedRun(ready: HubReady, run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    await ready()
    return text(await run())
  } catch (err) {
    return textError(describeError(err))
  }
}

async function guardedGatedRun(
  ready: HubReady,
  run: () => Promise<GatedResult>,
): Promise<ToolResult> {
  try {
    await ready()
    const result = await run()
    return result.status === 'refused' ? textError(result.reason) : text(result)
  } catch (err) {
    return textError(describeError(err))
  }
}

const ConfirmShape = {
  confirm_token: z
    .string()
    .optional()
    .describe('From a previous dry run of this exact call. Omit it to get a dry run.'),
}

export function registerModelTools(tool: RegisterTool, deps: ModelToolDeps): void {
  const ready: HubReady = deps.ready ?? (async () => undefined)
  const guarded = (run: () => Promise<unknown>): Promise<ToolResult> => guardedRun(ready, run)
  const guardedGated = (run: () => Promise<GatedResult>): Promise<ToolResult> =>
    guardedGatedRun(ready, run)
  tool(
    'model_floors',
    'Measured confidence floors of a model (detector or classifier table) with the method and the D739 rule. Local, read-only.',
    { modelId: z.string().min(1) },
    ({ modelId }) => guarded(async () => modelFloors(deps.root(), modelId)),
  )

  tool(
    'fetch_retrain_export',
    'Download the annotated retrain export (admin credential) into scratchpad/retrain-export/. Read-only on the cluster; the hub streams it paced.',
    objectShape(FetchExportArgsSchema),
    (args) => guarded(() => fetchRetrainExport(deps.root(), deps.getHub(), args)),
  )

  tool(
    'eval_model',
    'Evaluate a candidate detector (or N variants) against an annotated export with scripts/eval, CPU only, in scratchpad/eval-venv. Never touches the cluster. Inputs must be inside the workspace; the venv is created only with setupVenv:true.',
    objectShape(EvalArgsSchema),
    (args) => guarded(() => evalModel(deps.root(), EvalArgsSchema.parse(args), { run: deps.run })),
  )

  tool(
    'benchmark_status',
    'The node benchmark in flight (or the last one): state, progress, result ids. Read-only; poll it after benchmark_run.',
    {},
    () => guarded(() => benchmarkStatus(deps.getHub())),
  )

  if (!deps.gate.enabled) return

  tool(
    'benchmark_run',
    'MUTATES THE CLUSTER: a node benchmark is a load test (drains the node, moves its cameras, ramps load). First call = dry run with the hub preflight and a one-shot confirm_token; a second call with the SAME arguments plus the token starts it. Requires --allow-mutations.',
    { ...objectShape(BenchmarkPlanSchema), ...ConfirmShape },
    ({ confirm_token, ...plan }) =>
      guardedGated(() =>
        benchmarkRun(
          { gate: deps.gate, hub: deps.getHub, mutator: deps.getMutator },
          BenchmarkPlanSchema.parse(plan),
          confirm_token,
        ),
      ),
  )

  tool(
    'model_studio_import',
    'MUTATES THE CLUSTER: convert a registered model’s missing engine formats and copy it to every online agent (Model Studio ensureFormatsThenDistribute). Does not upload bytes. First call = dry run + one-shot confirm_token; second call with the SAME arguments plus the token executes. Requires --allow-mutations.',
    { ...objectShape(StudioImportArgsSchema), ...ConfirmShape },
    ({ confirm_token, ...args }) =>
      guardedGated(() =>
        modelStudioImport(
          { gate: deps.gate, hub: deps.getHub, mutator: deps.getMutator },
          StudioImportArgsSchema.parse(args),
          confirm_token,
        ),
      ),
  )
}
