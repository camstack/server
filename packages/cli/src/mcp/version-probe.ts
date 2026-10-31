/**
 * The light version probe behind the MCP preflight and `version_check`: the
 * hub's server closure (running vs the latest the hub knows), how many hub
 * addons have an update, and this CLI (which IS the MCP) against npm. Not the
 * per-node walk of `ops_update_check`: three reads, no topology.
 *
 * Every part carries a verdict; a read that failed is `unknown` with its reason,
 * never "up to date" (D315, D393).
 * With no hub session only the CLI/MCP is checked, and that is not a failure.
 */
import { z } from 'zod'
import type { McpContext } from './context.js'
import { readQuery } from './ops-hub.js'
import { AddonUpdateShape, readNodeStatus } from './ops-update-model.js'
import { cliVerdict, isOlder } from './ops-update-cli.js'

export interface ServerParts {
  readonly running: string
  readonly latest: string
}

export interface AddonsParts {
  readonly count: number
  /** The first few names, for the one-line warning. */
  readonly names: readonly string[]
}

export interface CliParts {
  readonly installed: string
  readonly latest: string
}

/**
 * One checked component. `current` and `behind` are measured verdicts;
 * `unknown` is a read that failed and `not-checked` is a part that does not
 * apply (no hub session). Neither of the last two is ever "up to date".
 */
export type Verdict<T> =
  | ({ readonly state: 'current' | 'behind' } & T)
  | { readonly state: 'unknown' | 'not-checked'; readonly reason: string }

export interface VersionProbe {
  readonly server: Verdict<ServerParts>
  readonly addons: Verdict<AddonsParts>
  readonly cli: Verdict<CliParts>
}

export const ADDON_NAME_LIMIT = 3
const NO_HUB_SESSION = 'no hub session (run `camstack login <host>`)'

export interface ProbeDeps {
  readonly entryPath?: string
}

export async function probeVersions(ctx: McpContext, deps: ProbeDeps = {}): Promise<VersionProbe> {
  const hubOutcome = await ctx.hub()
  const cliPromise = cliVerdict(ctx.cliVersion, ctx.fetch, deps.entryPath ?? process.argv[1] ?? '')
  let server: Verdict<ServerParts> = {
    state: 'not-checked',
    reason: NO_HUB_SESSION,
  }
  let addons: Verdict<AddonsParts> = {
    state: 'not-checked',
    reason: NO_HUB_SESSION,
  }
  if (hubOutcome.ok) {
    const { client } = hubOutcome.connection
    const [status, updates] = await Promise.all([
      readNodeStatus(client, { isHub: true, id: 'hub' }),
      readQuery(client, 'addons.listUpdates', {}, z.array(AddonUpdateShape)),
    ])
    server = serverVerdictOf(status)
    addons = updates.ok
      ? {
          state: updates.value.length > 0 ? 'behind' : 'current',
          count: updates.value.length,
          names: updates.value.slice(0, ADDON_NAME_LIMIT).map((u) => u.name),
        }
      : { state: 'unknown', reason: `read failed: ${updates.reason}` }
  }
  const cliResult = await cliPromise
  const cli: Verdict<CliParts> =
    cliResult.updateAvailable === null || cliResult.latest === null
      ? {
          state: 'unknown',
          reason: `npm unreachable: ${cliResult.error ?? 'no version answered'}`,
        }
      : {
          state: cliResult.updateAvailable ? 'behind' : 'current',
          installed: cliResult.installed,
          latest: cliResult.latest,
        }
  return { server, addons, cli }
}

function serverVerdictOf(status: Awaited<ReturnType<typeof readNodeStatus>>): Verdict<ServerParts> {
  if (!status.ok) return { state: 'unknown', reason: `read failed: ${status.reason}` }
  const { runningVersion, latestVersion } = status.value
  if (!runningVersion || !latestVersion) {
    return {
      state: 'unknown',
      reason: 'the hub did not report a running or latest version',
    }
  }
  return {
    state: isOlder(runningVersion, latestVersion) ? 'behind' : 'current',
    running: runningVersion,
    latest: latestVersion,
  }
}

/** The one-line warning, or `null` when nothing is known to be outdated. */
export function formatWarning(probe: VersionProbe): string | null {
  const parts: string[] = []
  if (probe.server.state === 'behind') {
    parts.push(`server ${probe.server.running} → ${probe.server.latest}`)
  }
  if (probe.addons.state === 'behind') {
    const more = probe.addons.count > probe.addons.names.length ? ', …' : ''
    const noun = probe.addons.count === 1 ? 'addon' : 'addons'
    parts.push(`${probe.addons.count} ${noun} outdated (${probe.addons.names.join(', ')}${more})`)
  }
  if (probe.cli.state === 'behind')
    parts.push(`CLI/MCP ${probe.cli.installed} → ${probe.cli.latest}`)
  if (parts.length === 0) return null
  return `⚠ CamStack versions: ${parts.join(' · ')} — run ops_update_check / ops_update_apply.`
}

const LABELS = {
  server: 'hub server',
  addons: 'hub addons',
  cli: 'CLI/MCP',
} as const

/** The parts that could not be measured (a failed read; a part that does not apply is not listed). */
export function unmeasured(probe: VersionProbe): readonly string[] {
  const out: string[] = []
  for (const key of ['server', 'addons', 'cli'] as const) {
    const v = probe[key]
    if (v.state === 'unknown') out.push(`${LABELS[key]}: ${v.reason}`)
  }
  return out
}

/** The parts that do not apply, with why (no hub session). */
export function notChecked(probe: VersionProbe): readonly string[] {
  const out: string[] = []
  for (const key of ['server', 'addons', 'cli'] as const) {
    const v = probe[key]
    if (v.state === 'not-checked') out.push(`${LABELS[key]}: ${v.reason}`)
  }
  return out
}

/** True only when EVERY part was measured and none is behind. */
export function allCurrent(probe: VersionProbe): boolean {
  return [probe.server, probe.addons, probe.cli].every((v) => v.state === 'current')
}

/** What is wrong with the probe when nothing is known to be outdated; else `null`. */
export function failureReason(probe: VersionProbe): string | null {
  if (formatWarning(probe) !== null) return null
  const missing = unmeasured(probe)
  return missing.length > 0 ? missing.join('; ') : null
}
