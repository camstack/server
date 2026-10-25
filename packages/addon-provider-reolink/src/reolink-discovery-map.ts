import { DeviceType, type DiscoveryCandidate } from '@camstack/types'

/**
 * Flatten a host (IP / hostname) into a flat row-key slug — shared by `generateStableId` and the
 * discovery candidate mapping so a host-keyed camera is detected as already onboarded on re-scan.
 */
export function slugifyReolinkHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The structural subset of the nodelink-js `DiscoveredDevice` the candidate mapping consumes. Kept
 * local (a `Pick`-style shape) so tests and the pure mapping don't depend on the full library type —
 * the library boundary stays in `addon.ts`.
 *
 * `httpPort` is the device's HTTP/ONVIF listener. It is deliberately NOT carried into
 * `prefilledConfig.port` — see the note on {@link mapReolinkDiscoveryToCandidates}.
 */
export interface ReolinkDiscoveredHost {
  readonly host: string
  readonly httpPort?: number
  readonly uid?: string
  readonly name?: string
  readonly model?: string
}

/** Optional scan-form credentials threaded into every candidate so a one-click adopt authenticates. */
export interface ReolinkDiscoveryCredentials {
  readonly username?: string
  readonly password?: string
}

/**
 * One already-onboarded Reolink device, reduced to the identities a scan can produce.
 * Built by the addon from its live device list; the mapping itself stays pure.
 */
export interface OnboardedReolinkDevice {
  readonly deviceId: number
  readonly name: string
  readonly host?: string
  readonly uid?: string
}

/**
 * Decide whether a discovered host is a device this provider already owns.
 *
 * Matching is by UID first (stable across a DHCP lease change) and by host second. A UID match
 * wins even when the host differs, because the address is the thing that moves.
 */
export function findOnboardedMatch(
  discovered: ReolinkDiscoveredHost,
  onboarded: readonly OnboardedReolinkDevice[],
): OnboardedReolinkDevice | undefined {
  if (discovered.uid !== undefined && discovered.uid !== '') {
    const byUid = onboarded.find((o) => o.uid === discovered.uid)
    if (byUid !== undefined) return byUid
  }
  return onboarded.find((o) => o.host !== undefined && o.host === discovered.host)
}

/**
 * Map discovered Reolink hosts to adoption {@link DiscoveryCandidate}s, de-duplicated by host (the
 * same camera can answer on more than one discovery method — UDP broadcast, ONVIF, HTTP scan). The
 * first responder for a host wins. Pure: no I/O.
 *
 * **The scan never supplies `port`.** `port` in the Reolink config schema is the BAICHUAN port
 * (default 9000). Discovery reports `httpPort`, the HTTP/ONVIF listener — on a Reolink Home Hub
 * that is 8000, while Baichuan lives on `mediaPort` 9000. Writing the discovered value into `port`
 * pointed every Baichuan login at the ONVIF listener, which accepts the TCP connection and then
 * closes it: `Baichuan socket closed`, 316 times in 12 hours, taking the hub and all three of its
 * child cameras offline. The default is correct; a non-default Baichuan port is an operator edit,
 * never a scan result.
 *
 * The authoritative stableId is `mac-<mac>` (learned during autodetect at adopt time), which discovery
 * can't produce — so candidates carry `alreadyOnboarded` rather than relying on a stableId match,
 * which never fires for a MAC-keyed device. Re-adding an owned device is how the port got clobbered
 * in the first place, so a scan says so instead of offering it again.
 */
export function mapReolinkDiscoveryToCandidates(
  devices: readonly ReolinkDiscoveredHost[],
  credentials: ReolinkDiscoveryCredentials,
  onboarded: readonly OnboardedReolinkDevice[] = [],
): readonly DiscoveryCandidate[] {
  const username = credentials.username?.trim() ?? ''
  const password = credentials.password ?? ''

  const byHost = new Map<string, ReolinkDiscoveredHost>()
  for (const d of devices) if (!byHost.has(d.host)) byHost.set(d.host, d)

  return [...byHost.values()].map((d) => {
    const displayName = d.name ?? d.model ?? d.host
    const match = findOnboardedMatch(d, onboarded)
    return {
      stableId: `host-${slugifyReolinkHost(d.host)}`,
      type: DeviceType.Camera,
      suggestedName: displayName,
      prefilledConfig: {
        name: displayName,
        host: d.host,
        transport: 'auto',
        ...(d.uid ? { uid: d.uid } : {}),
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
      },
      ...(match !== undefined
        ? { alreadyOnboarded: true, onboardedDeviceId: match.deviceId, onboardedName: match.name }
        : {}),
    }
  })
}
