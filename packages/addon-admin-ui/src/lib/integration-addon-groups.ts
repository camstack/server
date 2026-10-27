/**
 * integration-addon-groups — one entry per providing ADDON that has at least
 * one integration instance. The `/integrations` grid shows these instead of
 * one card per instance, so three instances all named "Casa" read as three
 * different providers.
 */
import type {
  Integration,
  IntegrationRowStatus,
} from '../components/integrations/integration-columns'

export interface IntegrationAddonGroup {
  readonly addonId: string
  /** The providing addon's friendly name (manifest `name`); falls back to the first instance's name. */
  readonly name: string
  readonly instances: readonly Integration[]
  readonly instanceCount: number
  /** Devices across every instance (the same count the table rows carry). */
  readonly deviceCount: number
  readonly status: IntegrationRowStatus
}

function aggregateStatus(instances: readonly Integration[]): IntegrationRowStatus {
  if (instances.some((i) => i.status === 'running')) return 'running'
  if (instances.some((i) => i.status === 'stopped')) return 'stopped'
  return 'disabled'
}

export function groupIntegrationsByAddon(
  rows: readonly Integration[],
  addonNames: ReadonlyMap<string, string>,
): readonly IntegrationAddonGroup[] {
  const byAddon = new Map<string, Integration[]>()
  for (const row of rows) {
    const list = byAddon.get(row.addonId)
    if (list === undefined) byAddon.set(row.addonId, [row])
    else list.push(row)
  }
  return [...byAddon.entries()].map(([addonId, instances]) => {
    const friendly = addonNames.get(addonId)?.trim() ?? ''
    return {
      addonId,
      name: friendly.length > 0 ? friendly : (instances[0]?.name ?? addonId),
      instances,
      instanceCount: instances.length,
      deviceCount: instances.reduce((sum, i) => sum + i.deviceCount, 0),
      status: aggregateStatus(instances),
    }
  })
}
