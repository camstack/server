/**
 * `camstack cluster-update` — the terminal face of the ONE cluster update job
 * (planning#493). It previews the hub's plan, asks, starts
 * `clusterUpdate.startClusterUpdate` and follows it by its id until it ends —
 * the same job the admin UI "Update all" and the MCP `ops_update_apply` start.
 * The sequence runs on the hub; this command drives nothing itself.
 */
import { parseArgs } from 'node:util'
import { tryConnectHub, type HubClient } from '@camstack/develop'
import {
  ClusterUpdatePlanSchema,
  type ClusterUpdateJob,
  type ClusterUpdatePlan,
  type ClusterUpdateStep,
} from '@camstack/types'
import { readQuery } from '../mcp/ops-hub.js'
import {
  hubOptions,
  hubTooOld,
  runClusterJob,
  timing,
  type UpdateApplyArgs,
  type UpdateApplyDeps,
} from '../mcp/ops-update-apply.js'

export interface ClusterUpdateCommandDeps extends UpdateApplyDeps {
  readonly print: (line: string) => void
  readonly confirm: (message: string) => Promise<boolean>
}

export interface ClusterUpdateCommandArgs extends UpdateApplyArgs {
  readonly yes?: boolean
}

function stepLine(s: ClusterUpdateStep): string {
  const where = s.nodeId !== undefined ? ` ${s.nodeId}` : ''
  const why = s.reason !== undefined ? ` [${s.reason}]` : ''
  return `  ${s.status.padEnd(7)} ${s.kind}${where}${why}: ${s.detail}`
}

function printPlan(plan: ClusterUpdatePlan, print: (line: string) => void): void {
  print(`Target: ${plan.targetVersion ?? 'unknown'}`)
  for (const s of plan.steps) print(stepLine(s))
  if (plan.skippedOffline.length > 0) {
    print(`Offline, not touched: ${plan.skippedOffline.join(', ')}`)
  }
}

/** Prints a step each time its status changes. */
function progressPrinter(print: (line: string) => void): (job: ClusterUpdateJob) => void {
  const seen = new Map<number, string>()
  return (job) => {
    job.steps.forEach((s, i) => {
      const key = `${s.status}|${s.detail}`
      if (seen.get(i) === key) return
      seen.set(i, key)
      if (s.status !== 'pending') print(stepLine(s))
    })
  }
}

/** Returns the exit code: 0 done or nothing to do / cancelled, 1 otherwise. */
export async function clusterUpdateCommand(
  client: HubClient,
  args: ClusterUpdateCommandArgs,
  deps: ClusterUpdateCommandDeps,
): Promise<number> {
  const { print } = deps
  const read = await readQuery(
    client,
    'clusterUpdate.previewClusterUpdate',
    hubOptions(args),
    ClusterUpdatePlanSchema,
  )
  if (!read.ok) {
    print(`Cannot read the plan: ${hubTooOld(read.reason) ?? read.reason}`)
    return 1
  }
  const plan = read.value
  printPlan(plan, print)
  if (plan.blocker !== null) {
    print(`Not started (${plan.blocker}): ${plan.blockerDetail ?? ''}`)
    return plan.blocker === 'nothing-to-do' ? 0 : 1
  }
  if (args.yes !== true && !(await deps.confirm('Start the cluster update on the hub?'))) {
    print('Cancelled.')
    return 0
  }
  const run = await runClusterJob(client, args, {
    ...timing(deps),
    onJob: progressPrinter(print),
  })
  if (run.problem !== null) {
    print(run.unfinished ? `Still running: ${run.problem}` : `Failed: ${run.problem}`)
    return 1
  }
  const failed = run.steps.find((s) => s.status === 'failed')
  if (failed !== undefined) {
    print(`Failed at ${failed.nodeId ?? failed.step}: ${failed.detail}`)
    return 1
  }
  print(`Cluster update ${run.jobId ?? ''} succeeded.`)
  return 0
}

export const CLUSTER_UPDATE_HELP = [
  'Usage: camstack cluster-update [options]',
  '',
  'Runs the hub-side cluster update job (the same as the admin UI "Update all"):',
  'backup, the hub server, each online agent verified (target + capabilities),',
  'then the addons. Stops on the first failure and names the node and reason.',
  '',
  'Options:',
  '  -V, --version <x.y.z>   Server target (default: the hub latest)',
  '      --no-addons         Leave the addons as they are',
  '      --no-backup         Skip the backup (explicit opt-out)',
  '  -y, --yes               Do not ask for confirmation',
  '  -s, --server <host>     Hub URL (default: cached session)',
  '      --token-file <path> Read the token from a file',
].join('\n')

export async function runClusterUpdate(rawArgs: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...rawArgs],
    options: {
      version: { type: 'string', short: 'V' },
      'no-addons': { type: 'boolean' },
      'no-backup': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      server: { type: 'string', short: 's' },
      'token-file': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  const print = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }
  const outcome = await tryConnectHub({
    workspaceRoot: process.cwd(),
    ...(values.server !== undefined ? { server: values.server } : {}),
    ...(values['token-file'] !== undefined ? { tokenFile: values['token-file'] } : {}),
  })
  if (!outcome.ok) {
    print(`${outcome.message}; ${outcome.action}`)
    process.exitCode = 1
    return
  }
  if (outcome.connection.tier !== 'admin') {
    print(outcome.connection.adminHint ?? 'this credential is not admin-scoped')
    process.exitCode = 1
    return
  }
  const clack = await import('@clack/prompts')
  process.exitCode = await clusterUpdateCommand(
    outcome.connection.client,
    {
      ...(values.version !== undefined ? { version: values.version } : {}),
      ...(values['no-addons'] === true ? { addons: false } : {}),
      ...(values['no-backup'] === true ? { backup: false } : {}),
      ...(values.yes === true ? { yes: true } : {}),
    },
    {
      print,
      confirm: async (message) => {
        const ok = await clack.confirm({ message, initialValue: true })
        return !clack.isCancel(ok) && ok === true
      },
    },
  )
}
