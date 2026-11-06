import type { HubNodeRegistry } from '@camstack/server/system'

/**
 * Does `nodeId` (an agent) host the runner `runnerId`? Read from what the node itself
 * registered: its manifest names the addons it runs, and an addon's runner is its
 * `execution.group` or itself. A node that never registered hosts nothing.
 *
 * A stamp names a runner id (any cap) or, for the caps keyed by the ADDON (`records`,
 * `migrations`), the member addon of a grouped runner; both resolve through the manifest.
 */
export function isRunnerHostedByNode(
  registry: Pick<HubNodeRegistry, 'listNodeIds' | 'getNodeManifest'>,
  runnerOfAddon: (addonId: string) => string,
  nodeId: string,
  runnerId: string,
): boolean {
  const nodes = registry.listNodeIds().filter((id) => id === nodeId || id.startsWith(`${nodeId}/`))
  if (nodes.includes(`${nodeId}/${runnerId}`)) return true
  for (const id of nodes) {
    for (const entry of registry.getNodeManifest(id) ?? []) {
      if (entry.addonId === runnerId || runnerOfAddon(entry.addonId) === runnerId) return true
    }
  }
  return false
}
