import type { DiscoveryHit, DiscoveryMode } from '@camstack/types'
import { AmcrestCgiClient } from './amcrest-cgi-client.js'

/** A Amcrest or Dahua camera found on the LAN (via WS-Discovery and/or a CGI probe). */
export interface DiscoveredAmcrestCamera {
  readonly host: string
  readonly port: number
  readonly name?: string
  readonly model?: string
}

const CGI_PORT = 80

/**
 * How the scan engine finds a Amcrest camera: a WS-Discovery probe (matched on the
 * vendor name in the answer) and a unicast CGI probe. The engine only reports who
 * answers the CGI path; credentials never leave classification.
 */
export const AMCREST_DISCOVERY_MODES: readonly DiscoveryMode[] = [
  { kind: 'ws-discovery', types: ['dn:NetworkVideoTransmitter'] },
  {
    kind: 'http-probe',
    port: CGI_PORT,
    path: '/cgi-bin/magicBox.cgi?action=getSystemInfo',
    method: 'GET',
    tls: false,
    acceptStatus: [200, 401],
  },
]

/** Amcrest is a Dahua OEM brand: both names identify the vendor. */
const VENDOR_NEEDLES = ['amcrest', 'dahua']

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
      return url.port.length > 0 ? Number(url.port) : CGI_PORT
    } catch {
      // try the next address
    }
  }
  return CGI_PORT
}

/** Amcrest cameras among the WS-Discovery hits (vendor named in a scope), one per host. */
export function amcrestFromWsdHits(
  hits: readonly DiscoveryHit[],
): readonly DiscoveredAmcrestCamera[] {
  const out = new Map<string, DiscoveredAmcrestCamera>()
  for (const hit of hits) {
    const wsd = hit.wsd
    if (wsd === undefined || out.has(hit.host)) continue
    const named = [...wsd.scopes, scopeValue(wsd.scopes, 'name') ?? ''].map((t) => t.toLowerCase())
    if (!named.some((t) => VENDOR_NEEDLES.some((n) => t.includes(n)))) continue
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
 * Hosts that answered the CGI probe, confirmed with the operator's credentials: only a
 * REAL `getSystemInfo` answer (deviceType and serial) counts, so a NAS answering 401 is not
 * offered as a camera. Without a password nothing is confirmed. One follow-up call per hit
 * host, never a sweep.
 */
export async function amcrestFromHttpHits(
  hits: readonly DiscoveryHit[],
  credentials: IsapiCredentials | null,
  probeTimeoutMs = 1_500,
): Promise<readonly DiscoveredAmcrestCamera[]> {
  if (credentials === null) return []
  const hosts = [...new Set(hits.filter((h) => h.http !== undefined).map((h) => h.host))]
  const found: DiscoveredAmcrestCamera[] = []
  await Promise.all(
    hosts.map(async (host) => {
      const client = new AmcrestCgiClient({
        host,
        port: CGI_PORT,
        https: false,
        username: credentials.username,
        password: credentials.password,
        defaultTimeoutMs: probeTimeoutMs,
      })
      try {
        const info = await client.getDeviceInfo()
        if (info.deviceType === null || info.serialNumber === null) return
        found.push({ host, port: CGI_PORT, name: info.deviceType, model: info.deviceType })
      } catch {
        // unreachable, bad credentials or not CGI: not a camera we can offer
      }
    }),
  )
  return found
}

/** Flatten a host into a flat row-key slug — must match `generateStableId`'s host fallback so a
 *  re-scan of a host-added camera is detected as already onboarded. */
export function slugifyAmcrestHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
