/**
 * `ops_update_apply`: bring the whole cluster up to date. The sequence itself
 * runs ON THE HUB (`clusterUpdate.startClusterUpdate`, planning#493) — backup,
 * the hub's server closure, each online agent verified (target, settled,
 * capabilities registered), then the addons — the same job the admin UI's
 * "Update all" starts. This tool previews it, starts it, follows it to the end
 * by its job id, and then updates the CLI itself, last, only when the cluster
 * job succeeded.
 *
 * Preview first, then the confirm token (the mutation gate). A wrapper update
 * (image / app) is reported with instructions and never performed. Every wait
 * is bounded; an expiring timer is a failure to report, never a loop.
 */
import {
  runGated,
  type DryRunOutcome,
  type GatedResult,
  type GatedToolSpec,
  type HubClient,
} from '@camstack/develop'
import {
  ClusterUpdateJobSchema,
  ClusterUpdatePlanSchema,
  StartClusterUpdateResultSchema,
  type ClusterUpdateJob,
  type ClusterUpdateOptions,
  type ClusterUpdatePlan,
} from '@camstack/types'
import type { McpContext } from './context.js'
import { noSessionResult, readQuery, reasonOf, type NoSessionResult } from './ops-hub.js'
import { readNodeStatus, readTopology, wrapperVerdict } from './ops-update-model.js'
import {
  cliVerdict,
  runCommand,
  type CliVersionVerdict,
  type RunCommand,
} from './ops-update-cli.js'

export const UPDATE_APPLY_TOOL = 'ops_update_apply'

export interface UpdateApplyArgs {
  /** Explicit server target; omitted = the hub's latest registry check. */
  readonly version?: string
  /** Update addons too (default true). */
  readonly addons?: boolean
  /** Back up before anything moves (default true). */
  readonly backup?: boolean
  /** Update the CLI itself last (default true). */
  readonly cli?: boolean
}

export interface UpdateApplyDeps {
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly pollMs?: number
  /** How long the MCP follows the hub's job before reporting it unfinished. */
  readonly jobTimeoutMs?: number
  readonly runCommand?: RunCommand
  readonly entryPath?: string
}

/** How the job is followed; shared with `camstack cluster-update`. */
export interface FollowTiming {
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  readonly pollMs: number
  readonly jobTimeoutMs: number
  /** Every job read, as it arrives (the terminal command prints progress). */
  readonly onJob?: (job: ClusterUpdateJob) => void
}

export function timing(deps: UpdateApplyDeps): FollowTiming {
  return {
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now ?? Date.now,
    pollMs: deps.pollMs ?? 10_000,
    // Backup + the hub + up to 30 min per agent + addons: hours, not minutes.
    jobTimeoutMs: deps.jobTimeoutMs ?? 6 * 60 * 60_000,
  }
}

export function hubOptions(args: UpdateApplyArgs): ClusterUpdateOptions {
  return {
    ...(args.version !== undefined ? { version: args.version } : {}),
    ...(args.addons !== undefined ? { addons: args.addons } : {}),
    ...(args.backup !== undefined ? { backup: args.backup } : {}),
  }
}

/** A hub older than the cluster-update cap answers "No procedure found". */
export function hubTooOld(reason: string): string | null {
  return /no procedure found/i.test(reason)
    ? 'this hub predates the one-job cluster update (clusterUpdate.*): update the hub first (`serverManagement.applyServerUpdate`), then run this again'
    : null
}

// ---------------------------------------------------------------------------
// the preview: the hub's plan, the wrapper report, the CLI verdict

interface WrapperRow {
  readonly nodeId: string
  readonly kind: string | null
  readonly from: string | null
  readonly to: string | null
  readonly instructions: readonly string[]
}

/** Image / app shells behind: reported with instructions, never performed. */
async function wrapperReport(client: HubClient): Promise<readonly WrapperRow[]> {
  const topology = await readTopology(client)
  if (!topology.ok) return []
  const rows: WrapperRow[] = []
  for (const node of topology.value) {
    if (!node.isOnline) continue
    const status = await readNodeStatus(client, node)
    if (!status.ok) continue
    const w = wrapperVerdict(status.value)
    if (w.behind !== true) continue
    rows.push({
      nodeId: node.id,
      kind: w.kind,
      from: w.from,
      to: w.to,
      instructions: w.instructions,
    })
  }
  return rows
}

type PlanRead =
  | {
      readonly ok: true
      readonly plan: ClusterUpdatePlan
      readonly cli: CliVersionVerdict | null
      readonly wrappers: readonly WrapperRow[]
    }
  | { readonly ok: false; readonly problem: string }

async function readPlan(
  client: HubClient,
  args: UpdateApplyArgs,
  ctx: McpContext,
  deps: UpdateApplyDeps,
): Promise<PlanRead> {
  const plan = await readQuery(
    client,
    'clusterUpdate.previewClusterUpdate',
    hubOptions(args),
    ClusterUpdatePlanSchema,
  )
  if (!plan.ok) return { ok: false, problem: hubTooOld(plan.reason) ?? plan.reason }
  const cli =
    args.cli === false
      ? null
      : await cliVerdict(ctx.cliVersion, ctx.fetch, deps.entryPath ?? process.argv[1] ?? '')
  return { ok: true, plan: plan.value, cli, wrappers: await wrapperReport(client) }
}

// ---------------------------------------------------------------------------
// the run: start the hub's job, follow it, then the CLI

export interface StepResult {
  readonly step: 'backup' | 'hub-server' | 'agent-server' | 'addons' | 'cli'
  readonly nodeId?: string
  readonly status: 'ok' | 'failed' | 'unverified' | 'instructions' | 'skipped'
  readonly detail: string
}

type Follow =
  | { readonly ok: true; readonly job: ClusterUpdateJob }
  | { readonly ok: false; readonly why: string; readonly last: ClusterUpdateJob | null }

/**
 * Poll the job until it ends. The hub restarts in the middle of it, so a
 * failed read is another attempt, never an outcome.
 */
async function followJob(client: HubClient, jobId: string, t: FollowTiming): Promise<Follow> {
  const deadline = t.now() + t.jobTimeoutMs
  let last: ClusterUpdateJob | null = null
  let lastProblem = 'not read yet'
  for (;;) {
    const read = await readQuery(
      client,
      'clusterUpdate.getClusterUpdateJob',
      { jobId },
      ClusterUpdateJobSchema.nullable(),
    )
    if (read.ok && read.value !== null) {
      last = read.value
      t.onJob?.(last)
      if (last.state !== 'running') return { ok: true, job: last }
    } else {
      lastProblem = read.ok ? `job ${jobId} unknown to the hub` : read.reason
    }
    if (t.now() >= deadline) {
      return {
        ok: false,
        why: `job ${jobId} still running after ${Math.round(t.jobTimeoutMs / 60_000)} min (last read: ${last?.state ?? lastProblem}); it goes on on the hub — follow it with clusterUpdate.getClusterUpdateJob`,
        last,
      }
    }
    await t.sleep(t.pollMs)
  }
}

function jobSteps(job: ClusterUpdateJob | null): StepResult[] {
  if (job === null) return []
  return job.steps.map((s) => ({
    step: s.kind,
    ...(s.nodeId !== undefined ? { nodeId: s.nodeId } : {}),
    status: s.status === 'pending' || s.status === 'running' ? 'unverified' : s.status,
    detail: s.reason !== undefined ? `${s.reason}: ${s.detail}` : s.detail,
  }))
}

async function applyCli(cli: CliVersionVerdict, run: RunCommand): Promise<StepResult> {
  const restart =
    'Restart the MCP server in your client to load the new version; a running stdio MCP cannot swap itself.'
  if (cli.install.command === null) {
    return { step: 'cli', status: 'instructions', detail: `${cli.install.instructions} ${restart}` }
  }
  const [file, ...rest] = cli.install.command
  const result = await run(file ?? '', rest)
  if (!result.ok) {
    return {
      step: 'cli',
      status: 'failed',
      detail: `\`${cli.install.command.join(' ')}\` failed: ${result.output}`,
    }
  }
  return {
    step: 'cli',
    status: 'ok',
    detail: `ran \`${cli.install.command.join(' ')}\` (${cli.installed} to ${cli.latest ?? 'latest'}). ${restart}`,
  }
}

export interface ClusterRun {
  readonly steps: StepResult[]
  readonly jobId: string | null
  readonly problem: string | null
  /** The job was started and is still running on the hub: not a failure yet. */
  readonly unfinished: boolean
}

export async function runClusterJob(
  client: HubClient,
  args: UpdateApplyArgs,
  t: FollowTiming,
): Promise<ClusterRun> {
  let raw: unknown
  try {
    raw = await client.call('POST', 'clusterUpdate.startClusterUpdate', hubOptions(args))
  } catch (err) {
    const reason = reasonOf(err)
    return {
      steps: [],
      jobId: null,
      problem: hubTooOld(reason) ?? `start failed: ${reason}`,
      unfinished: false,
    }
  }
  const started = StartClusterUpdateResultSchema.safeParse(raw)
  if (!started.success) {
    return { steps: [], jobId: null, problem: 'unrecognised start answer', unfinished: false }
  }
  if (!started.data.accepted || started.data.jobId === null) {
    return {
      steps: [],
      jobId: started.data.jobId,
      problem: `the hub refused to start (${started.data.blocker ?? 'refused'}): ${started.data.message}`,
      unfinished: false,
    }
  }
  const jobId = started.data.jobId
  const followed = await followJob(client, jobId, t)
  if (!followed.ok) {
    return { steps: jobSteps(followed.last), jobId, problem: followed.why, unfinished: true }
  }
  return { steps: jobSteps(followed.job), jobId, problem: null, unfinished: false }
}

// ---------------------------------------------------------------------------
// the gated spec

export function updateApplySpec(
  client: HubClient,
  ctx: McpContext,
  deps: UpdateApplyDeps = {},
): GatedToolSpec<UpdateApplyArgs> {
  const t = timing(deps)
  return {
    tool: UPDATE_APPLY_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const read = await readPlan(client, args, ctx, deps)
      if (!read.ok) return { confirmable: false, describe: { problem: read.problem } }
      const { plan, cli, wrappers } = read
      const cliNeeded = cli?.updateAvailable === true
      const clusterReady = plan.blocker === null
      const onlyCli = plan.blocker === 'nothing-to-do' && cliNeeded
      if (!clusterReady && !onlyCli) {
        return {
          confirmable: false,
          describe: {
            problem: plan.blockerDetail ?? plan.blocker,
            blocker: plan.blocker,
            target: plan.targetVersion,
            wrapperUpdates: wrappers,
          },
        }
      }
      return {
        confirmable: true,
        describe: {
          action: clusterReady
            ? 'start the hub-side cluster update job and follow it, then update this CLI'
            : 'the cluster is current; update this CLI',
          target: plan.targetVersion,
          order: [
            ...(clusterReady
              ? plan.steps.map((s, i) => ({
                  order: i + 1,
                  step: s.kind,
                  ...(s.nodeId !== undefined ? { nodeId: s.nodeId } : {}),
                  status: s.status,
                  detail: s.detail,
                  ...(s.packages !== undefined && s.packages.length > 0
                    ? { packages: s.packages }
                    : {}),
                }))
              : []),
            ...(cliNeeded && cli
              ? [
                  {
                    step: 'cli',
                    from: cli.installed,
                    to: cli.latest,
                    method: cli.install.method,
                    command: cli.install.command?.join(' ') ?? null,
                    instructions: cli.install.command === null ? cli.install.instructions : null,
                  },
                ]
              : []),
          ],
          skippedOffline: plan.skippedOffline,
          wrapperUpdates: wrappers,
          followTimeoutS: t.jobTimeoutMs / 1000,
          notes: [
            'The job runs ON THE HUB (the same one as the admin UI "Update all"); this tool only follows it.',
            'The hub restarts during its own step: reads fail for a minute or two; that is expected.',
            'A failed step stops the job and names the node and a typed reason; later steps are skipped.',
            'Wrapper (image / app) updates are NEVER performed here; the instructions are listed.',
            ...(cliNeeded
              ? ['The CLI update is the last step; afterwards restart the MCP in your client.']
              : []),
          ],
        },
      }
    },
    async execute(args) {
      const read = await readPlan(client, args, ctx, deps)
      if (!read.ok) return { outcome: 'failed', problem: read.problem, steps: [] }
      const { plan, cli, wrappers } = read
      const cluster: ClusterRun =
        plan.blocker === null
          ? await runClusterJob(client, args, t)
          : { steps: [], jobId: null, problem: null, unfinished: false }
      const results = [...cluster.steps]
      const clusterOk =
        cluster.problem === null &&
        results.every((r) => r.status === 'ok' || r.status === 'skipped')
      if (cli?.updateAvailable === true) {
        results.push(
          clusterOk
            ? await applyCli(cli, deps.runCommand ?? runCommand)
            : {
                step: 'cli',
                status: 'skipped',
                detail: 'not run: the cluster job did not succeed',
              },
        )
      }
      const failed = results.find((r) => r.status === 'failed')
      return {
        outcome:
          failed !== undefined || (cluster.problem !== null && !cluster.unfinished)
            ? 'failed'
            : cluster.problem === null &&
                results.every((r) => r.status === 'ok' || r.status === 'skipped')
              ? 'complete'
              : 'partial',
        target: plan.targetVersion,
        jobId: cluster.jobId,
        steps: results,
        ...(failed !== undefined
          ? { stoppedAt: failed.nodeId ?? failed.step, reason: failed.detail }
          : cluster.problem !== null
            ? { reason: cluster.problem }
            : {}),
        skippedOffline: plan.skippedOffline,
        wrapperUpdates: wrappers,
        mcpRestartNeeded: results.some(
          (r) => r.step === 'cli' && (r.status === 'ok' || r.status === 'instructions'),
        ),
        next: 'Run ops_update_check to confirm; nodes still offline were not touched.',
      }
    },
  }
}

export async function opsUpdateApply(
  ctx: McpContext,
  args: UpdateApplyArgs,
  confirmToken: string | undefined,
  deps: UpdateApplyDeps = {},
): Promise<GatedResult | NoSessionResult | { status: 'refused'; reason: string }> {
  const outcome = await ctx.hub()
  if (!outcome.ok) return noSessionResult(outcome)
  if (outcome.connection.tier !== 'admin') {
    return {
      status: 'refused',
      reason: outcome.connection.adminHint ?? 'this credential is not admin-scoped',
    }
  }
  return runGated(
    ctx.gate,
    updateApplySpec(outcome.connection.client, ctx, deps),
    args,
    confirmToken,
  )
}
