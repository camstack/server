import type {
  PackageInstallation,
  PackageInstallations,
  UninstallNodeResult,
  UninstallPackageResult,
} from '@camstack/types'

/**
 * Per-node and cluster-wide addon UNINSTALL — the body of
 * `addons.uninstallPackage({ packageName, nodeId?, everywhere? })` and
 * `addons.listInstallations`.
 *
 * Why it exists: `uninstallPackage` acted on the hub alone, and the lifecycle
 * job engine refuses agents. On 2026-10-08 `@camstack/addon-decoder-ffmpeg` was
 * uninstalled on the hub and stayed installed — runner running, `decoder`
 * advertised — on both agents, with no API that could remove it.
 *
 * The agent leg follows the path `updatePackage({ nodeId })` already uses to
 * reach an agent: a hub-side `broker.call` to the agent's existing `$agent.*`
 * service, here `$agent.undeploy` in package mode. No new action, no new
 * transport. The agent stops the hosting runners itself (`agent-undeploy.ts`).
 *
 * Intent is recorded on the hub: a removed package is pruned from the node's
 * declared roster, so the back-fill never returns it; and the back-fill never
 * delivers a package the hub does not install (`computeBackfillPlan`), so an
 * "everywhere" uninstall stays gone even on a node that was offline — that
 * node's copy is removed by the stale-addon sweep when it registers again.
 */

/** One addon row of an agent's `$agent.status`. */
export interface AgentStatusAddonRow {
  readonly id: string
  readonly packageName?: string
  readonly version?: string
}

/** A non-hub node the hub knows (live registry + durable history). */
export interface UninstallAgentNode {
  readonly id: string
  readonly name: string
  readonly isOnline: boolean
}

/** A package installed on the hub, with the addon ids it declares. */
export interface HubPackageRow {
  readonly name: string
  readonly version: string
  readonly addonIds: readonly string[]
}

export interface AddonUninstallSeam {
  /** The hub's protection rule (`AddonPackageService.isProtected`). */
  readonly isProtected: (packageName: string) => boolean
  readonly listHubPackages: () => readonly HubPackageRow[]
  /** `AddonPackageService.uninstallAndReload` — throws on failure. */
  readonly uninstallOnHub: (packageName: string) => Promise<void>
  readonly listAgents: () => Promise<readonly UninstallAgentNode[]>
  /** `$agent.status` addons; throws when the node does not answer. */
  readonly agentAddons: (nodeId: string) => Promise<readonly AgentStatusAddonRow[]>
  /** `$agent.undeploy` — the reply is untyped data from another process. */
  readonly agentUndeploy: (
    nodeId: string,
    request: { readonly packageName: string; readonly addonId: string },
  ) => Promise<unknown>
  readonly recordedPackages: (
    nodeId: string,
  ) => Promise<readonly { readonly name: string; readonly version: string | null }[]>
  readonly notePackageUndeployed: (
    nodeId: string,
    packageName: string,
    addonIds: readonly string[],
  ) => Promise<void>
}

export interface UninstallPackageRequest {
  readonly packageName: string
  readonly nodeId?: string
  readonly everywhere?: boolean
}

/** The hub refuses before touching any node. Mapped to FORBIDDEN by the router. */
export class PackageProtectedError extends Error {
  constructor(packageName: string) {
    super(`Package ${packageName} is required and cannot be uninstalled`)
    this.name = 'PackageProtectedError'
  }
}

/** A node id that refers to the hub itself (top-level or a hub group runner). */
export function isHubNodeId(nodeId: string): boolean {
  return nodeId === 'hub' || nodeId.startsWith('hub/')
}

const OK_OUTCOMES: ReadonlySet<UninstallNodeResult['outcome']> = new Set([
  'uninstalled',
  'not-installed',
  'pending-reconnect',
])

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function nodeResult(
  nodeId: string,
  outcome: UninstallNodeResult['outcome'],
  extra: Partial<Omit<UninstallNodeResult, 'nodeId' | 'outcome'>> = {},
): UninstallNodeResult {
  return {
    nodeId,
    outcome,
    addonIds: extra.addonIds ?? [],
    runnersStopped: extra.runnersStopped ?? [],
    warnings: extra.warnings ?? [],
    ...(extra.error !== undefined ? { error: extra.error } : {}),
  }
}

// ── $agent.undeploy reply parsing (untyped data from another process) ─

interface ParsedUndeployReply {
  readonly packageScoped: boolean
  readonly outcome: UninstallNodeResult['outcome'] | null
  readonly reason: string | undefined
  readonly addonIds: readonly string[]
  readonly runnersStopped: readonly string[] | null
  readonly warnings: readonly string[]
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseUndeployReply(reply: unknown): ParsedUndeployReply {
  if (!isRecord(reply)) {
    return {
      packageScoped: false,
      outcome: null,
      reason: undefined,
      addonIds: [],
      runnersStopped: null,
      warnings: [],
    }
  }
  const outcome = reply['outcome']
  return {
    packageScoped: reply['scope'] === 'package',
    outcome:
      outcome === 'uninstalled' || outcome === 'not-installed' || outcome === 'refused'
        ? outcome
        : null,
    reason: typeof reply['reason'] === 'string' ? reply['reason'] : undefined,
    addonIds: stringArray(reply['addonIds']),
    runnersStopped: Array.isArray(reply['runnersStopped'])
      ? stringArray(reply['runnersStopped'])
      : null,
    warnings: stringArray(reply['warnings']),
  }
}

/**
 * An agent built before package mode answers `{ success, addonId }` and removes
 * ONE addon — its folder, not its runner. Its packages are still removed (one
 * call per addon id), and the result says the runner outlives it.
 */
const LEGACY_AGENT_WARNING =
  'this agent predates runner teardown: the addon is removed from disk but its runner keeps running until the agent restarts — update the agent'

async function uninstallFromOnlineAgent(
  seam: AddonUninstallSeam,
  nodeId: string,
  packageName: string,
): Promise<UninstallNodeResult> {
  let listed: readonly string[]
  try {
    listed = (await seam.agentAddons(nodeId))
      .filter((a) => a.packageName === packageName)
      .map((a) => a.id)
  } catch (err) {
    return nodeResult(nodeId, 'failed', { error: `status read failed: ${errMessage(err)}` })
  }

  try {
    // `addonId` is for an agent that predates package mode: it reads only that
    // field. With no listed addon, the package name doubles as the dir to drop.
    const first = parseUndeployReply(
      await seam.agentUndeploy(nodeId, { packageName, addonId: listed[0] ?? packageName }),
    )
    if (first.packageScoped && first.outcome !== null) {
      if (first.outcome === 'refused') {
        return nodeResult(nodeId, 'refused', { error: first.reason, addonIds: first.addonIds })
      }
      await seam.notePackageUndeployed(nodeId, packageName, first.addonIds)
      return nodeResult(nodeId, first.outcome, {
        addonIds: first.addonIds,
        runnersStopped: first.runnersStopped ?? [],
        warnings: first.warnings,
      })
    }
    for (const addonId of listed.slice(1)) {
      await seam.agentUndeploy(nodeId, { packageName, addonId })
    }
    await seam.notePackageUndeployed(nodeId, packageName, listed)
    return nodeResult(nodeId, listed.length > 0 ? 'uninstalled' : 'not-installed', {
      addonIds: listed,
      warnings: listed.length > 0 ? [LEGACY_AGENT_WARNING] : [],
    })
  } catch (err) {
    return nodeResult(nodeId, 'failed', { addonIds: listed, error: errMessage(err) })
  }
}

async function uninstallFromAgent(
  seam: AddonUninstallSeam,
  node: UninstallAgentNode,
  packageName: string,
): Promise<UninstallNodeResult> {
  if (node.isOnline) return uninstallFromOnlineAgent(seam, node.id, packageName)
  // Offline: nothing can be called. Pruning the record is what keeps the
  // back-fill from returning it; the copy itself is the stale sweep's on rejoin.
  try {
    await seam.notePackageUndeployed(node.id, packageName, [])
    return nodeResult(node.id, 'pending-reconnect', {
      warnings: [
        'node is offline — its copy is removed when it reconnects, provided the hub no longer installs the package',
      ],
    })
  } catch (err) {
    return nodeResult(node.id, 'failed', { error: errMessage(err) })
  }
}

async function uninstallFromHub(
  seam: AddonUninstallSeam,
  packageName: string,
): Promise<UninstallNodeResult> {
  const row = seam.listHubPackages().find((p) => p.name === packageName)
  if (!row) return nodeResult('hub', 'not-installed')
  try {
    await seam.uninstallOnHub(packageName)
    return nodeResult('hub', 'uninstalled', { addonIds: row.addonIds })
  } catch (err) {
    return nodeResult('hub', 'failed', { addonIds: row.addonIds, error: errMessage(err) })
  }
}

function summarize(
  packageName: string,
  results: readonly UninstallNodeResult[],
): UninstallPackageResult {
  return { success: results.every((r) => OK_OUTCOMES.has(r.outcome)), packageName, results }
}

/**
 * Agents that have (or are recorded to have) the package. An online agent
 * whose status read fails is still targeted — the undeploy leg reports the
 * failure for that node rather than silently skipping it.
 */
async function agentsHolding(
  seam: AddonUninstallSeam,
  packageName: string,
): Promise<readonly UninstallAgentNode[]> {
  const agents = await seam.listAgents()
  const holding = await Promise.all(
    agents.map(async (node) => {
      if (node.isOnline) {
        try {
          const addons = await seam.agentAddons(node.id)
          if (addons.some((a) => a.packageName === packageName)) return node
        } catch {
          return node
        }
      }
      const recorded = await seam.recordedPackages(node.id).catch(() => [])
      return recorded.some((p) => p.name === packageName) ? node : null
    }),
  )
  return holding.filter((n): n is UninstallAgentNode => n !== null)
}

export async function uninstallPackage(
  seam: AddonUninstallSeam,
  request: UninstallPackageRequest,
): Promise<UninstallPackageResult> {
  const { packageName } = request
  if (seam.isProtected(packageName)) throw new PackageProtectedError(packageName)

  if (request.everywhere === true) {
    const agents = await agentsHolding(seam, packageName)
    // Agents first, hub last — the hub routes every call to the agents, and a
    // hub uninstall that fails must not leave the agents' records already
    // pruned for nothing: each leg records only its own success.
    const results: UninstallNodeResult[] = []
    for (const node of agents) results.push(await uninstallFromAgent(seam, node, packageName))
    results.push(await uninstallFromHub(seam, packageName))
    return summarize(packageName, results)
  }

  const nodeId = request.nodeId
  if (nodeId === undefined || isHubNodeId(nodeId)) {
    // The original contract: hub-only, and a failure THROWS.
    await seam.uninstallOnHub(packageName)
    const row = seam.listHubPackages().find((p) => p.name === packageName)
    return summarize(packageName, [
      nodeResult('hub', 'uninstalled', { addonIds: row?.addonIds ?? [] }),
    ])
  }

  const node = (await seam.listAgents()).find((n) => n.id === nodeId)
  if (!node) {
    return summarize(packageName, [
      nodeResult(nodeId, 'failed', { error: `unknown node ${nodeId}` }),
    ])
  }
  return summarize(packageName, [await uninstallFromAgent(seam, node, packageName)])
}

export async function listInstallations(
  seam: AddonUninstallSeam,
  packageName: string | undefined,
): Promise<PackageInstallations> {
  const wanted = (name: string): boolean => packageName === undefined || name === packageName
  const hubPackages = seam.listHubPackages()
  const onHub = new Set(hubPackages.map((p) => p.name))
  const installations: PackageInstallation[] = hubPackages
    .filter((p) => wanted(p.name))
    .map((p) => ({
      packageName: p.name,
      nodeId: 'hub',
      nodeName: 'Hub',
      isHub: true,
      isOnline: true,
      version: p.version,
      addonIds: p.addonIds,
      source: 'live' as const,
      onHub: true,
    }))
  const unreachable: { nodeId: string; error: string }[] = []

  const perAgent = await Promise.all(
    (await seam.listAgents()).map(async (node): Promise<readonly PackageInstallation[]> => {
      const base = { nodeId: node.id, nodeName: node.name, isHub: false, isOnline: node.isOnline }
      if (node.isOnline) {
        try {
          const byPackage = new Map<string, { version: string | null; addonIds: string[] }>()
          for (const addon of await seam.agentAddons(node.id)) {
            if (addon.packageName === undefined || !wanted(addon.packageName)) continue
            const row = byPackage.get(addon.packageName) ?? {
              version: addon.version ?? null,
              addonIds: [],
            }
            row.addonIds.push(addon.id)
            byPackage.set(addon.packageName, row)
          }
          return [...byPackage].map(([name, row]) => ({
            ...base,
            packageName: name,
            version: row.version,
            addonIds: row.addonIds,
            source: 'live' as const,
            onHub: onHub.has(name),
          }))
        } catch (err) {
          unreachable.push({ nodeId: node.id, error: errMessage(err) })
          return []
        }
      }
      const recorded = await seam.recordedPackages(node.id).catch(() => [])
      return recorded
        .filter((p) => wanted(p.name))
        .map((p) => ({
          ...base,
          packageName: p.name,
          version: p.version,
          addonIds: [],
          source: 'recorded' as const,
          onHub: onHub.has(p.name),
        }))
    }),
  )
  return { installations: [...installations, ...perAgent.flat()], unreachable }
}
