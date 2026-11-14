import { DeviceType, type DiscoveryCandidate, type DiscoveryHit, type DiscoveryMode } from '@camstack/types'
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

/** One already-onboarded Hikvision camera, reduced to the identity a scan can produce.
 *  Built by the addon from its live device list; the matching stays pure. */
export interface OnboardedHikvisionCamera {
  readonly deviceId: number
  readonly name: string
  readonly host?: string
}

/**
 * Decide whether a discovered host is a camera this provider already owns.
 *
 * Host-keyed, compared through the same slug `generateStableId`'s host fallback uses (so a
 * case or formatting difference in the stored host does not hide the match). Discovery can't
 * do better than host: the ISAPI probe here confirms `deviceInfo` (model, serial), never the
 * network interface, so it can't reproduce the `mac-<mac>` stableId `onCreateDevice` persists
 * once it probes the MAC separately — a stableId-only comparison never fires for an adopted
 * camera, which is why this candidate carries `alreadyOnboarded` instead (mirrors Reolink's
 * `findOnboardedMatch`).
 */
export function findOnboardedHikvisionMatch(
  host: string,
  onboarded: readonly OnboardedHikvisionCamera[],
): OnboardedHikvisionCamera | undefined {
  const needle = slugifyHikvisionHost(host)
  return onboarded.find((o) => o.host !== undefined && slugifyHikvisionHost(o.host) === needle)
}

/** Scan-form credentials threaded into every candidate so a one-click adopt authenticates. */
export interface HikvisionDiscoveryCredentials {
  readonly username?: string
  readonly password?: string
}

/**
 * Map confirmed Hikvision hosts to adoption candidates, marking one this provider already
 * owns instead of offering it again (see {@link findOnboardedHikvisionMatch}). Pure: no I/O.
 */
export function mapHikvisionDiscoveryToCandidates(
  cameras: readonly DiscoveredHikvisionCamera[],
  credentials: HikvisionDiscoveryCredentials,
  onboarded: readonly OnboardedHikvisionCamera[] = [],
): readonly DiscoveryCandidate[] {
  const username = credentials.username?.trim() ?? ''
  const password = credentials.password ?? ''
  return cameras.map((c) => {
    const displayName = c.name ?? c.model ?? c.host
    const match = findOnboardedHikvisionMatch(c.host, onboarded)
    return {
      // Best-effort: the authoritative id is `mac-<mac>` (learned during the ISAPI probe at adopt
      // time). Discovery has no MAC, so the host slug keys the candidate.
      stableId: `host-${slugifyHikvisionHost(c.host)}`,
      type: DeviceType.Camera,
      suggestedName: displayName,
      prefilledConfig: {
        name: displayName,
        host: c.host,
        port: c.port,
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
      },
      ...(match !== undefined
        ? { alreadyOnboarded: true, onboardedDeviceId: match.deviceId, onboardedName: match.name }
        : {}),
    }
  })
}
