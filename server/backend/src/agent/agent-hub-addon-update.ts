/**
 * Updating an addon from the agent itself (D840) — by asking the HUB.
 *
 * ── Who decides an agent's addon version ───────────────────────────────────
 * The hub. Every reconnect runs `reconcileAgentAddons` → `agent-addon-backfill`,
 * whose INTENDED VERSION is "the hub's own installed version, and only that".
 * A package installed on the agent at any other version is put back to the
 * hub's — which is why an update run on an agent before the hub is undone, and
 * why this module never installs anything locally.
 *
 * ── What the Update action does ───────────────────────────────────────────
 * It asks the hub, over the mesh channel the agent already holds (the mTLS
 * leaf; the bridge names the caller `node:<id>`), to deploy THE HUB'S version
 * of one package to THIS node: `addons.updatePackage({ name, version:
 * <hub version>, nodeId: <self> })`. The hub packs and pushes the tarball
 * (`$agent.deploy` + `$agent.reload`) and records nothing new — the version
 * it recorded is the version this node now runs, so the next reconcile finds
 * nothing to repair. A newer PUBLISHED release is a hub-level decision (it
 * moves every node), not something one agent can start.
 *
 * The hub accepts the call from an agent only under the scoped grant of D842
 * (`remote-addon-update-grant.ts`): own node, the hub's recorded version, audited.
 * Any refusal reaches the UI verbatim as the update's failure, never as silence.
 */
import { ADDON_VERSION_REASON_HUB, decideAddonVersionMove } from '@camstack/system'

/** Hub procedures this module calls, as `$core-caps` actions. */
export const HUB_ADDON_LIST_ACTION = '$core-caps.addons.list'
export const HUB_ADDON_UPDATE_ACTION = '$core-caps.addons.updatePackage'

/** An agent's deploy + reload of a large package can take minutes. */
export const HUB_UPDATE_TIMEOUT_MS = 330_000
const HUB_LIST_TIMEOUT_MS = 15_000

/** One hub call; the wiring passes `broker.call` bound to the hub node. */
export type HubCall = (action: string, params: unknown, timeoutMs: number) => Promise<unknown>

export type PackageUpdateStatus = 'running' | 'done' | 'failed'

/** What the UI shows for the last Update pressed on one package. */
export interface PackageUpdateProgress {
  readonly status: PackageUpdateStatus
  readonly targetVersion: string
  /** The hub's sentence: why it failed, or what it did. */
  readonly message: string | null
}

export type HubVersions =
  | { readonly ok: true; readonly versions: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly error: string }

export interface StartResult {
  readonly started: boolean
  readonly message: string | null
}

export interface AgentHubAddonControls {
  /** The versions the hub has installed — the authority for this node. */
  getHubVersions: () => Promise<HubVersions>
  /** Ask the hub to bring `packageName` on this node to the hub's version. */
  start: (packageName: string, installedPackages: readonly string[]) => Promise<StartResult>
  progress: () => ReadonlyMap<string, PackageUpdateProgress>
}

export interface AgentHubAddonDeps {
  readonly nodeId: string
  readonly callHub: HubCall
  readonly onProblem?: (message: string) => void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** `packageName → packageVersion` from an `addons.list` answer; unreadable rows are skipped. */
export function hubVersionsFromList(list: unknown): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  if (!Array.isArray(list)) return out
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const manifest: unknown = Reflect.get(item, 'manifest')
    if (manifest === null || typeof manifest !== 'object') continue
    const name: unknown = Reflect.get(manifest, 'packageName')
    const version: unknown = Reflect.get(manifest, 'packageVersion')
    if (typeof name === 'string' && typeof version === 'string' && !out.has(name)) {
      out.set(name, version)
    }
  }
  return out
}

/**
 * True when this node does not run the hub's version, in either direction.
 * Unknown on either side is not a difference — an unreadable hub is not a
 * reason to offer a move (D942, D49).
 */
export function isBehindHub(installed: string | null, hub: string | null): boolean {
  if (installed === null || hub === null) return false
  return decideAddonVersionMove(installed, hub, ADDON_VERSION_REASON_HUB).move
}

/** The hub answered `{ success: false, error }`, or something unreadable. */
function failureOf(result: unknown): string | null {
  if (result === null || typeof result !== 'object') return null
  if (Reflect.get(result, 'success') !== false) return null
  const error: unknown = Reflect.get(result, 'error')
  return typeof error === 'string' && error.length > 0 ? error : 'the hub reported a failure'
}

export function createAgentHubAddonControls(deps: AgentHubAddonDeps): AgentHubAddonControls {
  const states = new Map<string, PackageUpdateProgress>()

  const getHubVersions = async (): Promise<HubVersions> => {
    try {
      const list = await deps.callHub(HUB_ADDON_LIST_ACTION, undefined, HUB_LIST_TIMEOUT_MS)
      return { ok: true, versions: hubVersionsFromList(list) }
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) }
    }
  }

  const run = async (packageName: string, version: string): Promise<void> => {
    try {
      const result = await deps.callHub(
        HUB_ADDON_UPDATE_ACTION,
        { name: packageName, version, nodeId: deps.nodeId },
        HUB_UPDATE_TIMEOUT_MS,
      )
      const failure = failureOf(result)
      states.set(
        packageName,
        failure === null
          ? { status: 'done', targetVersion: version, message: null }
          : { status: 'failed', targetVersion: version, message: failure },
      )
      if (failure !== null) {
        deps.onProblem?.(`hub refused to update ${packageName} to ${version}: ${failure}`)
      }
    } catch (err: unknown) {
      const message = errorMessage(err)
      states.set(packageName, { status: 'failed', targetVersion: version, message })
      deps.onProblem?.(`update of ${packageName} to ${version} through the hub failed: ${message}`)
    }
  }

  return {
    getHubVersions,
    progress: () => states,
    start: async (packageName, installedPackages) => {
      if (!installedPackages.includes(packageName)) {
        return { started: false, message: `${packageName} is not installed on this node.` }
      }
      if (states.get(packageName)?.status === 'running') {
        return { started: false, message: `${packageName} is already being updated.` }
      }
      const hub = await getHubVersions()
      if (!hub.ok) {
        return {
          started: false,
          message: `The hub could not be asked which version this node should run: ${hub.error}`,
        }
      }
      const hubVersion = hub.versions.get(packageName)
      if (hubVersion === undefined) {
        return {
          started: false,
          message: `The hub does not install ${packageName}, so it has no version to bring this node to.`,
        }
      }
      states.set(packageName, { status: 'running', targetVersion: hubVersion, message: null })
      // Not awaited: a deploy + reload outlives any request. The UI polls.
      void run(packageName, hubVersion)
      return { started: true, message: null }
    },
  }
}
