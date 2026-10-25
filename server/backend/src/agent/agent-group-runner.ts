import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveAddonPlacement } from '@camstack/types'
import type { AddonDeclaration, IScopedLogger } from '@camstack/types'
import type { LoadedAddonEntry } from './agent-service.js'

/** A package's addon declarations read straight from package.json (NO module import). */
export interface PackageManifestAddons {
  readonly packageName: string
  readonly packageVersion: string
  readonly declarations: readonly AddonDeclaration[]
}

/**
 * Read a package's `camstack.addons[]` declarations directly from its
 * package.json — WITHOUT importing the addon entry module.
 *
 * The reload path must NOT `import()` heavy native addon entries (node-av, the
 * onnxruntime bridge, …) on the agent's MAIN thread: doing so blocks the event
 * loop long enough that `$agent.status` stops answering and the hub drops the
 * node from topology — and a hung import wedges `$agent.reload` outright (the
 * reload-wedge). A group-runner addon only needs its declaration (id,
 * capabilities, execution) to be (re)dispatched to a runner SUBPROCESS, which
 * loads the real module itself. Returns null on a missing/corrupt manifest.
 */
export function readPackageManifestAddons(dir: string): PackageManifestAddons | null {
  try {
    const pkgPath = path.join(dir, 'package.json')
    if (!fs.existsSync(pkgPath)) return null
    // Documented JSON boundary: the package.json shape is validated field-by-field below.
    const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      name?: unknown
      version?: unknown
      camstack?: { addons?: unknown }
    }
    const packageName = typeof raw.name === 'string' ? raw.name : ''
    const packageVersion = typeof raw.version === 'string' ? raw.version : '0.0.0'
    const entries = Array.isArray(raw.camstack?.addons) ? raw.camstack.addons : []
    const declarations: AddonDeclaration[] = []
    for (const entry of entries) {
      if (
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as { id?: unknown }).id === 'string'
      ) {
        // Boundary cast: validated to have a string `id`; the runtime helpers
        // (isDeployableToAgent / resolveRunnerId) read only `execution` / `id`.
        declarations.push(entry as AddonDeclaration)
      }
    }
    if (!packageName || declarations.length === 0) return null
    return { packageName, packageVersion, declarations }
  } catch {
    return null
  }
}

/**
 * A single addon to be hosted by a forked group runner on the agent.
 *
 * `groupId` is the runner id (`resolveRunnerId` — `execution.group ?? addonId`);
 * addons sharing a `groupId` collapse into one runner subprocess.
 */
export interface GroupCandidate {
  readonly groupId: string
  readonly addonId: string
  readonly addonDir: string
  readonly version: string
  readonly packageName: string
  readonly packageVersion: string
  readonly capabilities: ReadonlyArray<string | { readonly name: string }>
}

/** Minimal broker surface (`call`) used by the group-runner helpers. */
interface BrokerCall {
  call<T = unknown>(action: string, params?: unknown, opts?: unknown): Promise<T>
}

/** Minimal capability-registry surface used by the group-runner helpers. */
interface ProviderRegistrar {
  registerProvider(capabilityName: string, addonId: string, provider: unknown): void
  hasProvider(capabilityName: string, addonId: string): boolean
  unregisterProvider(capabilityName: string, addonId: string): void
}

/** Deps for the provider-registration step (no logging needed). */
export interface ProviderDeps {
  readonly broker: BrokerCall
  readonly capabilityRegistry: ProviderRegistrar
  readonly loadedAddons: Map<string, LoadedAddonEntry>
}

/** Deps for {@link ensureGroupRunner} — adds a logger for the restart/spawn path. */
export interface GroupRunnerDeps extends ProviderDeps {
  readonly logger: IScopedLogger
}

/** Shape of the `$process.restart` action result we branch on. */
interface RestartResult {
  readonly success: boolean
  readonly reason?: string
}

/**
 * Whether a deployed addon must run in a forked group runner (one addon = one
 * process) rather than in-process. True when the addon declares an `execution`
 * block with a placement reachable on an agent (`any-node`/`agent-only`).
 *
 * The default placement is `hub-only`, so a declaration without `execution`
 * is hub-only and not a group-runner addon — and, being hub-only, is never
 * deployable to an agent in the first place.
 */
export function isGroupRunnerAddon(decl: Pick<AddonDeclaration, 'execution'>): boolean {
  return decl.execution !== undefined && resolveAddonPlacement(decl) !== 'hub-only'
}

/**
 * Register the broker-call cap proxies + `loadedAddons` bookkeeping for a group
 * of addons whose runner is (now) live. Extracted so the boot path
 * (`loadClusterCapableAddons`) and the reload path (`ensureGroupRunner`) share
 * ONE implementation — preventing the two from drifting (the original cause of
 * the in-process-reload wedge).
 */
export function registerGroupRunnerProviders(
  deps: ProviderDeps,
  addons: readonly GroupCandidate[],
): void {
  for (const a of addons) {
    for (const cap of a.capabilities) {
      const capName = typeof cap === 'string' ? cap : cap.name
      const proxy = new Proxy<Record<string, unknown>>(
        {},
        {
          get(_target, prop: string) {
            if (prop === 'then' || typeof prop === 'symbol') return undefined
            return (params: unknown) => deps.broker.call(`${a.addonId}.${capName}.${prop}`, params)
          },
        },
      )
      // Idempotent (re)registration. The reload path (`ensureGroupRunner`)
      // re-runs this after a `$process.restart` of the SUBPROCESS, but the
      // agent's central registry still holds the proxy from the previous
      // registration — the subprocess restart never touched it. Since
      // `registerProvider` throws on a duplicate `(cap, addonId)` pair (a
      // deliberate guard against a double `registerProvider` in one init
      // path), drop the stale proxy first so the fresh one installs cleanly.
      // On the boot path nothing is registered yet, so this is a no-op.
      // Without this, an in-place addon update/redeploy leaves the whole group
      // stuck in `error` until a full agent (main-process) restart clears the
      // registry.
      if (deps.capabilityRegistry.hasProvider(capName, a.addonId)) {
        deps.capabilityRegistry.unregisterProvider(capName, a.addonId)
      }
      deps.capabilityRegistry.registerProvider(capName, a.addonId, proxy)
    }
    deps.loadedAddons.set(a.addonId, {
      id: a.addonId,
      status: 'running',
      version: a.version,
      packageName: a.packageName,
      packageVersion: a.packageVersion,
    })
  }
}

/**
 * Ensure a group runner is live with the CURRENT on-disk addon code, then wire
 * its providers.
 *
 * A redeploy's runner is already running (the deploy step swapped its on-disk
 * code but never killed the process), and `$process.spawnRunner` throws
 * "already running" for a live runnerId. So restart first — `$process.restart`
 * stops the old child, evicts it from the Moleculer registry, and re-spawns it
 * from the same dir (now holding the new code) in a subprocess, off the agent's
 * main event loop. Only when no runner exists yet (first deploy →
 * `{success:false, reason:'not found'}`) do we `$process.spawnRunner`.
 *
 * On a hard failure of both paths the addons are marked `error` (no providers
 * registered) so `$agent.status` reports the degraded state.
 */
export async function ensureGroupRunner(
  deps: GroupRunnerDeps,
  groupId: string,
  addons: readonly GroupCandidate[],
): Promise<void> {
  try {
    const restart = await deps.broker.call<RestartResult>('$process.restart', { name: groupId })
    if (!restart.success) {
      if (restart.reason !== undefined && restart.reason !== 'not found') {
        deps.logger.warn(
          `group "${groupId}" restart returned "${restart.reason}" — spawning a fresh runner`,
        )
      }
      await deps.broker.call('$process.spawnRunner', {
        runnerId: groupId,
        addons: addons.map((a) => ({ addonId: a.addonId, addonDir: a.addonDir })),
      })
    }
    registerGroupRunnerProviders(deps, addons)
    deps.logger.info(
      `group "${groupId}" live with ${addons.length} addon(s): ${addons.map((a) => a.addonId).join(', ')}`,
    )
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
    deps.logger.error(`failed to ensure group "${groupId}": ${msg}`)
    for (const a of addons) {
      deps.loadedAddons.set(a.addonId, { id: a.addonId, status: 'error' })
    }
  }
}
