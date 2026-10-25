/**
 * Record kinds owned by the pipeline-orchestrator addon (records plan phase 2,
 * steps 12-15).
 *
 * Each kind replaced the legacy `pipeline-orchestrator:*` collection of the
 * same name; the records migration that copied them is closed (D900). Declared
 * only on the hub (the addon runs hub-only). The addon declares no `execution.group`, so the hub owner
 * stamp is the addon id (`pipeline-orchestrator`).
 */
import { z } from 'zod'
import {
  defineRecordKinds,
  NodeBenchmarkManifestSchema,
  NodeBenchmarkResultSchema,
  NodeBenchmarkRunSchema,
} from '@camstack/types'

/** Legacy collection name — kept for adoption mapper and docs. */
export const NODE_STRESS_MOVES_COLLECTION = 'pipeline-orchestrator:node-stress-moves'
/** Legacy collection name — kept for adoption mapper and docs. */
export const NODE_BENCHMARK_MODE_COLLECTION = 'pipeline-orchestrator:node-benchmark-mode'
/** Legacy collection name — kept for adoption mapper and docs. */
export const NODE_BENCHMARK_RUNS_COLLECTION = 'pipeline-orchestrator:node-benchmark-runs'
/** Legacy collection name — kept for adoption mapper and docs. */
export const NODE_BENCHMARK_RESULTS_COLLECTION = 'pipeline-orchestrator:node-benchmarks'

/** Body of one APPLIED failover move. The record id is `${deviceId}:${at}`. */
export const NodeStressMoveBodySchema = z.object({
  deviceId: z.number(),
  /** The node the camera LEFT — the return ban is about coming back here. */
  fromNodeId: z.string().min(1),
  /** Wall-clock ms when the move was applied. Also the record's `at` field. */
  at: z.number(),
})
export type NodeStressMoveBody = z.infer<typeof NodeStressMoveBodySchema>

export const orchestratorRecordKinds = defineRecordKinds({
  /**
   * One row per APPLIED failover move. The id is `${deviceId}:${at}`.
   * Write-behind: the mirror advances first; a failed persist is logged but
   * never re-thrown (the move has already happened). TTL = 2 h, which is the
   * longest guard window (rate window, device cooldown, return ban combined).
   */
  'node-stress-moves': {
    schema: NodeStressMoveBodySchema,
    class: 'ledger',
    writeTrigger:
      'one row per APPLIED failover move (never per attempt); id = `${deviceId}:${at}`; write-behind',
    device: 'none',
    at: 'required',
    indexes: [{ name: 'device', fields: ['deviceId'] }],
    retention: { ttlMs: 2 * 60 * 60 * 1_000, from: 'at' },
  },

  /**
   * The benchmark manifest: one row (key `active`), written BEFORE benchmark
   * mode changes anything and removed only after the cluster is restored. Its
   * presence at boot with no live run means "restore now".
   */
  'node-benchmark-mode': {
    schema: NodeBenchmarkManifestSchema,
    class: 'config',
    writeTrigger:
      'once when benchmark mode is entered (write-through, BEFORE any change); removed once the cluster is restored',
    device: 'none',
    at: 'none',
    retention: {
      none: 'at most one row (key `active`); its presence means a restore is owed',
    },
  },

  /**
   * One row per benchmark run, rewritten when the run ends. Bounded in
   * application code to the newest 50 runs.
   */
  'node-benchmark-runs': {
    schema: NodeBenchmarkRunSchema,
    class: 'ledger',
    writeTrigger: 'one row per run, rewritten when the run ends',
    device: 'none',
    at: 'required',
    retention: {
      none: 'the newest 50 runs; older rows are removed in application code when a run is recorded',
    },
  },

  /**
   * One row per measured cell, written when its run ends; deleted by the
   * operator. Bounded in application code to the newest 500 results. The live
   * collection name is `node-benchmarks` (not `node-benchmark-results`).
   */
  'node-benchmarks': {
    schema: NodeBenchmarkResultSchema,
    class: 'ledger',
    writeTrigger: 'one row per measured cell, written when its run ends; deleted by the operator',
    device: 'none',
    at: 'required',
    retention: {
      none: 'the newest 500 rows; older rows are removed in application code; a stale row stays listed but no longer beats the table',
    },
  },
})
