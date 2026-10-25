/**
 * The agent addon roster, as the hub sees it.
 *
 * An agent has no npm runtime: it reports what it has installed via
 * `$agent.status` and the hub does the registry diff
 * (`AddonPackageService.checkUpdatesForInstalled`). Extracted from
 * `cap-providers.ts` so the availability poller and the `addons.listUpdates`
 * cap route read the roster through ONE function — a second copy would drift
 * the framework filter and make the two surfaces disagree about what is
 * installed on a node.
 */
import { isFrameworkPackage } from '../addon/addon-package.service.js'

/**
 * Local narrowing of Moleculer's broker — the same shim `cap-providers.ts`
 * uses, for the same reason (Moleculer's typings chain through an
 * untyped `eventemitter2`).
 */
export interface AgentStatusBroker {
  call<T = unknown>(
    action: string,
    params?: unknown,
    opts?: { nodeID?: string; timeout?: number },
  ): Promise<T>
}

export interface InstalledPackageRef {
  readonly name: string
  readonly version: string
}

interface AgentStatusReply {
  readonly addons?: readonly {
    readonly id: string
    readonly status: string
    readonly version?: string
    readonly packageName?: string
  }[]
}

/** Timeout for `$agent.status`; a node that cannot answer this fast is unwell. */
export const AGENT_STATUS_TIMEOUT_MS = 5_000

export async function fetchAgentInstalledPackages(
  broker: AgentStatusBroker,
  nodeId: string,
): Promise<readonly InstalledPackageRef[]> {
  const status = await broker.call<AgentStatusReply>(
    '$agent.status',
    {},
    { nodeID: nodeId, timeout: AGENT_STATUS_TIMEOUT_MS },
  )
  const out: InstalledPackageRef[] = []
  for (const addon of status.addons ?? []) {
    if (typeof addon.packageName !== 'string' || typeof addon.version !== 'string') continue
    if (isFrameworkPackage(addon.packageName)) continue
    out.push({ name: addon.packageName, version: addon.version })
  }
  return out
}
