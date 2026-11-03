/**
 * What the tunnel runs on: the record's body plus where it forwards to, which is a fact of the
 * node (D986). Pure functions, so the reading rules are one place and are specced.
 *
 * The origin keys live in `addon-settings` rows `<key>@<nodeId>`. A node row wins; while none
 * exists (the migration has not copied them yet) the bare row of the old layout is read, so a
 * tunnel never loses its origin because a migration was tolerated.
 */
import { normalizeNodeId } from '@camstack/types'
import type { CloudflareTunnelConfig } from './cloudflare-tunnel'
import { bodyFrom } from './migrations/connection-to-records'
import type { CloudflareTunnelBody } from './tunnel-record-kinds'

/** The port the Vite admin-ui dev server used; a tunnel pinned there answered "tunnel error". */
export const STALE_DEV_PORT = 3001

export interface NodeOrigin {
  readonly localHost: string
  readonly localPortMode: 'default' | 'custom'
  readonly localPort: number
  /** The stored port was the stale dev port and was read as automatic. */
  readonly staleDevPort: boolean
}

export const DEFAULT_NODE_ORIGIN: NodeOrigin = {
  localHost: '',
  localPortMode: 'default',
  localPort: 0,
  staleDevPort: false,
}

function nodeValue(store: Readonly<Record<string, unknown>>, key: string, node: string): unknown {
  const scoped = store[`${key}@${normalizeNodeId(node)}`]
  return scoped !== undefined ? scoped : store[key]
}

/** The origin of ONE node from the raw addon settings; a mistyped value takes the default. */
export function nodeOriginOf(store: Readonly<Record<string, unknown>>, node: string): NodeOrigin {
  const host = nodeValue(store, 'localHost', node)
  const mode = nodeValue(store, 'localPortMode', node)
  const port = nodeValue(store, 'localPort', node)
  const stale = port === STALE_DEV_PORT
  return {
    localHost: typeof host === 'string' ? host : DEFAULT_NODE_ORIGIN.localHost,
    localPortMode: mode === 'custom' ? 'custom' : 'default',
    localPort: typeof port === 'number' && !stale ? port : DEFAULT_NODE_ORIGIN.localPort,
    staleDevPort: stale,
  }
}

/** The record's body and the node's origin as the config the tunnel service takes. */
export function settingsOf(body: CloudflareTunnelBody, origin: NodeOrigin): CloudflareTunnelConfig {
  return {
    mode: body.mode,
    localPort: origin.localPort,
    localPortMode: origin.localPortMode,
    localHost: origin.localHost,
    noTLSVerify: body.noTLSVerify,
    originServerName: body.originServerName,
    httpHostHeader: body.httpHostHeader,
    customAccountId: body.customAccountId,
    customTunnelId: body.customTunnelId,
    customTunnelToken: body.customTunnelToken ?? '',
    customZoneId: body.customZoneId,
    customZoneName: body.customZoneName,
    customDnsRecordId: body.customDnsRecordId,
    customHostname: body.customHostname,
    customApiToken: body.customApiToken ?? '',
    debugLogging: body.debugLogging,
    protocol: body.protocol,
  }
}

/** The settings of the old layout, while no record exists (a tolerated migration). */
export function legacySettingsOf(
  store: Readonly<Record<string, unknown>>,
  node: string,
): CloudflareTunnelConfig {
  return settingsOf(bodyFrom(store), nodeOriginOf(store, node))
}
