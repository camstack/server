import type { DiscoveryMode } from '@camstack/types'
import type { ReolinkDiscoveredHost } from './reolink-discovery-map.js'

/**
 * Reolink cameras answer a vendor UDP broadcast (Baichuan) and ONVIF through the nodelink
 * library, which owns both protocols' framing. The engine cannot send either, so the addon
 * keeps `discoverDevices` and runs the library once per subnet the engine covers.
 */
export const REOLINK_DISCOVERY_MODES: readonly DiscoveryMode[] = [
  {
    kind: 'custom',
    reason:
      'Reolink answers a Baichuan vendor UDP broadcast and ONVIF that only the nodelink library speaks; this addon runs it once per covered subnet',
  },
]

/** The subnets handed in by the discovery orchestrator (`params.subnets`), or [] when absent. */
export function subnetsFromParams(params: Record<string, unknown> | undefined): readonly string[] {
  const raw = params?.['subnets']
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is string => typeof s === 'string' && s.length > 0)
}

/**
 * Run `scan` once per covered subnet (once with no CIDR when the engine named none) and merge
 * the answers by host. A subnet whose scan fails is skipped and reported to `onError`.
 */
export async function scanReolinkSubnets<T extends ReolinkDiscoveredHost>(input: {
  readonly subnets: readonly string[]
  readonly scan: (networkCidr: string | undefined) => Promise<readonly T[]>
  readonly onError?: (cidr: string | undefined, error: unknown) => void
}): Promise<readonly T[]> {
  const targets: readonly (string | undefined)[] =
    input.subnets.length > 0 ? input.subnets : [undefined]
  const byHost = new Map<string, T>()
  for (const cidr of targets) {
    try {
      for (const device of await input.scan(cidr)) {
        if (!byHost.has(device.host)) byHost.set(device.host, device)
      }
    } catch (error) {
      input.onError?.(cidr, error)
    }
  }
  return [...byHost.values()]
}
