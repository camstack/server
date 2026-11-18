/**
 * What an Ecowitt Gateway device declares as its identity (D1059): the MAC and
 * the address it is dialled at.
 *
 * The gateway's local HTTP API this addon polls (`/get_version`,
 * `/get_livedata_info`, `/get_sensors_info`) reports no MAC. The `CMD_BROADCAST`
 * reply does: the LAN scan carries it through adoption, and the connect probe
 * (`ecowitt-mac-probe.ts`) reads it from the configured host. Either way it is
 * stored on the integration's connection as `mac`, with `macHost`, the host it
 * was read at.
 *
 * A MAC is declared only for the host it was read at. No MAC, or one read at
 * another host (the gateway behind this config may have been swapped), leaves
 * `mac` unread: nothing is claimed, and a value stored earlier is not replaced by
 * "absent" (D49, D393). A push-listener gateway, or one whose client is not
 * running, declares nothing: its address is not known to this addon.
 *
 * Sensors share no hardware identifier with the gateway and declare none.
 */
import type { DeviceIdentifierKey, RawDeviceIdentifiers } from '@camstack/types'
import type { EcowittConfig, EcowittLocalConfig } from './config.js'

export interface EcowittIdentifierDeclaration {
  readonly identifiers: RawDeviceIdentifiers
  readonly unread: readonly DeviceIdentifierKey[]
}

/** The stored MAC when it was read at the host the connection dials now, else null. */
export function currentGatewayMac(connection: EcowittLocalConfig): string | null {
  const mac = connection.mac?.trim() ?? ''
  if (mac.length === 0) return null
  return connection.macHost?.trim() === connection.host.trim() ? mac : null
}

/** A local connection whose MAC is unknown for the host it dials: the connect probe reads it. */
export function needsGatewayMacRead(
  connection: EcowittConfig | null,
): connection is EcowittLocalConfig {
  return (
    connection !== null &&
    connection.transport === 'local' &&
    currentGatewayMac(connection) === null
  )
}

export function ecowittGatewayIdentifiers(
  connection: EcowittConfig | null,
): EcowittIdentifierDeclaration | null {
  if (connection === null || connection.transport !== 'local') return null
  const mac = currentGatewayMac(connection)
  return {
    identifiers: { mac, host: connection.host },
    unread: mac === null ? ['mac'] : [],
  }
}
