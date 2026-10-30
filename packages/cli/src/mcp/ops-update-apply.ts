/**
 * `ops_update_apply`: bring the whole cluster up to date, in order, each step
 * verified. Preview first, then the confirm token (the mutation gate).
 *
 *   1. hub server closure (`applyServerUpdate`), wait until the hub RUNS it
 *   2. each online agent, the same way, by its own nodeId
 *   3. addons: `addons.updatePackage` on the hub; agents follow by
 *      reconciliation, which is verified, never pushed
 *   4. the CLI itself, last, only when the cluster steps succeeded
 *
 * A failed step stops the chain and names the node and the reason. A wrapper
 * update (image / app) is reported with instructions and never performed.
 * Every wait is bounded; an expiring timer is a failure to report, never a loop.
 */
import {
  runGated,
  type DryRunOutcome,
  type GatedResult,
  type GatedToolSpec,
  type HubClient,
} from '@camstack/develop'
import { z } from 'zod'
import type { McpContext } from './context.js'
import { noSessionResult, readQuery, reasonOf, type NoSessionResult } from './ops-hub.js'
import {
  addonDrift,
  AddonUpdateShape,
  capState,
  readInstallations,
  readNodeStatus,
  readTopology,
  ServerActionShape,
  serverVerdict,
  statusInput,
  wrapperVerdict,
  type AddonUpdate,
  type TopologyNode,
  type WrapperVerdict,
} from './ops-update-model.js'
import {
  cliVerdict,
  isOlder,
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
  /** Update the CLI itself last (default true). */
  readonly cli?: boolean
}

export interface UpdateApplyDeps {
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly pollMs?: number
  readonly hubTimeoutMs?: number
  readonly agentTimeoutMs?: number
  readonly addonTimeoutMs?: number
  readonly runCommand?: RunCommand
  readonly entryPath?: string
}

interface Timing {
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  readonly pollMs: number
  readonly hubTimeoutMs: number
  readonly agentTimeoutMs: number
  readonly addonTimeoutMs: number
}

function timing(deps: UpdateApplyDeps): Timing {
  return {
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now ?? Date.now,
    pollMs: deps.pollMs ?? 5_000,
    hubTimeoutMs: deps.hubTimeoutMs ?? 10 * 60_000,
    agentTimeoutMs: deps.agentTimeoutMs ?? 10 * 60_000,
    addonTimeoutMs: deps.addonTimeoutMs ?? 5 * 60_000,
  }
}

// ---------------------------------------------------------------------------
// plan

interface NodePlan {
  readonly node: TopologyNode
  readonly running: string | null
  readonly busy: string | null
  readonly wrapper: WrapperVerdict
}

interface Plan {
  readonly target: string
  readonly hub: NodePlan | null
  readonly agents: readonly NodePlan[]
  readonly offline: readonly string[]
  readonly unreadable: readonly {
    readonly nodeId: string
    readonly reason: string
  }[]
  readonly addons: readonly AddonUpdate[]
  readonly cli: CliVersionVerdict | null
}

type PlanRead =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly problem: string }

function needs(p: NodePlan, target: string, restart: boolean): boolean {
  return restart || (p.running !== null && isOlder(p.running, target))
}

async function readPlan(
  client: HubClient,
  args: UpdateApplyArgs,
  ctx: McpContext,
  deps: UpdateApplyDeps,
): Promise<PlanRead> {
  const topology = await readTopology(client)
  if (!topology.ok) return { ok: false, problem: topology.reason }
  const hubNode = topology.value.find((n) => n.isHub === true)
  if (hubNode === undefined) return { ok: false, problem: 'the topology lists no hub node' }
  const hubStatus = await readNodeStatus(client, hubNode)
  if (!hubStatus.ok) return { ok: false, problem: hubStatus.reason }
  const target = args.version ?? hubStatus.value.latestVersion ?? null
  if (target === null) {
    return {
      ok: false,
      problem:
        'the hub has no registry check yet (latestVersion is null); run a check in the admin UI Cluster page or pass `version`',
    }
  }
  const restartFlags = new Map<string, boolean>()
  const plans: NodePlan[] = []
  const offline: string[] = []
  const unreadable: { nodeId: string; reason: string }[] = []
  for (const node of topology.value) {
    if (!node.isOnline) {
      offline.push(node.id)
      continue
    }
    const status = node.isHub === true ? hubStatus : await readNodeStatus(client, node)
    if (!status.ok) {
      unreadable.push({ nodeId: node.id, reason: status.reason })
      continue
    }
    const v = serverVerdict(status.value)
    restartFlags.set(node.id, v.restartRequired === true)
    plans.push({
      node,
      running: v.running,
      busy: v.updateState !== null && v.updateState !== 'idle' ? v.updateState : null,
      wrapper: wrapperVerdict(status.value),
    })
  }
  const updates =
    args.addons === false
      ? null
      : await readQuery(client, 'addons.listUpdates', {}, z.array(AddonUpdateShape))
  const cli =
    args.cli === false
      ? null
      : await cliVerdict(ctx.cliVersion, ctx.fetch, deps.entryPath ?? process.argv[1] ?? '')
  const hub = plans.find((p) => p.node.isHub === true) ?? null
  return {
    ok: true,
    plan: {
      target,
      hub,
      agents: plans.filter((p) => p.node.isHub !== true),
      offline,
      unreadable,
      addons:
        updates !== null && updates.ok
          ? updates.value.filter((u) => !u.isSystem && u.category === 'addon')
          : [],
      cli,
    },
  }
}

function serverSteps(plan: Plan, restartOf: (p: NodePlan) => boolean): readonly NodePlan[] {
  const out: NodePlan[] = []
  if (plan.hub !== null && needs(plan.hub, plan.target, restartOf(plan.hub))) out.push(plan.hub)
  for (const a of plan.agents) if (needs(a, plan.target, restartOf(a))) out.push(a)
  return out
}

// ---------------------------------------------------------------------------
// steps

export interface StepResult {
  readonly step: 'hub-server' | 'agent-server' | 'addons' | 'cli'
  readonly nodeId?: string
  readonly status: 'ok' | 'failed' | 'unverified' | 'instructions' | 'skipped'
  readonly detail: string
}

type Wait = { readonly ok: true } | { readonly ok: false; readonly why: string }

async function waitUntil(
  t: Timing,
  timeoutMs: number,
  check: () => Promise<string | null>,
): Promise<Wait> {
  const deadline = t.now() + timeoutMs
  let last = 'not checked'
  for (;;) {
    const why = await check()
    if (why === null) return { ok: true }
    last = why
    if (t.now() >= deadline)
      return {
        ok: false,
        why: `timed out after ${Math.round(timeoutMs / 1000)}s: ${last}`,
      }
    await t.sleep(t.pollMs)
  }
}

/** `null` = the node runs the target and registered its capabilities. */
async function nodeReady(
  client: HubClient,
  nodeId: string,
  isHub: boolean,
  target: string,
): Promise<string | null> {
  const status = await readNodeStatus(client, { id: nodeId, isHub })
  if (!status.ok) return `status unreadable (${status.reason})`
  const v = serverVerdict(status.value)
  if (v.running !== target) return `still running ${v.running ?? 'unknown'}, target ${target}`
  if (v.restartRequired === true) return 'restart still required'
  if (v.updateState !== 'idle') return `update state ${v.updateState ?? 'unknown'}`
  const topology = await readTopology(client)
  if (!topology.ok) return `topology unreadable (${topology.reason})`
  const node = topology.value.find((n) => n.id === nodeId)
  if (node === undefined) return 'node absent from the topology'
  if (!node.isOnline) return 'node is not online yet'
  if (capState(node).capless) return 'node is online but registered no capabilities'
  return null
}

async function applyServer(
  client: HubClient,
  p: NodePlan,
  target: string,
  t: Timing,
): Promise<StepResult> {
  const isHub = p.node.isHub === true
  const step = isHub ? ('hub-server' as const) : ('agent-server' as const)
  const nodeId = p.node.id
  let note = ''
  try {
    const raw = await client.call('POST', 'serverManagement.applyServerUpdate', {
      version: target,
      ...statusInput(p.node),
    })
    const parsed = ServerActionShape.safeParse(raw)
    if (parsed.success) {
      const r = parsed.data
      if (
        r.outcome === 'refused' ||
        r.outcome === 'failed' ||
        (r.accepted === false && r.outcome !== 'already-current')
      ) {
        const blockers = (r.blockers ?? []).map((b) => `${b.addonId}: ${b.reason}`).join('; ')
        return {
          step,
          nodeId,
          status: 'failed',
          detail: `${nodeId} refused the update (${r.outcome ?? 'not accepted'}): ${r.reason ?? r.error ?? r.message ?? 'no reason given'}${blockers ? ` [would refuse to start: ${blockers}]` : ''}`,
        }
      }
      note = r.outcome ?? ''
    }
  } catch (err) {
    // A timeout / 502 / 524 is the success path: the node restarts under the request.
    note = `no reply (${reasonOf(err)}); expected while the node restarts`
  }
  const wait = await waitUntil(t, isHub ? t.hubTimeoutMs : t.agentTimeoutMs, () =>
    nodeReady(client, nodeId, isHub, target),
  )
  if (!wait.ok) {
    return {
      step,
      nodeId,
      status: 'failed',
      detail: `${nodeId} did not reach ${target}: ${wait.why}`,
    }
  }
  return {
    step,
    nodeId,
    status: 'ok',
    detail: `${nodeId} runs ${target}, capabilities registered${note ? ` (${note})` : ''}`,
  }
}

async function applyAddons(
  client: HubClient,
  addons: readonly AddonUpdate[],
  t: Timing,
): Promise<readonly StepResult[]> {
  const done: AddonUpdate[] = []
  for (const u of addons) {
    try {
      await client.call('POST', 'addons.updatePackage', {
        name: u.name,
        version: u.latestVersion,
      })
      done.push(u)
    } catch (err) {
      return [
        {
          step: 'addons',
          status: 'failed',
          detail: `hub failed to update ${u.name} to ${u.latestVersion}: ${reasonOf(err)}${done.length > 0 ? `; already updated: ${done.map((d) => d.name).join(', ')}` : ''}`,
        },
      ]
    }
  }
  const names = new Set(done.map((d) => d.name))
  const wait = await waitUntil(t, t.addonTimeoutMs, async () => {
    const inst = await readInstallations(client)
    if (!inst.ok) return `installations unreadable (${inst.reason})`
    for (const u of done) {
      const hub = inst.value.installations.find((i) => i.isHub && i.packageName === u.name)
      if (hub === undefined || hub.version !== u.latestVersion) {
        return `${u.name} is ${hub?.version ?? 'absent'} on the hub, expected ${u.latestVersion}`
      }
    }
    const behind = addonDrift({
      ...inst.value,
      installations: inst.value.installations.filter((i) => names.has(i.packageName) && i.isOnline),
    })
    if (behind.length > 0) {
      return `agents behind the hub: ${behind.map((d) => `${d.nodeId}/${d.packageName}=${d.nodeVersion ?? 'absent'}`).join(', ')}`
    }
    return null
  })
  return [
    {
      step: 'addons',
      status: wait.ok ? 'ok' : 'unverified',
      detail: wait.ok
        ? `${done.length} addon(s) updated on the hub and matched on every online agent`
        : `${done.length} addon(s) updated on the hub; verification: ${wait.why}`,
    },
  ]
}

async function applyCli(cli: CliVersionVerdict, run: RunCommand): Promise<StepResult> {
  const restart =
    'Restart the MCP server in your client to load the new version; a running stdio MCP cannot swap itself.'
  if (cli.install.command === null) {
    return {
      step: 'cli',
      status: 'instructions',
      detail: `${cli.install.instructions} ${restart}`,
    }
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
      const plan = read.plan
      const steps = serverSteps(plan, () => false)
      const busy = [plan.hub, ...plan.agents].filter(
        (p): p is NodePlan => p !== null && p.busy !== null,
      )
      if (busy.length > 0) {
        return {
          confirmable: false,
          describe: {
            problem: `a node is mid-update: ${busy.map((p) => `${p.node.id} (${p.busy})`).join(', ')}; wait for it to settle`,
          },
        }
      }
      const cliNeeded = plan.cli?.updateAvailable === true
      if (steps.length === 0 && plan.addons.length === 0 && !cliNeeded) {
        return {
          confirmable: false,
          describe: {
            problem:
              'nothing to apply: every online node runs the target, no addon update is pending and the CLI is current',
            target: plan.target,
            wrapperUpdates: wrapperReport(plan),
          },
        }
      }
      return {
        confirmable: true,
        describe: {
          action: 'update the cluster, in this order, verifying each step',
          target: plan.target,
          order: [
            ...steps.map((p, i) => ({
              order: i + 1,
              step: p.node.isHub === true ? 'hub-server' : 'agent-server',
              nodeId: p.node.id,
              from: p.running,
              to: plan.target,
            })),
            ...(args.addons === false
              ? []
              : [
                  {
                    step: 'addons',
                    packages: plan.addons.map(
                      (a) => `${a.name} ${a.currentVersion} -> ${a.latestVersion}`,
                    ),
                  },
                ]),
            ...(cliNeeded && plan.cli
              ? [
                  {
                    step: 'cli',
                    from: plan.cli.installed,
                    to: plan.cli.latest,
                    method: plan.cli.install.method,
                    command: plan.cli.install.command?.join(' ') ?? null,
                    instructions:
                      plan.cli.install.command === null ? plan.cli.install.instructions : null,
                  },
                ]
              : []),
          ],
          skippedOffline: plan.offline,
          skippedUnreadable: plan.unreadable,
          wrapperUpdates: wrapperReport(plan),
          timeouts: {
            hubS: t.hubTimeoutMs / 1000,
            agentS: t.agentTimeoutMs / 1000,
            addonsS: t.addonTimeoutMs / 1000,
          },
          notes: [
            'The hub restarts during step 1: this connection drops for a minute or two; that is expected.',
            'A failed step stops the chain and says which node and why; addons are not touched if a server step failed.',
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
      const plan = read.plan
      const results: StepResult[] = []
      const ok = (): boolean => results.every((r) => r.status === 'ok' || r.status === 'skipped')
      // Hub first; agents only after the hub RUNS the target.
      for (const p of serverSteps(plan, () => false)) {
        if (!ok()) break
        results.push(await applyServer(client, p, plan.target, t))
      }
      const serverOk = ok()
      if (serverOk && args.addons !== false && plan.addons.length > 0) {
        results.push(...(await applyAddons(client, plan.addons, t)))
      }
      const clusterOk = results.every((r) => r.status === 'ok')
      if (clusterOk && plan.cli?.updateAvailable === true) {
        results.push(await applyCli(plan.cli, deps.runCommand ?? runCommand))
      } else if (plan.cli?.updateAvailable === true) {
        results.push({
          step: 'cli',
          status: 'skipped',
          detail: 'not run: a cluster step did not succeed',
        })
      }
      const failed = results.find((r) => r.status === 'failed')
      return {
        outcome: failed
          ? 'failed'
          : results.every((r) => r.status === 'ok')
            ? 'complete'
            : 'partial',
        target: plan.target,
        steps: results,
        ...(failed ? { stoppedAt: failed.nodeId ?? failed.step, reason: failed.detail } : {}),
        skippedOffline: plan.offline,
        wrapperUpdates: wrapperReport(plan),
        mcpRestartNeeded: results.some(
          (r) => r.step === 'cli' && (r.status === 'ok' || r.status === 'instructions'),
        ),
        next: 'Run ops_update_check to confirm; nodes still offline were not touched.',
      }
    },
  }
}

function wrapperReport(plan: Plan): readonly {
  nodeId: string
  kind: string | null
  from: string | null
  to: string | null
  instructions: readonly string[]
}[] {
  return [plan.hub, ...plan.agents]
    .filter((p): p is NodePlan => p !== null && p.wrapper.behind === true)
    .map((p) => ({
      nodeId: p.node.id,
      kind: p.wrapper.kind,
      from: p.wrapper.from,
      to: p.wrapper.to,
      instructions: p.wrapper.instructions,
    }))
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
