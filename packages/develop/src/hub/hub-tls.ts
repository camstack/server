/**
 * TLS trust for hub calls: a pinned certificate or the hub's CA — never
 * `NODE_TLS_REJECT_UNAUTHORIZED=0`, never `rejectUnauthorized: false`.
 *
 * A hub on the LAN serves a self-signed (or privately issued) certificate. The
 * operator tells the tools to trust it by dropping a PEM next to the session
 * cache as `~/.camstack/<host>_<port>.ca.pem` (or naming another file in
 * `$CAMSTACK_HUB_CA_FILE`): the hub's own certificate when it is self-signed,
 * or the CA that issued it (e.g. mkcert's `rootCA.pem`, never its key). The PEM
 * is a trust anchor for THAT hub only: standard verification still runs against
 * it — chain, expiry and host name. A leaf issued by a CA cannot be pinned on
 * its own (Node does not accept a partial chain); give the CA. A hub with a
 * publicly trusted certificate needs nothing at all.
 */
import * as fs from 'node:fs'
import * as https from 'node:https'
import * as path from 'node:path'
import { defaultSessionDir, slugForServer } from './session-store.js'

export interface HubTlsConfig {
  /** PEM text trusted for this hub (a pinned leaf or the hub's CA). */
  readonly ca?: string
  /** Where `ca` came from, for error messages. */
  readonly caFile?: string
}

/** `~/.camstack/<host>.ca.pem` — the default pin file for a hub. */
export function hubCaFileForServer(serverUrl: string, dir: string = defaultSessionDir()): string {
  return path.join(dir, `${slugForServer(serverUrl)}.ca.pem`)
}

/** The trust configuration for `serverUrl`; empty when the system store should decide. */
export function resolveHubTls(
  serverUrl: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  dir: string = defaultSessionDir(),
): HubTlsConfig {
  if (!serverUrl.startsWith('https:')) return {}
  const named = env['CAMSTACK_HUB_CA_FILE']?.trim()
  const candidate = named && named !== '' ? named : hubCaFileForServer(serverUrl, dir)
  try {
    return { ca: fs.readFileSync(candidate, 'utf8'), caFile: candidate }
  } catch (err) {
    if (named && named !== '') {
      throw new Error(`Cannot read the hub CA file named by CAMSTACK_HUB_CA_FILE: ${candidate}`, {
        cause: err,
      })
    }
    return {}
  }
}

/** A TLS failure, with the one fix that applies. */
export function explainTlsFailure(serverUrl: string, err: unknown): string | null {
  const code = err instanceof Error ? Reflect.get(err, 'code') : undefined
  const tlsCodes = [
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ]
  if (typeof code !== 'string' || !tlsCodes.includes(code)) return null
  return [
    `TLS verification of ${serverUrl} failed (${code}). Verification is never switched off.`,
    `  Trust this hub: save the PEM of its certificate (when self-signed) or of the CA that`,
    `  issued it (e.g. mkcert's rootCA.pem — never its key) to ${hubCaFileForServer(serverUrl)},`,
    '  or point $CAMSTACK_HUB_CA_FILE at that PEM. A leaf issued by a CA needs the CA, not the leaf.',
  ].join('\n')
}

/** The https agent for hub traffic: the pinned PEM when there is one, else defaults. */
export function createHubAgent(tls: HubTlsConfig): https.Agent {
  return new https.Agent({
    keepAlive: false,
    ...(tls.ca ? { ca: tls.ca } : {}),
  })
}
