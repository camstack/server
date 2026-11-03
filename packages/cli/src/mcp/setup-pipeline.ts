/**
 * `setup_pipeline` (read) and `configure_setup_pipeline` (write): per node the
 * accelerators it offers, per camera where its pipeline runs and what it
 * reports, and a proposal — the hub's own Auto-tune plan (`planAutoTune`), with
 * the `planHash` that names exactly what the apply writes.
 *
 * The apply recomputes the plan and refuses when its hash is not the confirmed
 * one (the hub refuses a stale hash too): what is written is the diff the
 * operator read.
 */
import {
  AutoTuneApplyResultSchema,
  AutoTuneOptionsSchema,
  AutoTunePlanSchema,
  PipelineAssignmentSchema,
  type AutoTuneOptions,
  type AutoTunePlan,
} from '@camstack/types'
import { type DryRunOutcome, type GatedToolSpec, type HubClient } from '@camstack/develop'
import { z } from 'zod'
import { adminGated, type AdminGatedResult } from './configure-common.js'
import type { McpContext } from './context.js'
import { cap, readQuery, withHub, type NoSessionResult, type RefusedResult } from './ops-hub.js'
import { opsAccelerators, type NodeAccelerators } from './ops-accelerators.js'
import { readCameraRows, readCameraStatuses } from './setup-camera-reads.js'
import { adminRefusal } from './setup-assist-common.js'

export const PLACEMENT_LIMIT = 100

export interface CameraPlacement {
  readonly deviceId: number
  readonly name: string | null
  readonly nodeId: string
  readonly pinned: boolean
  readonly reason: string
  readonly detection: {
    readonly engine: string
    readonly phase: string
    readonly configuredFps: number
    readonly actualFps: number
    readonly avgInferenceMs: number
  } | null
}

export interface SetupPipelineResult {
  readonly status: 'ok'
  readonly nodes: readonly NodeAccelerators[]
  readonly placements: readonly CameraPlacement[]
  readonly placementsTruncated: number
  /** Cameras the orchestrator has no assignment for (disabled ones excluded). */
  readonly unassigned: readonly { readonly deviceId: number; readonly name: string }[] | null
  /** `null`: the plan could not be computed — see `unavailable.plan`. */
  readonly proposal: AutoTunePlan | null
  readonly unavailable: { readonly [part: string]: string }
}

export interface SetupPipelineArgs {
  readonly planHash: string
  readonly headroom?: number
  readonly minSessionsPerDevice?: number
}

const optionsOf = (args: Partial<AutoTuneOptions>): AutoTuneOptions =>
  AutoTuneOptionsSchema.parse({
    ...(args.headroom !== undefined ? { headroom: args.headroom } : {}),
    ...(args.minSessionsPerDevice !== undefined
      ? { minSessionsPerDevice: args.minSessionsPerDevice }
      : {}),
  })

export async function setupPipeline(
  ctx: McpContext,
  args: Partial<AutoTuneOptions> = {},
): Promise<SetupPipelineResult | NoSessionResult | RefusedResult> {
  const nodesResult = await opsAccelerators(ctx)
  if (nodesResult.status !== 'ok') return nodesResult
  return withHub(ctx, async (connection): Promise<SetupPipelineResult | RefusedResult> => {
    const refused = adminRefusal(connection, 'pipelineOrchestrator.planAutoTune')
    if (refused) return refused
    const client = connection.client
    const unavailable: { [part: string]: string } = { ...nodesResult.unavailable }
    const [assignments, cameras, statuses, plan] = await Promise.all([
      readQuery(
        client,
        'pipelineOrchestrator.getPipelineAssignments',
        undefined,
        z.array(PipelineAssignmentSchema),
      ),
      readCameraRows(client),
      readCameraStatuses(client),
      readQuery(client, 'pipelineOrchestrator.planAutoTune', optionsOf(args), AutoTunePlanSchema),
    ])
    if (!assignments.ok) unavailable['assignments'] = assignments.reason
    if (!cameras.ok) unavailable['cameras'] = cameras.reason
    if (!statuses.ok) unavailable['status'] = statuses.reason
    if (!plan.ok) unavailable['plan'] = plan.reason
    const nameOf = (id: number): string | null =>
      cameras.ok ? (cameras.value.find((c) => c.id === id)?.name ?? null) : null
    const placed = assignments.ok
      ? assignments.value.map((a): CameraPlacement => {
          const det = statuses.ok ? (statuses.value.get(a.deviceId)?.detection ?? null) : null
          return {
            deviceId: a.deviceId,
            name: nameOf(a.deviceId),
            nodeId: a.agentNodeId,
            pinned: a.pinned,
            reason: a.reason,
            detection: det
              ? {
                  engine: `${det.engine.backend}:${det.engine.device}`,
                  phase: det.phase,
                  configuredFps: det.configuredFps,
                  actualFps: det.actualFps,
                  avgInferenceMs: det.avgInferenceMs,
                }
              : null,
          }
        })
      : []
    const capped = cap(placed, PLACEMENT_LIMIT)
    const assignedIds = new Set(placed.map((p) => p.deviceId))
    return {
      status: 'ok',
      nodes: nodesResult.nodes,
      placements: capped.items,
      placementsTruncated: capped.truncated,
      unassigned:
        assignments.ok && cameras.ok
          ? cameras.value
              .filter((c) => !c.disabled && !assignedIds.has(c.id))
              .map((c) => ({ deviceId: c.id, name: c.name }))
          : null,
      proposal: plan.ok ? plan.value : null,
      unavailable,
    }
  })
}

// ---------------------------------------------------------------------------
// configure_setup_pipeline

export const SETUP_PIPELINE_TOOL = 'configure_setup_pipeline'

export function setupPipelineSpec(client: HubClient): GatedToolSpec<SetupPipelineArgs> {
  return {
    tool: SETUP_PIPELINE_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const plan = await readQuery(
        client,
        'pipelineOrchestrator.planAutoTune',
        optionsOf(args),
        AutoTunePlanSchema,
      )
      if (!plan.ok) return { confirmable: false, describe: { problem: plan.reason } }
      if (plan.value.planHash !== args.planHash) {
        return {
          confirmable: false,
          describe: {
            problem: `the plan changed since setup_pipeline (confirmed ${args.planHash}, now ${plan.value.planHash}); read setup_pipeline again and confirm the new proposal`,
            plan: plan.value,
          },
        }
      }
      return {
        confirmable: plan.value.nodeChanges.length > 0,
        describe: {
          action: 'apply the Auto-tune plan (node model pins; offline nodes are skipped; no undo)',
          planHash: plan.value.planHash,
          nodeChanges: plan.value.nodeChanges,
          warnings: plan.value.warnings,
          ...(plan.value.nodeChanges.length === 0 ? { problem: 'the plan changes nothing' } : {}),
        },
      }
    },
    async execute(args) {
      const raw = await client.call('POST', 'pipelineOrchestrator.applyAutoTune', {
        planHash: args.planHash,
        ...optionsOf(args),
      })
      const parsed = AutoTuneApplyResultSchema.parse(raw)
      if (parsed.kind !== 'applied') {
        throw new Error(`auto-tune was not applied: ${JSON.stringify(parsed)}`)
      }
      return parsed
    },
  }
}

export function setupPipelineApply(
  ctx: McpContext,
  args: SetupPipelineArgs,
  confirmToken: string | undefined,
): Promise<AdminGatedResult> {
  return adminGated(ctx, setupPipelineSpec, args, confirmToken)
}
