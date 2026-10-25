#!/usr/bin/env tsx
/**
 * Post-node rollout gate (D877): after a node took a server update, are ALL its
 * runners up, and is it on the version you expect?
 *
 * "The node is online and its capabilities are registered" is not enough. On
 * 2026-10-17 a hub came up on the new version with 28 addons refused and
 * 19 still dead four hours later, because every other check looked at the
 * node, not at its runners. This reads `serverManagement.getServerPackageStatus`
 * (the runner boot check, ~60 s after the node's boot) and exits non-zero when:
 *   - the node runs another server version than `--expect-version`,
 *   - the boot check has not run yet (wait ~60 s after the restart and retry),
 *   - any runner is failed, refused (the reason is printed) or missing.
 *
 * Read-only, through the hub's admin API (`hub.mjs`). `--server <host>` is
 * REQUIRED; `--node <id>` selects an agent (default: the hub itself).
 *
 * Usage: npx tsx scripts/hub/check-node-runners.ts --server <host> [--node <id>] --expect-version <v> [--token-file <f>]
 * Exit:  0 all runners up on the expected version; 1 a finding; 2 bad usage / hub unreachable.
 */
import { type HubCall, hubMjsCall } from './hub-call.js'

export interface RunnerFindings {
  readonly problems: readonly string[]
}

interface RunnerCheckShape {
  readonly expected: number
  readonly running: number
  readonly failed: readonly string[]
  readonly refused: readonly { readonly runnerId: string; readonly reason: string }[]
  readonly missing: readonly string[]
  readonly planKnown: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : null
}

function parseRunners(value: unknown): RunnerCheckShape | null {
  if (!isRecord(value)) return null
  const failed = strings(value['failed'])
  const missing = strings(value['missing'])
  const refusedRaw = value['refused']
  if (
    failed === null ||
    missing === null ||
    !Array.isArray(refusedRaw) ||
    typeof value['expected'] !== 'number' ||
    typeof value['running'] !== 'number'
  ) {
    return null
  }
  const refused: { runnerId: string; reason: string }[] = []
  for (const r of refusedRaw) {
    if (!isRecord(r) || typeof r['runnerId'] !== 'string' || typeof r['reason'] !== 'string') {
      return null
    }
    refused.push({ runnerId: r['runnerId'], reason: r['reason'] })
  }
  return {
    expected: value['expected'],
    running: value['running'],
    failed,
    refused,
    missing,
    planKnown: value['planKnown'] === true,
  }
}

/** Pure verdict over a `getServerPackageStatus` payload. */
export function judgeNodeStatus(status: unknown, expectVersion: string): RunnerFindings {
  if (!isRecord(status)) return { problems: ['the node answered something that is not a status'] }
  const problems: string[] = []
  const running = status['runningVersion']
  if (running !== expectVersion) {
    problems.push(`the node runs ${String(running)}, expected ${expectVersion}`)
  }
  const runners = parseRunners(status['runners'])
  if (status['runners'] === undefined) {
    problems.push(
      'the runner boot check has not run yet (it runs ~60 s after the node boots) - retry shortly',
    )
  } else if (runners === null) {
    problems.push('the node reported a runners block this script cannot read')
  } else {
    for (const id of runners.failed) problems.push(`runner ${id} is failed`)
    for (const r of runners.refused) problems.push(`runner ${r.runnerId} is REFUSED: ${r.reason}`)
    for (const id of runners.missing) problems.push(`runner ${id} is missing`)
  }
  return { problems }
}

export async function checkNodeRunners(
  hub: HubCall,
  node: string | null,
  expectVersion: string,
): Promise<RunnerFindings> {
  const status = await hub.query(
    'serverManagement.getServerPackageStatus',
    node === null ? undefined : { nodeId: node },
  )
  return judgeNodeStatus(status, expectVersion)
}

async function main(argv: readonly string[]): Promise<number> {
  const valueOf = (name: string): string | null => {
    const at = argv.indexOf(name)
    return at === -1 ? null : (argv[at + 1] ?? null)
  }
  const server = valueOf('--server')
  const expect = valueOf('--expect-version')
  if (server === null || expect === null) {
    console.error('usage: check-node-runners.ts --server <host> [--node <id>] --expect-version <v>')
    return 2
  }
  const node = valueOf('--node')
  let findings: RunnerFindings
  try {
    findings = await checkNodeRunners(hubMjsCall(server, valueOf('--token-file')), node, expect)
  } catch (err: unknown) {
    console.error(
      `could not read the node status: ${err instanceof Error ? err.message : String(err)}`,
    )
    return 2
  }
  const label = node ?? 'hub'
  if (findings.problems.length === 0) {
    console.log(`OK ${label}: all runners up on ${expect}`)
    return 0
  }
  console.error(`FAIL ${label}:`)
  for (const p of findings.problems) console.error(`  - ${p}`)
  return 1
}

if (process.argv[1]?.endsWith('check-node-runners.ts') === true) {
  void main(process.argv.slice(2)).then((code) => process.exit(code))
}
