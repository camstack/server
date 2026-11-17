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
