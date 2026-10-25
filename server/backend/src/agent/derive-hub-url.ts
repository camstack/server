/**
 * Derive the agent's `CAMSTACK_HUB_URL` from its friendly `hubAddress`.
 *
 * `hubAddress` is the agent's single source of truth for "where is the hub"
 * (the Moleculer TCP dial target). The cross-node consumers of
 * `CAMSTACK_HUB_URL` — the pipeline-runner remote-source leg and the
 * cross-node recorder pull — only ever extract the HOSTNAME from it
 * (`resolveHubHostname` / `extractHost` in
 * `packages/addon-pipeline/src/shared/hub-hostname.ts`). Deriving the value
 * here removes the historical requirement to set a second, redundant env var
 * by hand on every remote agent (the cross-node-source trap).
 *
 * Accepts every friendly form `normalizeHubUrl`
 * (`packages/system/src/kernel/moleculer/broker-factory.ts`) accepts:
 *   `host`, `host:port`, `host:port/nodeID`, `nodeID@host`,
 *   `nodeID@host:port`, and bracketed IPv6 (`[::1]:6000`).
 * The optional `nodeID@` prefix and `/nodeID` suffix are stripped and the
 * Moleculer `:port` (6000-family) is dropped — only the host survives.
 *
 * Port note: the emitted `:4443` is the DEFAULT hub API port (matching the
 * hub-side default in `server/backend/src/api/addon-upload.ts` and the
 * manually-proven value used on live remote agents), NOT a probed value.
 * Because every current consumer keeps only the host, the port is convention;
 * a future full-URL consumer must treat it as the default, not authoritative.
 */

const HUB_API_PORT = 4443

export function deriveHubUrlFromHubAddress(hubAddress: string): string | undefined {
  const trimmed = hubAddress.trim()
  if (trimmed.length === 0) return undefined

  // Strip an optional `nodeID@` prefix.
  const afterAt = trimmed.includes('@') ? (trimmed.split('@')[1] ?? '') : trimmed
  // Strip an optional `/nodeID` suffix — keep only the `host[:port]` authority.
  const authority = afterAt.split('/')[0] ?? ''

  const host = extractHostFromAuthority(authority)
  if (host === undefined) return undefined
  return `https://${host}:${HUB_API_PORT}`
}

/**
 * Compute the `CAMSTACK_HUB_URL` value the agent should export, or `undefined`
 * when it must be left untouched. An explicit operator-provided env value
 * (`hubUrlWasExplicit`) always wins and is never clobbered — this preserves
 * today's working deployments. Kept pure (env is passed in) so both the
 * boot-time derivation and the reconnect path can be unit-tested.
 */
export function deriveHubUrlForExport(
  hubUrlWasExplicit: boolean,
  hubAddress: string | undefined,
): string | undefined {
  if (hubUrlWasExplicit) return undefined
  if (hubAddress === undefined) return undefined
  return deriveHubUrlFromHubAddress(hubAddress)
}

/** Take the bare host from a `host[:port]` authority, keeping bracketed IPv6. */
function extractHostFromAuthority(authority: string): string | undefined {
  const value = authority.trim()
  if (value.length === 0) return undefined
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end > 0) return value.slice(0, end + 1)
    return undefined
  }
  const host = value.split(':')[0] ?? ''
  return host.length > 0 ? host : undefined
}

/** The agent-side Moleculer registry view of a node (`registry.getNodeList`). */
export interface HubRegistryNode {
  readonly id: string
  readonly hostname?: string
  readonly ipList?: readonly string[]
}

/**
 * First non-internal IPv4 in a Moleculer node's advertised IP list.
 * Canonical home of this helper — `resolveHubEndpoint` in `agent-http.ts`
 * (UI-facing `resolvedHubAddress`) re-exports and reuses it.
 */
export function pickIpv4(ipList: readonly string[] | undefined): string | null {
  if (!ipList) return null
  for (const ip of ipList) {
    if (ip.includes(':')) continue // skip IPv6
    if (ip.startsWith('127.')) continue // skip loopback
    return ip
  }
  return null
}
