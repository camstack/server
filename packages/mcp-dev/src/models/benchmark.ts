/**
 * `benchmark_run` / `benchmark_status`.
 *
 * A node benchmark is a LOAD TEST: the hub drains the node, moves its cameras
 * elsewhere, ramps inference until a threshold trips, then restores. Load
 * tests have taken this cluster down, so the run goes through the mutation
 * gate (dry run → single-use token → execute) and the dry run is the hub's own
 * read-only preflight: it says which cameras would move, what the headroom is
 * and whether the hub itself would refuse. Bounds below keep one call small.
 */
import { z } from 'zod'
import type { OpsHub, OpsMutator } from '../ops/hub.js'
import { toToolOutput } from '@camstack/develop'
import { parseWire } from '../ops/wire.js'
import { runGated, type GatedResult, type MutationGate } from '@camstack/develop'

export const BENCHMARK_MAX_BUDGET_MINUTES = 60
export const BENCHMARK_MAX_FPS = 30

export interface BenchmarkDevicePlan {
  deviceKey: string
  modelIds: string[]
}

export interface BenchmarkPlan {
  nodeId: string
  devices: BenchmarkDevicePlan[]
  phases?: ('device' | 'pipeline')[]
  steps?: string[]
  fpsPerStream?: number
  budgetMinutes?: number
  keepDownloadedModels?: boolean
  acceptInsufficientHeadroom?: boolean
}

export const BenchmarkPlanSchema: z.ZodType<BenchmarkPlan> = z.object({
  nodeId: z.string().min(1),
  devices: z
    .array(
      z.object({
        deviceKey: z.string().min(1),
        modelIds: z.array(z.string().min(1)).min(1).max(8),
      }),
    )
    .min(1)
    .max(4),
  phases: z
    .array(z.enum(['device', 'pipeline']))
    .min(1)
    .optional(),
  steps: z.array(z.string()).max(16).optional(),
  fpsPerStream: z.number().int().positive().max(BENCHMARK_MAX_FPS).optional(),
  budgetMinutes: z.number().int().positive().max(BENCHMARK_MAX_BUDGET_MINUTES).optional(),
  keepDownloadedModels: z.boolean().optional(),
  acceptInsufficientHeadroom: z.boolean().optional(),
})

const PreflightSchema = z.looseObject({
  canStart: z.boolean(),
  online: z.boolean().optional(),
  estimatedDurationMs: z.number().optional(),
  budgetMs: z.number().optional(),
  moving: z.array(z.looseObject({ deviceId: z.number() })).optional(),
  staying: z.array(z.looseObject({ deviceId: z.number() })).optional(),
  headroom: z.looseObject({}).optional(),
  refusals: z
    .array(
      z.looseObject({
        kind: z.string(),
        detail: z.string(),
        overridable: z.boolean().optional(),
      }),
    )
    .optional(),
})

const StartResultSchema = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('started'), runId: z.string() }),
  z.looseObject({ kind: z.literal('refused'), preflight: PreflightSchema }),
])

const STATUS_PATH = 'pipelineOrchestrator.getNodeBenchmarkStatus'
const PREFLIGHT_PATH = 'pipelineOrchestrator.getNodeBenchmarkPreflight'
const START_PATH = 'pipelineOrchestrator.startNodeBenchmark'

export const BENCHMARK_WARNING =
  'A node benchmark is a LOAD TEST. The hub drains the node and moves its cameras to other nodes for the duration, then restores them. Only confirm when the operator has agreed to this run right now.'

export interface BenchmarkDeps {
  readonly gate: MutationGate
  /** Read-only: the dry run and the status poll. */
  readonly hub: () => OpsHub
  /** The mutation doorway; only dereferenced on a confirmed call. */
  readonly mutator: () => OpsMutator
}

export function benchmarkRun(
  deps: BenchmarkDeps,
  plan: BenchmarkPlan,
  confirmToken: string | undefined,
): Promise<GatedResult> {
  return runGated(
    deps.gate,
    {
      tool: 'benchmark_run',
      dryRun: async (args: BenchmarkPlan) => {
        const raw = await deps.hub().query(PREFLIGHT_PATH, args)
        const preflight = parseWire(PreflightSchema, raw, PREFLIGHT_PATH)
        return {
          confirmable: preflight.canStart,
          describe: toToolOutput({
            warning: BENCHMARK_WARNING,
            wouldCall: START_PATH,
            plan: args,
            preflight,
          }),
        }
      },
      execute: async (args: BenchmarkPlan) => {
        const raw = await deps.mutator().mutate(START_PATH, args)
        const started = parseWire(StartResultSchema, raw, START_PATH)
        if (started.kind === 'refused') {
          return toToolOutput({
            started: false,
            note: 'the hub refused at start (state changed since the dry run)',
            preflight: started.preflight,
          })
        }
        return {
          started: true,
          runId: started.runId,
          next: 'Poll benchmark_status until the run is done, failed or aborted. It restores the node itself; the budget bounds it.',
        }
      },
    },
    plan,
    confirmToken,
  )
}

/** Read-only: the run in flight (or the last one) and its progress. */
export async function benchmarkStatus(hub: OpsHub): Promise<unknown> {
  return toToolOutput(await hub.query(STATUS_PATH))
}
