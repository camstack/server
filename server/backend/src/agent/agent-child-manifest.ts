import type {
  ChildCapDescriptor,
  RegisteredAddonManifest,
  RegisterNodeParams,
} from '@camstack/server/system'

/**
 * Adapt a child's UDS `ChildCapDescriptor[]` into a `RegisterNodeParams` for the agent's subtree
 * HubNodeRegistry.
 *
 * Multi-addon manifest support (co-location): descriptors are grouped by the `addonId` each one
 * carries, producing one manifest entry per hosted addon, so a GROUPED runner (`execution.group`)
 * registers each addon's caps under its REAL addon id. A legacy child that omits `addonId` falls
 * back to `childId`.
 *
 * `hostedAddons` are the addons the agent's spawn plan put in this runner. They get an entry even
 * with no caps: the PRE-INIT register carries none, yet the hub verifies a caller stamp (a member
 * addon id, for the caps keyed by the addon) against this manifest, and a grouped addon's first
 * calls (its migrations) happen during init, before the post-init register.
 *
 * Only system (non-device-scoped) caps go into `addons`; device-scoped native caps arrive on a
 * later re-handshake via the Moleculer path.
 */
export function buildAgentChildUdsManifest(
  nodeId: string,
  childId: string,
  caps: readonly ChildCapDescriptor[],
  hostedAddons: readonly string[] = [],
): RegisterNodeParams {
  const capsByAddon = new Map<string, Set<string>>()
  for (const addonId of hostedAddons) capsByAddon.set(addonId, new Set<string>())
  for (const cap of caps) {
    if (cap.deviceId !== undefined) continue
    const addonId = cap.addonId ?? childId
    const set = capsByAddon.get(addonId) ?? new Set<string>()
    set.add(cap.capName)
    capsByAddon.set(addonId, set)
  }
  // A register that declared no system cap keeps the runner's own entry (pre-init, as before).
  if (!capsByAddon.has(childId) && !caps.some((cap) => cap.deviceId === undefined)) {
    capsByAddon.set(childId, new Set<string>())
  }
  const addons: readonly RegisteredAddonManifest[] = [...capsByAddon.entries()].map(
    ([addonId, capNames]) => ({ addonId, capabilities: [...capNames] }),
  )
  return { nodeId, addons }
}
