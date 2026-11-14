import { DeviceType, type DiscoveryCandidate, type DiscoveryHit, type DiscoveryMode } from '@camstack/types'
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

/** One already-onboarded ONVIF camera, reduced to the identity a scan can produce. */
export interface OnboardedOnvifCamera {
  readonly deviceId: number
  readonly name: string
  readonly host: string
}

/** The candidate key a scan gives a host. A camera added by hand is stored under a different stableId. */
export function onvifCandidateStableId(host: string): string {
  return `onvif-${host.replace(/\./g, '-')}`
}

/**
 * Decide whether a discovered host is a camera this provider already owns. Host-keyed and
 * case-insensitive: only a camera adopted from a scan is stored under `onvif-<host>`, so a
 * stableId comparison misses one created by hand (`onvif-<epoch>`).
 */
export function findOnboardedOnvifMatch(
  host: string,
  onboarded: readonly OnboardedOnvifCamera[],
): OnboardedOnvifCamera | undefined {
  const needle = host.trim().toLowerCase()
  return onboarded.find((o) => o.host.trim().toLowerCase() === needle)
}

/** Map discovered ONVIF cameras to candidates, marking one already owned instead of offering it again. Pure. */
export function mapOnvifDiscoveryToCandidates(
  cameras: readonly DiscoveredOnvifCamera[],
  onboarded: readonly OnboardedOnvifCamera[] = [],
): readonly DiscoveryCandidate[] {
  return cameras.map((c) => {
    const match = findOnboardedOnvifMatch(c.host, onboarded)
    return {
      stableId: onvifCandidateStableId(c.host),
      type: DeviceType.Camera,
      suggestedName: c.name ?? c.host,
      prefilledConfig: {
        name: c.name ?? c.host,
        host: c.host,
        port: c.port,
        username: '',
        password: '',
      },
      ...(match !== undefined
        ? { alreadyOnboarded: true, onboardedDeviceId: match.deviceId, onboardedName: match.name }
        : {}),
    }
  })
}
