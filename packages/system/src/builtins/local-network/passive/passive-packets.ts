/**
 * Turn one multicast datagram into what the proposal stream understands.
 * Pure: a malformed or irrelevant packet yields nothing.
 */
import type { DiscoveryObservation } from '@camstack/types'
import { parseMdnsMessage } from '../scan/dns-wire.js'

const MAX_HEADERS = 32
const SSDP_PORT = 1900

export function parseMdnsPacket(data: Buffer): readonly DiscoveryObservation[] {
  return parseMdnsMessage(data)
    .filter((service) => service.port > 0)
    .map(
      (service): DiscoveryObservation => ({
        kind: 'mdns',
        serviceType: service.serviceType,
        instance: service.instance,
        host: service.host,
        address: service.address,
        port: service.port,
        txt: service.txt,
      }),
    )
}

/** A NOTIFY (`NT`) or a search response (`ST`); an M-SEARCH request is somebody asking. */
export function parseSsdpPacket(data: Buffer, from: string): DiscoveryObservation | null {
  const lines = data.toString('utf8').split(/\r?\n/)
  const first = lines[0] ?? ''
  const isNotify = /^NOTIFY\s/i.test(first)
  if (!isNotify && !/^HTTP\/1\.[01]\s+200/.test(first)) return null
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    if (Object.keys(headers).length >= MAX_HEADERS) break
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  if (isNotify && headers['nts'] !== 'ssdp:alive') return null
  const target = isNotify ? headers['nt'] : headers['st']
  if (target === undefined || target.length === 0) return null
  return { kind: 'ssdp', host: from, port: SSDP_PORT, target, headers }
}

/** What identifies a sighting for de-duplication: who said it and about what. */
export function observationKey(o: DiscoveryObservation): string {
  return o.kind === 'mdns'
    ? `mdns|${o.address ?? o.host}|${o.serviceType}|${o.instance}`
    : `ssdp|${o.host}|${o.target}`
}
