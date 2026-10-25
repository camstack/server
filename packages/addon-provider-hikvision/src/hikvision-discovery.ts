import { networkInterfaces } from 'node:os'
import { Discovery } from 'onvif'
import { HikvisionIsapiClient } from './hikvision-isapi-client.js'

/** A Hikvision camera found on the LAN (via WS-Discovery and/or an ISAPI subnet scan). */
export interface DiscoveredHikvisionCamera {
  readonly host: string
  readonly port: number
  readonly name?: string
  readonly model?: string
}

/** Shape emitted by the `onvif` Discovery 'device' event (untyped JS library). */
interface OnvifDiscoveryDevice {
  readonly hostname: string
  readonly port?: number
  readonly name?: string
  readonly manufacturer?: string
  readonly model?: string
  readonly scopes?: readonly string[]
}

/**
 * True when a WS-Discovery responder is a Hikvision (or Hikvision-firmware) device — matched on the
 * manufacturer field, name, or any ONVIF scope containing `hikvision`. Case-insensitive.
 */
function isHikvision(cam: OnvifDiscoveryDevice): boolean {
  const needle = 'hikvision'
  if ((cam.manufacturer ?? '').toLowerCase().includes(needle)) return true
  if ((cam.name ?? '').toLowerCase().includes(needle)) return true
  return (cam.scopes ?? []).some((s) => s.toLowerCase().includes(needle))
}

/**
 * Discover Hikvision cameras via ONVIF WS-Discovery (multicast probe on 239.255.255.250:3702).
 * Reuses the proven `onvif` library. Works when the runner can receive multicast — note a hub on a
 * macvlan/br0 network often CANNOT, so {@link discoverHikvisionViaHttpScan} is the reliable path.
 */
export async function discoverHikvisionCameras(
  timeout: number = 5000,
): Promise<readonly DiscoveredHikvisionCamera[]> {
  return new Promise((resolve) => {
    const byHost = new Map<string, DiscoveredHikvisionCamera>()
    Discovery.on('device', (rawCam: unknown) => {
      const cam = rawCam as OnvifDiscoveryDevice
      if (typeof cam.hostname !== 'string' || cam.hostname.length === 0) return
      if (!isHikvision(cam)) return
      if (byHost.has(cam.hostname)) return
      byHost.set(cam.hostname, {
        host: cam.hostname,
        port: cam.port ?? 80,
        ...(cam.name !== undefined ? { name: cam.name } : {}),
        ...(cam.model !== undefined ? { model: cam.model } : {}),
      })
    })
    Discovery.probe({ timeout })
    setTimeout(() => {
      Discovery.removeAllListeners('device')
      resolve([...byHost.values()])
    }, timeout + 500)
  })
}

export interface HttpScanOptions {
  /** IPv4 CIDR to scan (e.g. `192.168.10.0/24`). Omit to auto-detect the node's local /24. */
  readonly networkCidr?: string
  readonly username: string
  readonly password: string
  /** Per-host ISAPI probe timeout (ms). Default 1500. */
  readonly probeTimeoutMs?: number
  /** Max concurrent probes. Default 40. */
  readonly concurrency?: number
}

/**
 * Discover Hikvision cameras by probing every host in a subnet for the ISAPI
 * `/ISAPI/System/deviceInfo` endpoint (digest-auth). Unicast HTTP — reliable from a macvlan/br0
 * container where multicast WS-Discovery is not received. Requires credentials (ISAPI is
 * authenticated); a host that returns a valid Hikvision `deviceInfo` is kept.
 */
export async function discoverHikvisionViaHttpScan(
  opts: HttpScanOptions,
): Promise<readonly DiscoveredHikvisionCamera[]> {
  const hosts = enumerateHosts(opts.networkCidr ?? detectLocalCidr())
  const probeTimeoutMs = opts.probeTimeoutMs ?? 1500
  const concurrency = opts.concurrency ?? 40
  const found: DiscoveredHikvisionCamera[] = []

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < hosts.length) {
      const host = hosts[cursor++]
      if (host === undefined) return
      const client = new HikvisionIsapiClient({
        host,
        port: 80,
        https: false,
        username: opts.username,
        password: opts.password,
        defaultTimeoutMs: probeTimeoutMs,
      })
      try {
        const info = await client.getDeviceInfo()
        // Only a REAL Hikvision ISAPI `deviceInfo` counts — a non-Hikvision host that returns some
        // 200 (a NAS web UI, another device) parses into all-null tags. Require model + serial so a
        // host like the Unraid box itself is not offered as a camera.
        if (info.model === null || info.serialNumber === null) continue
        found.push({ host, port: 80, name: info.model, model: info.model })
      } catch {
        // not a reachable Hikvision ISAPI host (unreachable / 401 with bad creds / non-XML) — skip
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, () => worker()))
  return found
}

/** Enumerate the usable host addresses of an IPv4 `a.b.c.d/nn` (only /24-and-narrower supported). */
function enumerateHosts(cidr: string): string[] {
  const [base, bitsRaw] = cidr.split('/')
  const bits = Number.parseInt(bitsRaw ?? '24', 10)
  const octets = (base ?? '').split('.').map((o) => Number.parseInt(o, 10))
  if (octets.length !== 4 || octets.some((o) => !Number.isFinite(o))) return []
  if (bits < 24) return [] // guard against scanning huge ranges
  const [a, b, c] = octets
  const out: string[] = []
  for (let d = 1; d <= 254; d += 1) out.push(`${a}.${b}.${c}.${d}`)
  return out
}

/** Best-effort local /24 from the first non-internal IPv4 interface (e.g. `192.168.10.0/24`). */
function detectLocalCidr(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const [a, b, c] = addr.address.split('.')
        return `${a}.${b}.${c}.0/24`
      }
    }
  }
  return '192.168.10.0/24'
}

/** Flatten a host into a flat row-key slug — must match `generateStableId`'s host fallback so a
 *  re-scan of a host-added camera is detected as already onboarded. */
export function slugifyHikvisionHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
