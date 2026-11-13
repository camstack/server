import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { NOT_A_DEVICE } from '../device/cap-vocabulary/system-reasons.js'

/**
 * cluster-update — the ONE flow that brings the whole cluster to a release
 * (planning#493). Hub-provided (`server-provided`), hub-only: the hub runs
 * the sequence itself, so the admin UI, the MCP and the CLI all start the same
 * job and read the same report instead of each driving their own loop.
 *
 *   1. backup (`backup.trigger`) — skipped only when the caller says so
 *   2. the hub's server closure (`applyServerUpdate`); the hub restarts and the
 *      job RESUMES on the new boot, verified against the hub's running version
 *   3. every online agent behind the target, one at a time, verified: runs the
 *      target, settled, online, and its capabilities registered (D848) — an
 *      agent that comes back capless is a FAILED step, never a done one
 *   4. every stale addon on the hub (`addons.updatePackage`); agents follow by
 *      reconciliation, which is verified, never pushed
 *
 * The job stops on the first failed step with a typed reason (D877). Its state
 * is durable on the hub and read by RPC (`getClusterUpdateJob`) — events are
 * telemetry and never carry it (D8, D11).
 */

/** The steps, in the order they run. */
const ClusterUpdateStepKindSchema = z.enum(['backup', 'hub-server', 'agent-server', 'addons'])

/**
 * - `pending`  — not reached yet.
 * - `running`  — in progress (for `hub-server`: possibly across the restart).
 * - `ok`       — done AND verified.
 * - `failed`   — did not land; `reason` + `detail` say why. Stops the job.
 * - `skipped`  — not run: nothing to do, opted out, the node is offline, or a
 *                step before it failed. `detail` says which.
 */
const ClusterUpdateStepStatusSchema = z.enum(['pending', 'running', 'ok', 'failed', 'skipped'])

/**
 * Why a step (and with it the job) failed. Stable, greppable; `detail` carries
 * the prose.
 */
const ClusterUpdateFailureReasonSchema = z.enum([
  /** No `backup` provider answered (and the caller did not opt out). */
  'backup-unavailable',
  /** The backup ran and did not land at any destination. */
  'backup-failed',
  /** The node answered `refused` / `failed` to `applyServerUpdate`. */
  'server-refused',
  /** The node never reached the target within the bound. */
  'server-not-on-target',
  /** The node runs the target but registered no capabilities (the 1.2.826 case). */
  'node-capless',
  /** The node's status could not be read. */
  'status-unreadable',
  /** `addons.updatePackage` failed on the hub. */
  'addon-update-failed',
  /** The hub updated the addons, the agents did not converge within the bound. */
  'addons-not-converged',
  /** The hub restarted while a step other than its own update was running. */
  'interrupted',
  /** `applyServerUpdate` cut a server install that stopped making progress. */
  'timeout-stall',
  /** `applyServerUpdate` cut a server install at its hard time limit. */
  'timeout-ceiling',
])

const ClusterUpdateStepSchema = z.object({
  kind: ClusterUpdateStepKindSchema,
  /** The node the step acts on; absent for `backup` and `addons`. */
  nodeId: z.string().optional(),
  status: ClusterUpdateStepStatusSchema,
  /** One line for the operator: what happened, or why not. */
  detail: z.string(),
  reason: ClusterUpdateFailureReasonSchema.optional(),
  /** `hub-server` / `agent-server`: the version the node ran before. */
  fromVersion: z.string().nullable().optional(),
  /** `addons`: the packages this step updates, `name from -> to`. */
  packages: z.array(z.string()).readonly().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
})

const ClusterUpdateJobStateSchema = z.enum(['running', 'succeeded', 'failed'])

const ClusterUpdateJobSchema = z.object({
  id: z.string(),
  state: ClusterUpdateJobStateSchema,
  /** The server version every node is brought to. */
  targetVersion: z.string(),
  /** Who started it (the user name, or `system`). */
  requestedBy: z.string(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  /** Every step, in run order; later steps stay `pending` while it runs. */
  steps: z.array(ClusterUpdateStepSchema).readonly(),
  /** On `failed`: the step that stopped it (`nodeId` or the step kind). */
  stoppedAt: z.string().optional(),
  reason: ClusterUpdateFailureReasonSchema.optional(),
  /** Agents offline when the plan was read: never touched. */
  skippedOffline: z.array(z.string()).readonly(),
})

const ClusterUpdateOptionsSchema = z.object({
  /** Explicit server target; omitted = the hub's latest registry check. */
  version: z.string().optional(),
  /** Update the addons too (default true). */
  addons: z.boolean().optional(),
  /**
   * Back up before touching anything (default true). `false` is an explicit
   * operator opt-out; a missing backup provider is otherwise a failure.
   */
  backup: z.boolean().optional(),
})

/** Why a plan cannot start. */
const ClusterUpdateBlockerSchema = z.enum([
  /** The hub has no registry check yet and no `version` was given. */
  'no-target',
  /** A node is mid-update (`staging` / `pending-restart`). */
  'node-busy',
  /** Another cluster update job is running. */
  'job-running',
  /** Every online node runs the target and no addon update is pending. */
  'nothing-to-do',
  /** The hub's own status could not be read. */
  'status-unreadable',
])

const ClusterUpdatePlanSchema = z.object({
  /** `null` when no target could be resolved (`blocker: 'no-target'`). */
  targetVersion: z.string().nullable(),
  /** The steps the job WOULD run, all `pending` (or `skipped` with a reason). */
  steps: z.array(ClusterUpdateStepSchema).readonly(),
  skippedOffline: z.array(z.string()).readonly(),
  /** `null` = the plan can start. */
  blocker: ClusterUpdateBlockerSchema.nullable(),
  /** Prose for `blocker`. */
  blockerDetail: z.string().nullable(),
})

const StartClusterUpdateResultSchema = z.object({
  accepted: z.boolean(),
  /** The job to follow with `getClusterUpdateJob`; `null` when refused. */
  jobId: z.string().nullable(),
  blocker: ClusterUpdateBlockerSchema.nullable(),
  message: z.string(),
})

export const clusterUpdateCapability = {
  name: 'cluster-update',
  scope: 'system',
  mode: 'singleton',
  methods: {
    /** What `startClusterUpdate` would do now, and whether it can start. Reads only. */
    previewClusterUpdate: method(ClusterUpdateOptionsSchema, ClusterUpdatePlanSchema, {
      auth: 'admin',
    }),
    /**
     * Start the job and return at once with its id; the job runs on the hub
     * (minutes to hours, across the hub's own restart). Refused, with a
     * `blocker`, when the plan cannot start — one job at a time.
     */
    startClusterUpdate: method(ClusterUpdateOptionsSchema, StartClusterUpdateResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * A job's state. Without `jobId`: the latest job, or `null` when none ever
     * ran. Survives the hub restart the job itself causes.
     */
    getClusterUpdateJob: method(
      z.object({ jobId: z.string().optional() }),
      ClusterUpdateJobSchema.nullable(),
      { auth: 'admin' },
    ),
  },
  mount: { kind: 'server-provided' },
  vocabulary: { notOperatorFacing: NOT_A_DEVICE.CLUSTER },
} as const satisfies CapabilityDefinition

export type IClusterUpdateProvider = InferProvider<typeof clusterUpdateCapability>

export type ClusterUpdateStepKind = z.infer<typeof ClusterUpdateStepKindSchema>
export type ClusterUpdateStepStatus = z.infer<typeof ClusterUpdateStepStatusSchema>
export type ClusterUpdateFailureReason = z.infer<typeof ClusterUpdateFailureReasonSchema>
export type ClusterUpdateStep = z.infer<typeof ClusterUpdateStepSchema>
export type ClusterUpdateJobState = z.infer<typeof ClusterUpdateJobStateSchema>
export type ClusterUpdateJob = z.infer<typeof ClusterUpdateJobSchema>
export type ClusterUpdateOptions = z.infer<typeof ClusterUpdateOptionsSchema>
export type ClusterUpdateBlocker = z.infer<typeof ClusterUpdateBlockerSchema>
export type ClusterUpdatePlan = z.infer<typeof ClusterUpdatePlanSchema>
export type StartClusterUpdateResult = z.infer<typeof StartClusterUpdateResultSchema>

export {
  ClusterUpdateStepKindSchema,
  ClusterUpdateStepStatusSchema,
  ClusterUpdateFailureReasonSchema,
  ClusterUpdateStepSchema,
  ClusterUpdateJobStateSchema,
  ClusterUpdateJobSchema,
  ClusterUpdateOptionsSchema,
  ClusterUpdateBlockerSchema,
  ClusterUpdatePlanSchema,
  StartClusterUpdateResultSchema,
}
