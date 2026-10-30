import type { DiscoveryHit, DiscoveryMode } from '@camstack/types'
import { HikvisionIsapiClient } from './hikvision-isapi-client.js'

/** A Hikvision camera found on the LAN (via WS-Discovery and/or an ISAPI probe). */
export interface DiscoveredHikvisionCamera {
  readonly host: string
  readonly port: number
  readonly name?: string
  readonly model?: string
}

const ISAPI_PORT = 80

/**
 * How the scan engine finds a Hikvision camera: a WS-Discovery probe (matched on the
 * vendor name in the answer) and a unicast ISAPI probe. The engine only reports who
 * answers the ISAPI path; credentials never leave classification.
 */
export const HIKVISION_DISCOVERY_MODES: readonly DiscoveryMode[] = [
  { kind: 'ws-discovery', types: ['dn:NetworkVideoTransmitter'] },
  {
    kind: 'http-probe',
    port: ISAPI_PORT,
    path: '/ISAPI/System/deviceInfo',
    method: 'GET',
    tls: false,
    acceptStatus: [200, 401],
  },
]

const VENDOR_NEEDLE = 'hikvision'

function scopeValue(scopes: readonly string[], key: string): string | undefined {
  const marker = `onvif://www.onvif.org/${key}/`
  const scope = scopes.find((s) => s.startsWith(marker))
  if (scope === undefined) return undefined
  try {
    return decodeURIComponent(scope.slice(marker.length))
  } catch {
    return scope.slice(marker.length)
  }
}

function portOfXaddr(xaddrs: readonly string[]): number {
  for (const xaddr of xaddrs) {
    try {
      const url = new URL(xaddr)
      return url.port.length > 0 ? Number(url.port) : ISAPI_PORT
    } catch {
      // try the next address
    }
  }
  return ISAPI_PORT
}

/** Hikvision cameras among the WS-Discovery hits (vendor named in a scope), one per host. */
export function hikvisionFromWsdHits(
  hits: readonly DiscoveryHit[],
): readonly DiscoveredHikvisionCamera[] {
  const out = new Map<string, DiscoveredHikvisionCamera>()
  for (const hit of hits) {
    const wsd = hit.wsd
    if (wsd === undefined || out.has(hit.host)) continue
    if (!wsd.scopes.some((s) => s.toLowerCase().includes(VENDOR_NEEDLE))) continue
    const name = scopeValue(wsd.scopes, 'name')
    const model = scopeValue(wsd.scopes, 'hardware')
    out.set(hit.host, {
      host: hit.host,
      port: portOfXaddr(wsd.xaddrs),
      ...(name !== undefined ? { name } : {}),
      ...(model !== undefined ? { model } : {}),
    })
  }
  return [...out.values()]
}

export interface IsapiCredentials {
  readonly username: string
  readonly password: string
}

/**
 * Hosts that answered the ISAPI probe, confirmed with the operator's credentials: only a
 * REAL Hikvision `deviceInfo` (model and serial) counts, so a NAS answering 401 is not
 * offered as a camera. Without a password nothing is confirmed. One follow-up call per hit
 * host, never a sweep.
 */
export async function hikvisionFromHttpHits(
  hits: readonly DiscoveryHit[],
  credentials: IsapiCredentials | null,
  probeTimeoutMs = 1_500,
): Promise<readonly DiscoveredHikvisionCamera[]> {
  if (credentials === null) return []
  const hosts = [...new Set(hits.filter((h) => h.http !== undefined).map((h) => h.host))]
  const found: DiscoveredHikvisionCamera[] = []
  await Promise.all(
    hosts.map(async (host) => {
      const client = new HikvisionIsapiClient({
        host,
        port: ISAPI_PORT,
        https: false,
        username: credentials.username,
        password: credentials.password,
        defaultTimeoutMs: probeTimeoutMs,
      })
      try {
        const info = await client.getDeviceInfo()
        if (info.model === null || info.serialNumber === null) return
        found.push({ host, port: ISAPI_PORT, name: info.model, model: info.model })
      } catch {
        // unreachable, bad credentials or not ISAPI: not a camera we can offer
      }
    }),
  )
  return found
}

/** Flatten a host into a flat row-key slug — must match `generateStableId`'s host fallback so a
 *  re-scan of a host-added camera is detected as already onboarded. */
export function slugifyHikvisionHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
