import type { DiscoveryHit, DiscoveryMode } from '@camstack/types'
import type { DiscoveredOnvifCamera } from './onvif-types.js'

const NVT_TYPE = 'NetworkVideoTransmitter'
const DEFAULT_ONVIF_PORT = 80

/** How the scan engine finds a camera: one WS-Discovery probe for ONVIF video transmitters. */
export const ONVIF_DISCOVERY_MODES: readonly DiscoveryMode[] = [
  { kind: 'ws-discovery', types: [`dn:${NVT_TYPE}`] },
]

/** The value of one `onvif://www.onvif.org/<key>/<value>` scope, decoded. */
function scopeValue(scopes: readonly string[], key: string): string | undefined {
  const marker = `onvif://www.onvif.org/${key}/`
  for (const scope of scopes) {
    if (!scope.startsWith(marker)) continue
    const raw = scope.slice(marker.length)
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return undefined
}

function portOfXaddr(xaddrs: readonly string[]): number {
  for (const xaddr of xaddrs) {
    try {
      const url = new URL(xaddr)
      if (url.port.length > 0) return Number(url.port)
      return url.protocol === 'https:' ? 443 : DEFAULT_ONVIF_PORT
    } catch {
      // A malformed address is skipped; the next one may parse.
    }
  }
  return DEFAULT_ONVIF_PORT
}

/** ONVIF cameras among the engine's WS-Discovery hits, one per host. */
export function onvifCamerasFromHits(
  hits: readonly DiscoveryHit[],
): readonly DiscoveredOnvifCamera[] {
  const out: DiscoveredOnvifCamera[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    const wsd = hit.wsd
    if (wsd === undefined || seen.has(hit.host)) continue
    if (wsd.types.length > 0 && !wsd.types.some((t) => t.endsWith(NVT_TYPE))) continue
    seen.add(hit.host)
    const name = scopeValue(wsd.scopes, 'name')
    const model = scopeValue(wsd.scopes, 'hardware')
    out.push({
      host: hit.host,
      port: portOfXaddr(wsd.xaddrs),
      ...(name !== undefined ? { name } : {}),
      ...(model !== undefined ? { model } : {}),
      scopes: wsd.scopes,
    })
  }
  return out
}
