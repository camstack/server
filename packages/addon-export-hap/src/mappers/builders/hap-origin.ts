import type { HAPConnection } from '@homebridge/hap-nodejs'
import { type CommandOriginRequestOptions, commandOrigin } from '@dominevo/types/addon'

/**
 * The origin claim for a command a HomeKit controller wrote: the controller's
 * pairing id, which hap-nodejs reads off the encrypted session (`connection.username`).
 * Absent when the write did not come over an authenticated session (a local
 * `setValue`), in which case nothing is claimed. No label is known for a pairing,
 * so there is no `principalName`.
 */
export function hapOrigin(
  connection: HAPConnection | undefined,
): CommandOriginRequestOptions | undefined {
  const principalId = connection?.username
  if (principalId === undefined || principalId === '') return undefined
  return commandOrigin({ kind: 'on-behalf', source: 'homekit', principalId })
}
