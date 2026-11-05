import type { DiscoveredDevice } from '@apocaliss92/nodegree'
import { macKey } from './gree-gateway.js'

/** An adopted AC as the follow step sees it. */
export interface GreeKnownAc {
  readonly deviceId: number
  readonly mac: string
  readonly host: string
}

/** One AC found at an address other than the one it is bound to. */
export interface GreeMove {
  readonly deviceId: number
  readonly mac: string
  readonly oldIp: string
  readonly newIp: string
}

/**
 * The adopted ACs whose MAC answered from a different IP. The MAC is the identity
 * (stableId `gree:<mac>`); the address is only where it currently lives. Pure.
 */
export function planMacFollow(
  responders: readonly Pick<DiscoveredDevice, 'mac' | 'ip'>[],
  known: readonly GreeKnownAc[],
): readonly GreeMove[] {
  const ipByMac = new Map<string, string>()
  for (const responder of responders) ipByMac.set(macKey(responder.mac), responder.ip)
  const moves: GreeMove[] = []
  for (const ac of known) {
    const seen = ipByMac.get(macKey(ac.mac))
    if (seen !== undefined && seen !== ac.host.trim()) {
      moves.push({
        deviceId: ac.deviceId,
        mac: ac.mac,
        oldIp: ac.host,
        newIp: seen,
      })
    }
  }
  return moves
}
