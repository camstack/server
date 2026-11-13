import type { LinkEndpoint } from '../ccu/ccu-schemas.js'

/**
 * How a link end reads: the CCU's channel name, else the device name with the
 * channel index, else the bare address. Never a made-up name.
 */
export function endpointLabel(endpoint: LinkEndpoint): string {
  if (endpoint.name !== null) return endpoint.name
  const colon = endpoint.address.lastIndexOf(':')
  const index = colon === -1 ? '' : endpoint.address.slice(colon + 1)
  if (endpoint.deviceName !== null && index !== '') return `${endpoint.deviceName}:${index}`
  return endpoint.address
}
