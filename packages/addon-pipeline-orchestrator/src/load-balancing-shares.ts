/**
 * The share write of the Load balancing tab (D748), as a pure transform of
 * the agent-settings blob — the store runs it inside ONE read-modify-write
 * (`rewriteAgentSettingsMap`), so moving a slider stack is one write instead
 * of N racing per-node writes.
 *
 * Writes only `detectWeight` and `inferenceDevices[key].weight`. Every other
 * field — caps, capabilities, enablement, models — is carried over as is. A
 * device without a stored entry is made explicit with its EFFECTIVE
 * enablement (the schema requires `enabled`); a device whose enablement is
 * not known is not written at all, so a share can never invent a device.
 */
import type { AgentSettingsMapBlob } from './orchestrator-store-schemas.js'

export interface LoadBalancingSharesWrite {
  readonly nodes: Readonly<Record<string, number>>
  readonly devices: Readonly<Record<string, Readonly<Record<string, number>>>>
  /** nodeId → deviceKey → effective enablement, for devices with no stored entry. */
  readonly effectiveEnabled: Readonly<Record<string, Readonly<Record<string, boolean>>>>
}

type AgentEntry = AgentSettingsMapBlob[string]
type DeviceMap = NonNullable<AgentEntry['inferenceDevices']>

function nextDevices(
  stored: DeviceMap | undefined,
  shares: Readonly<Record<string, number>>,
  effective: Readonly<Record<string, boolean>>,
): DeviceMap | undefined {
  let changed = false
  const out: DeviceMap = { ...stored }
  for (const [key, weight] of Object.entries(shares)) {
    const existing = stored?.[key]
    if (existing !== undefined) {
      out[key] = { ...existing, weight }
      changed = true
      continue
    }
    const enabled = effective[key]
    if (enabled === undefined) continue
    out[key] = { enabled, weight }
    changed = true
  }
  return changed ? out : stored
}

export function applyLoadBalancingShares(
  prev: AgentSettingsMapBlob,
  write: LoadBalancingSharesWrite,
): AgentSettingsMapBlob {
  const next: AgentSettingsMapBlob = { ...prev }
  const nodeIds = new Set([...Object.keys(write.nodes), ...Object.keys(write.devices)])
  for (const nodeId of nodeIds) {
    const existing = prev[nodeId]
    const nodeShare = write.nodes[nodeId]
    const devices = nextDevices(
      existing?.inferenceDevices,
      write.devices[nodeId] ?? {},
      write.effectiveEnabled[nodeId] ?? {},
    )
    if (nodeShare === undefined && devices === existing?.inferenceDevices) continue
    const base: AgentEntry = existing ?? { maxCameras: null }
    next[nodeId] = {
      ...base,
      ...(nodeShare !== undefined ? { detectWeight: nodeShare } : {}),
      ...(devices !== undefined ? { inferenceDevices: devices } : {}),
    }
  }
  return next
}
