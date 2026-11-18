/**
 * What an Ecowitt Gateway device declares as its identity (D1059): the MAC and
 * the address it is dialled at.
 *
 * The gateway's local HTTP API this addon polls (`/get_version`,
 * `/get_livedata_info`, `/get_sensors_info`) reports no MAC. The LAN scan does:
 * the `CMD_BROADCAST` reply carries it, and the scan candidate carries it through
 * adoption into the integration's connection (`mac`). A gateway set up by hand
 * has none, so `mac` is `unread` — a value stored earlier is kept, never replaced
 * by "absent" (D49, D393). A push-listener gateway, or one whose client is not
 * running, declares nothing: its address is not known to this addon.
 *
 * Sensors share no hardware identifier with the gateway and declare none.
 */
import type { DeviceIdentifierKey, RawDeviceIdentifiers } from '@camstack/types'
import type { EcowittConfig } from './config.js'

export interface EcowittIdentifierDeclaration {
  readonly identifiers: RawDeviceIdentifiers
  readonly unread: readonly DeviceIdentifierKey[]
}

export function ecowittGatewayIdentifiers(
  connection: EcowittConfig | null,
): EcowittIdentifierDeclaration | null {
  if (connection === null || connection.transport !== 'local') return null
  const mac = connection.mac?.trim() ?? ''
  return {
    identifiers: { mac: mac.length > 0 ? mac : null, host: connection.host },
    unread: mac.length > 0 ? [] : ['mac'],
  }
}
