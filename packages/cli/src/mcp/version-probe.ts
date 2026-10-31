/**
 * The light version probe behind the MCP preflight and `version_check`: the
 * hub's server closure (running vs the latest the hub knows), how many hub
 * addons have an update, and this CLI (which IS the MCP) against npm. Not the
 * per-node walk of `ops_update_check`: three reads, no topology.
 *
 * A read that failed is a reason in `unavailable`, never "up to date" (D315).
 * With no hub session only the CLI/MCP is checked, and that is not a failure.
 */
import { z } from 'zod'
import type { McpContext } from './context.js'
import { readQuery } from './ops-hub.js'
import { AddonUpdateShape, readNodeStatus } from './ops-update-model.js'
import { cliVerdict, isOlder } from './ops-update-cli.js'

export interface ServerBehind {
  readonly running: string
  readonly latest: string
}

export interface AddonsBehind {
  readonly count: number
  /** The first few names, for the one-line warning. */
  readonly names: readonly string[]
}

export interface CliBehind {
  readonly installed: string
  readonly latest: string
}

export interface VersionProbe {
  /** Set only when the hub's server is behind. */
  readonly server: ServerBehind | null
  /** Set only when at least one hub addon has an update. */
  readonly addons: AddonsBehind | null
  /** Set only when the CLI/MCP is behind npm. */
  readonly cli: CliBehind | null
  /** Parts that could not be read, each with its reason. */
  readonly unavailable: readonly string[]
}

export const ADDON_NAME_LIMIT = 3

export interface ProbeDeps {
  readonly entryPath?: string
}

export async function probeVersions(ctx: McpContext, deps: ProbeDeps = {}): Promise<VersionProbe> {
  const unavailable: string[] = []
  const hubOutcome = await ctx.hub()
  const cliPromise = cliVerdict(ctx.cliVersion, ctx.fetch, deps.entryPath ?? process.argv[1] ?? '')
  let server: ServerBehind | null = null
  let addons: AddonsBehind | null = null
  if (hubOutcome.ok) {
    const { client } = hubOutcome.connection
    const [status, updates] = await Promise.all([
      readNodeStatus(client, { isHub: true, id: 'hub' }),
      readQuery(client, 'addons.listUpdates', {}, z.array(AddonUpdateShape)),
    ])
    if (!status.ok) unavailable.push(`hub server status: ${status.reason}`)
    else {
      const { runningVersion, latestVersion } = status.value
      if (runningVersion && latestVersion && isOlder(runningVersion, latestVersion)) {
        server = { running: runningVersion, latest: latestVersion }
      }
    }
    if (!updates.ok) unavailable.push(`hub addon updates: ${updates.reason}`)
    else if (updates.value.length > 0) {
      addons = {
        count: updates.value.length,
        names: updates.value.slice(0, ADDON_NAME_LIMIT).map((u) => u.name),
      }
    }
  }
  const cliResult = await cliPromise
  let cli: CliBehind | null = null
  if (cliResult.updateAvailable === null) {
    unavailable.push(`CLI/MCP latest version: ${cliResult.error ?? 'unknown'}`)
  } else if (cliResult.updateAvailable && cliResult.latest !== null) {
    cli = { installed: cliResult.installed, latest: cliResult.latest }
  }
  return { server, addons, cli, unavailable }
}

/** The one-line warning, or `null` when nothing is outdated. */
export function formatWarning(probe: VersionProbe): string | null {
  const parts: string[] = []
  if (probe.server) parts.push(`server ${probe.server.running} → ${probe.server.latest}`)
  if (probe.addons) {
    const more = probe.addons.count > probe.addons.names.length ? ', …' : ''
    const noun = probe.addons.count === 1 ? 'addon' : 'addons'
    parts.push(`${probe.addons.count} ${noun} outdated (${probe.addons.names.join(', ')}${more})`)
  }
  if (probe.cli) parts.push(`CLI/MCP ${probe.cli.installed} → ${probe.cli.latest}`)
  if (parts.length === 0) return null
  return `⚠ CamStack versions: ${parts.join(' · ')} — run ops_update_check / ops_update_apply.`
}

/** What is wrong with the probe when nothing is known to be outdated; else `null`. */
export function failureReason(probe: VersionProbe): string | null {
  if (formatWarning(probe) !== null) return null
  return probe.unavailable.length > 0 ? probe.unavailable.join('; ') : null
}
