/**
 * What a UniFi infra device (console, switch, access point) declares as its
 * identity (D1059): its MAC, its serial (`ubiquiti:<serial>`, only a local
 * account reads one) and its LAN IP (weak).
 *
 * A value the snapshot lacks is `unread`, never "found absent": the Integration
 * API omits a serial always and a MAC or IP on some models, so a missing value
 * says nothing about the hardware and the stored one is kept (D49). No live
 * snapshot at all (the controller's last read failed, or it no longer lists the
 * device) declares nothing.
 */
import type { DeviceIdentifierKey, RawDeviceIdentifiers } from '@camstack/types'
import type { UnifiInfraSnapshot } from './unifi-client-contract.js'

export interface UnifiIdentifierDeclaration {
  readonly identifiers: RawDeviceIdentifiers
  readonly unread: readonly DeviceIdentifierKey[]
}

export function unifiInfraIdentifiers(
  snapshot: UnifiInfraSnapshot | null,
): UnifiIdentifierDeclaration | null {
  if (snapshot === null) return null
  const unread: DeviceIdentifierKey[] = []
  if (snapshot.mac === null) unread.push('mac')
  if (snapshot.serial === null) unread.push('serial')
  if (snapshot.ip === null) unread.push('ip')
  return {
    identifiers: {
      mac: snapshot.mac,
      serial:
        snapshot.serial === null ? null : { manufacturer: 'Ubiquiti', serial: snapshot.serial },
      ip: snapshot.ip,
    },
    unread,
  }
}

/**
 * The clients a PoE port answers for: every client it saw before and still has
 * no reason to drop, plus the ones it sees now. A client missing for a poll (a
 * camera that rebooted) stays; one the controller now shows on ANOTHER port has
 * moved and goes. Order is sorted, so the declaration does not flap.
 */
export function portKnownClients(
  known: readonly string[],
  current: readonly string[],
  elsewhere: ReadonlySet<string>,
): readonly string[] {
  const all = new Set([...known, ...current].map((m) => m.toLowerCase()))
  return [...all].filter((m) => !elsewhere.has(m)).sort()
}

/**
 * What a PoE port declares ATTACHED to it (D1063): its wired clients' MACs and,
 * for a port with exactly one client, its IP. Clients the port sees NOW are a
 * fresh read; a port with none now but a remembered set declares those MACs
 * `unread` together with the IP: kept (D49) and marked retained, so a port that
 * freshly reads the same MAC takes the link from this one. A client missing
 * while others are present stays in the declared set (one poll without a client
 * is not a different client). An IP the controller does not know is `unread`.
 * A port that never saw a client declares nothing.
 */
export function unifiPortAttachedIdentifiers(
  knownMacs: readonly string[],
  currentMacs: readonly string[],
  clientIp: string | null,
): UnifiIdentifierDeclaration | null {
  if (currentMacs.length > 0) {
    const single = knownMacs.length === 1
    return {
      identifiers: { mac: knownMacs, ip: single ? clientIp : null },
      unread: single && clientIp === null ? ['ip'] : [],
    }
  }
  if (knownMacs.length === 0) return null
  return { identifiers: { mac: knownMacs, ip: null }, unread: ['mac', 'ip'] }
}

/**
 * A port below this draw (W) feeds nothing: PoE off, or an idle reading that a
 * self-powered switch behind the port produces. A camera draws several watts.
 */
export const PORT_POWERING_MIN_W = 1

/**
 * Whether a port is delivering PoE, so its clients may be LINKED as powered by it
 * (D1063). A link is created only while this holds; a link that exists is kept
 * through a transient 0 W reading. A reading the controller did not give (null)
 * is unknown, not zero (D393): it does not refuse.
 */
export function portIsPowering(port: {
  readonly poeOn: boolean
  readonly poePowerW: number | null
}): boolean {
  if (!port.poeOn) return false
  return port.poePowerW === null || port.poePowerW > PORT_POWERING_MIN_W
}
