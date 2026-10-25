/**
 * Resolve the host a REMOTE node should use to dial the hub-only
 * stream-broker's restream port.
 *
 * The broker mints `127.0.0.1` restream URLs (hub-local). A cross-node
 * consumer — the recorder on a designated remote recording node, or the
 * pipeline-runner's remote-source leg (cross-node Phase 2) — must pull from
 * the hub, so it needs the hub's cluster-resolvable host. Resolution order:
 *
 *   1. `override` — an explicit operator setting (the recorder's
 *      `recordingHubHostname` global, or the runner attach payload's
 *      `frameSource.hubHostnameOverride`), when the auto-derived host isn't
 *      reachable for RTSP on the consuming interface.
 *   2. `hubUrl` — derived from the node's `CAMSTACK_HUB_URL` (the address it
 *      already uses to reach the hub). The RTSP restream port differs from
 *      the hub API port, but the HOST is the same — only the host is
 *      extracted.
 *
 * Returns `undefined` when neither yields a host (the caller logs / fails the
 * acquire; a `127.0.0.1` URL on a remote node would dial the wrong box).
 *
 * Pure: the env string is passed in (not read here) so it can be unit-tested.
 * Promoted from `recorder/addon/recording-hub-host.ts` in P2d so both
 * cross-node consumers share ONE resolver.
 */
export function resolveHubHostname(
  override: string | undefined,
  hubUrl: string | undefined,
): string | undefined {
  const trimmedOverride = override?.trim()
  if (trimmedOverride !== undefined && trimmedOverride.length > 0) return trimmedOverride
  return extractHost(hubUrl)
}

/** Extract the bare host from a URL/authority string, scheme + port optional. */
function extractHost(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (value === undefined || value.length === 0) return undefined
  // Try the WHATWG parser first (handles `https://host:port`, `tcp://host:port`).
  try {
    const parsed = new URL(value)
    if (parsed.hostname.length > 0) return parsed.hostname
  } catch {
    // Not a full URL — fall through to manual authority parsing.
  }
  // Manual: strip an optional `scheme://`, then take the authority before the
  // first `/`, and the host before an optional `:port`. Leaves bracketed IPv6
  // (`[::1]`) intact.
  const withoutScheme = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  const authority = withoutScheme.split('/')[0] ?? ''
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    if (end > 0) return authority.slice(0, end + 1)
  }
  const host = authority.split(':')[0] ?? ''
  return host.length > 0 ? host : undefined
}
