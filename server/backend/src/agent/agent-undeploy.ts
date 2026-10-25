import * as fs from 'node:fs'
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { readPackageManifestAddons } from './agent-group-runner.js'
import type { LoadedAddonEntry } from './agent-service.js'

/**
 * Removing an addon from an AGENT — the body of `$agent.undeploy`.
 *
 * WHY THIS IS A MODULE OF ITS OWN
 * The handler used to do three things: `shutdown()` an in-process instance,
 * `destroyService(addonId)`, and delete the folder. On an agent almost nothing
 * is in-process — every deployable addon runs in a GROUP RUNNER spawned through
 * `$process.spawnRunner` — so for the addons that actually exist the first two
 * steps were no-ops and the third deleted the code from under a process that
 * kept running. 2026-10-08: `@camstack/addon-decoder-ffmpeg` was uninstalled on
 * the hub and its runner stayed up on both agents, still advertising `decoder`.
 *
 * What a real removal does, in order:
 *   1. refuse a package the node cannot live without (bootstrap infra, or a
 *      manifest entry marked `protected: true` — the hub's own rule);
 *   2. shut down in-process instances and destroy their Moleculer services;
 *   3. STOP every runner hosting a removed addon (`$process.stop`, which reaps
 *      the runner's whole process group — D668). A runner shared with addons
 *      that are NOT being removed is respawned with the survivors only;
 *   4. drop the agent-registry cap proxies the boot/reload path registered for
 *      the removed addons, and their `loadedAddons` rows;
 *   5. delete the code from the addon root;
 *   6. re-register upward so the hub's routing authority forgets the caps now,
 *      not at the next reconnect (D3).
 *
 * Two request shapes, one handler:
 *   - `{ packageName }` — the operator's uninstall: every addon the package
 *     declares (read from the on-disk manifest, so a copy that FAILED to load
 *     is still found) plus every loaded addon reporting that package.
 *   - `{ addonId }` — the stale-addon reconcile's per-id removal (unchanged
 *     sibling rule: a package dir still used by a surviving sibling stays).
 * When both are sent, `packageName` wins. The hub sends both so an agent that
 * predates package mode still removes the named addon (see
 * `addon-uninstall.ts` on the hub).
 */

/** One `$process.listByAddon` row — only the fields the teardown reads. */
export interface AgentRunnerRow {
  readonly name: string
  readonly addonIds: readonly string[]
}

/** Result of a runner stop (`$process.stop`). */
export interface AgentRunnerStopResult {
  readonly success: boolean
  readonly reason?: string
}

export interface AgentUndeployRequest {
  readonly addonId?: string
  readonly packageName?: string
}

/** What one `$agent.undeploy` did. `outcome` is the per-node verdict the hub reports. */
export type AgentUndeployOutcome = 'uninstalled' | 'not-installed' | 'refused'

export interface AgentUndeployResult {
  readonly success: boolean
  readonly outcome: AgentUndeployOutcome
  /** `package` = this agent understood package mode; the hub stops iterating ids. */
  readonly scope: 'package' | 'addon'
  /** Kept for callers that read the legacy `{ success, addonId }` reply. */
  readonly addonId?: string
  readonly packageName?: string
  readonly addonIds: readonly string[]
  /** Runners stopped. Its PRESENCE tells the hub this agent stops runners at all. */
  readonly runnersStopped: readonly string[]
  /** Runners that hosted survivors and were brought back without the removed addons. */
  readonly runnersRespawned: readonly string[]
  readonly removedDirs: readonly string[]
  /** Why a refusal refused, or what part of the teardown failed. */
  readonly reason?: string
  /** Non-fatal problems: a runner that would not stop, a survivor respawn that threw. */
  readonly warnings: readonly string[]
}

export interface AgentUndeploySeam {
  readonly addonsDir: string
  readonly loadedAddons: Map<string, LoadedAddonEntry>
  /** Packages the node bootstraps itself — never removable through this path. */
  readonly bootstrapPackages: ReadonlySet<string>
  readonly listRunnersByAddon: (addonId: string) => Promise<readonly AgentRunnerRow[]>
  readonly stopRunner: (name: string) => Promise<AgentRunnerStopResult>
  readonly destroyService: (addonId: string) => Promise<void>
  /** Drop the cap proxy `registerGroupRunnerProviders` installed, when present. */
  readonly unregisterProvider: (capName: string, addonId: string) => void
  /** Re-run deployed-addon discovery so survivors of a shared runner come back. */
  readonly respawnSurvivors?: () => Promise<unknown>
  /** Re-run the atomic upward `registerNode` (D3). */
  readonly reconcileNodeRegistration?: () => void
  readonly logger: IScopedLogger
}

interface UndeployTarget {
  readonly packageName: string | undefined
  readonly addonIds: readonly string[]
  /** Cap names per addon id, from the on-disk manifest — read BEFORE the dir goes. */
  readonly capsByAddon: ReadonlyMap<string, readonly string[]>
  readonly packageDir: string | null
  readonly protectedBy: string | null
}

function capName(cap: string | { readonly name: string }): string {
  return typeof cap === 'string' ? cap : cap.name
}

function packageDirFor(addonsDir: string, packageName: string): string | null {
  const resolved = path.resolve(addonsDir, packageName)
  const root = path.resolve(addonsDir)
  // A package name is data from the network. It must name a dir INSIDE the
  // addon root and never the root itself.
  if (resolved === root || !resolved.startsWith(root + path.sep)) return null
  return resolved
}

function resolveTarget(seam: AgentUndeploySeam, request: AgentUndeployRequest): UndeployTarget {
  const packageName =
    request.packageName ??
    (request.addonId !== undefined
      ? seam.loadedAddons.get(request.addonId)?.packageName
      : undefined)
  const packageDir = packageName !== undefined ? packageDirFor(seam.addonsDir, packageName) : null
  const manifest = packageDir !== null ? readPackageManifestAddons(packageDir) : null

  const capsByAddon = new Map<string, readonly string[]>()
  let protectedBy: string | null = null
  for (const decl of manifest?.declarations ?? []) {
    capsByAddon.set(decl.id, (decl.capabilities ?? []).map(capName))
    if (decl.protected === true) protectedBy = decl.id
  }

  if (request.packageName === undefined) {
    return {
      packageName,
      addonIds: request.addonId !== undefined ? [request.addonId] : [],
      capsByAddon,
      packageDir,
      protectedBy,
    }
  }

  const ids = new Set<string>(capsByAddon.keys())
  for (const entry of seam.loadedAddons.values()) {
    if (entry.packageName === request.packageName) ids.add(entry.id)
  }
  return { packageName, addonIds: [...ids], capsByAddon, packageDir, protectedBy }
}

function refusalReason(seam: AgentUndeploySeam, target: UndeployTarget): string | null {
  if (target.packageName !== undefined && seam.bootstrapPackages.has(target.packageName)) {
    return `${target.packageName} is this node's bootstrap infrastructure and cannot be uninstalled`
  }
  if (target.protectedBy !== null) {
    return `${target.packageName ?? 'package'} is protected (addon "${target.protectedBy}" declares protected: true)`
  }
  if (target.packageName === undefined && target.addonIds.length === 0) {
    return 'neither addonId nor packageName was given'
  }
  return null
}

async function shutdownInProcess(seam: AgentUndeploySeam, addonId: string): Promise<void> {
  const entry = seam.loadedAddons.get(addonId)
  if (entry?.addon?.shutdown) {
    try {
      await entry.addon.shutdown()
    } catch (err) {
      seam.logger.warn(`undeploy: ${addonId} shutdown() threw`, {
        tags: { addonId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
  try {
    await seam.destroyService(addonId)
  } catch {
    // Group-runner addons have no per-addon service on the agent broker.
  }
}

interface RunnerTeardown {
  readonly stopped: readonly string[]
  readonly survivors: readonly string[]
  readonly warnings: readonly string[]
}

async function stopHostingRunners(
  seam: AgentUndeploySeam,
  addonIds: readonly string[],
): Promise<RunnerTeardown> {
  const removing = new Set(addonIds)
  const runners = new Map<string, AgentRunnerRow>()
  const warnings: string[] = []
  for (const id of addonIds) {
    try {
      for (const row of await seam.listRunnersByAddon(id)) runners.set(row.name, row)
    } catch (err) {
      warnings.push(
        `could not list runners for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const stopped: string[] = []
  const survivors: string[] = []
  for (const runner of runners.values()) {
    const result = await seam.stopRunner(runner.name).catch(
      (err: unknown): AgentRunnerStopResult => ({
        success: false,
        reason: err instanceof Error ? err.message : String(err),
      }),
    )
    if (!result.success) {
      warnings.push(`runner "${runner.name}" did not stop: ${result.reason ?? 'unknown'}`)
      continue
    }
    stopped.push(runner.name)
    for (const id of runner.addonIds) {
      if (!removing.has(id)) survivors.push(id)
    }
  }
  return { stopped, survivors, warnings }
}

function removeDirs(
  seam: AgentUndeploySeam,
  request: AgentUndeployRequest,
  target: UndeployTarget,
): string[] {
  const removed: string[] = []
  const rm = (dir: string | null): void => {
    if (dir === null || !fs.existsSync(dir)) return
    fs.rmSync(dir, { recursive: true, force: true })
    removed.push(dir)
  }
  if (request.packageName !== undefined) {
    rm(target.packageDir)
    return removed
  }
  // Addon mode — the reconcile's per-id removal. One package dir can host MANY
  // addons; only remove it when no OTHER loaded addon still lives in it (this
  // addon's own row is already gone from `loadedAddons`).
  const addonId = request.addonId
  if (addonId !== undefined) rm(packageDirFor(seam.addonsDir, addonId))
  const pkg = target.packageName
  if (pkg !== undefined && pkg !== addonId) {
    const shared = [...seam.loadedAddons.values()].some((e) => e.packageName === pkg)
    if (!shared) rm(target.packageDir)
  }
  return removed
}

/** Run one `$agent.undeploy`. Never throws for a refusal — it answers `refused`. */
export async function undeployFromAgent(
  seam: AgentUndeploySeam,
  request: AgentUndeployRequest,
): Promise<AgentUndeployResult> {
  const target = resolveTarget(seam, request)
  const scope = request.packageName !== undefined ? 'package' : 'addon'
  const base = {
    scope,
    addonId: request.addonId,
    packageName: target.packageName,
    addonIds: target.addonIds,
  } as const

  const refused = refusalReason(seam, target)
  if (refused !== null) {
    seam.logger.warn(`undeploy refused: ${refused}`, { meta: { request } })
    return {
      ...base,
      success: false,
      outcome: 'refused',
      reason: refused,
      runnersStopped: [],
      runnersRespawned: [],
      removedDirs: [],
      warnings: [],
    }
  }

  const present =
    target.addonIds.some((id) => seam.loadedAddons.has(id)) ||
    (target.packageDir !== null && fs.existsSync(target.packageDir))
  if (scope === 'package' && !present) {
    return {
      ...base,
      success: true,
      outcome: 'not-installed',
      runnersStopped: [],
      runnersRespawned: [],
      removedDirs: [],
      warnings: [],
    }
  }

  for (const id of target.addonIds) await shutdownInProcess(seam, id)
  const runners = await stopHostingRunners(seam, target.addonIds)

  for (const id of target.addonIds) {
    for (const cap of target.capsByAddon.get(id) ?? []) seam.unregisterProvider(cap, id)
    seam.loadedAddons.delete(id)
  }
  // A survivor's row is dropped too, so the discovery pass below sees it as
  // not-loaded and respawns its runner — without the removed addons, whose
  // code is gone by then.
  for (const id of runners.survivors) {
    for (const cap of target.capsByAddon.get(id) ?? []) seam.unregisterProvider(cap, id)
    seam.loadedAddons.delete(id)
  }

  const removedDirs = removeDirs(seam, request, target)
  const warnings = [...runners.warnings]

  let runnersRespawned: readonly string[] = []
  if (runners.survivors.length > 0) {
    if (seam.respawnSurvivors) {
      try {
        await seam.respawnSurvivors()
        runnersRespawned = runners.stopped
      } catch (err) {
        warnings.push(
          `survivors ${runners.survivors.join(', ')} were not respawned: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } else {
      warnings.push(`survivors ${runners.survivors.join(', ')} were stopped and not respawned`)
    }
  }

  seam.reconcileNodeRegistration?.()
  seam.logger.info(
    `undeploy: ${target.packageName ?? request.addonId ?? '?'} removed ` +
      `(addons=${target.addonIds.join(',') || '-'} runnersStopped=${runners.stopped.join(',') || '-'} ` +
      `dirs=${removedDirs.length})`,
    { meta: { warnings } },
  )
  return {
    ...base,
    success: true,
    outcome: 'uninstalled',
    runnersStopped: runners.stopped,
    runnersRespawned,
    removedDirs,
    warnings,
  }
}
