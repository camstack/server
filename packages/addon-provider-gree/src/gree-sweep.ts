import { networkInterfaces } from 'node:os'
import type { DiscoveredDevice } from '@apocaliss92/nodegree'
import type { IScopedLogger } from '@camstack/types'
import { discoverGreeDevices } from './gree-integration-manager.js'
import { scanGreeSubnets, type GreeSweep } from './gree-subnet-scan.js'

/** This node's own IPv4 addresses (what decides which configured subnets are on-link). */
export function localIpv4Addresses(): readonly string[] {
  const out: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address)
    }
  }
  return out
}

/**
 * The subnets the last discovery covered. The engine hands them to
 * `discoverDevices`; a re-bind that lost its AC reuses them to look for it on
 * the network it may have moved to.
 */
class GreeScanScope {
  #subnets: readonly string[] = []
  set(subnets: readonly string[]): void {
    this.#subnets = [...subnets]
  }
  get(): readonly string[] {
    return this.#subnets
  }
}
export const greeScanScope = new GreeScanScope()

/** Sweep `subnets` (broadcast + unicast on routed ones) with the nodegree scan, logging what is refused or fails. */
export async function sweepGreeSubnets(input: {
  readonly subnets: readonly string[]
  /** Operator-listed extra subnets of the integrations (`sweepSubnets`). */
  readonly extraSubnets?: readonly string[]
  readonly logger: IScopedLogger
  readonly sweep?: GreeSweep
  readonly localAddresses?: readonly string[]
}): Promise<readonly DiscoveredDevice[]> {
  const failed: string[] = []
  const found = await scanGreeSubnets({
    subnets: input.subnets,
    ...(input.extraSubnets !== undefined ? { extraSubnets: input.extraSubnets } : {}),
    localAddresses: input.localAddresses ?? localIpv4Addresses(),
    sweep: input.sweep ?? ((broadcastAddress) => discoverGreeDevices({ broadcastAddress })),
    onError: (target) => failed.push(target),
    onRefused: (refused) =>
      input.logger.warn('Gree subnet not swept by unicast', {
        meta: { subnet: refused.subnet, reason: refused.reason },
      }),
  })
  if (failed.length > 0) {
    input.logger.warn('Gree subnet sweeps failed — skipped', {
      meta: { failed: failed.length, first: failed[0] },
    })
  }
  return found
}
