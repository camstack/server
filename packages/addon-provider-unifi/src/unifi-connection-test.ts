/**
 * The UniFi connection test (planning#581): sign in with the connection as typed, find the site,
 * list the infra devices once, and answer a typed verdict with a reason the operator can act on.
 */
import { errMsg, type IntegrationTestConnectionResult } from '@camstack/types'
import type { UnifiConnectionConfig } from './config.js'
import type { UnifiControllerClientFactory } from './unifi-client-contract.js'
import { type UnifiCredentialKind, unifiCredentialOf } from './unifi-client-factory.js'
import {
  UnifiApiError,
  UnifiAuthError,
  UnifiMfaRequiredError,
  UnifiNoCredentialError,
  UnifiSiteNotFoundError,
} from './unifi-errors.js'

/** Why a connection failed, as the test reports it. */
export type UnifiFailureKind =
  | 'no-credential'
  | 'bad-credentials'
  | 'mfa-required'
  | 'wrong-site'
  | 'tls'
  | 'unreachable'
  | 'controller-error'

export interface UnifiFailure {
  readonly kind: UnifiFailureKind
  readonly reason: string
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

/** Every `code` along an error's `cause` chain (undici nests the socket error). */
function errorCodes(err: unknown): readonly string[] {
  const codes: string[] = []
  let cur: unknown = err
  for (let depth = 0; depth < 5 && typeof cur === 'object' && cur !== null; depth++) {
    if ('code' in cur && typeof cur.code === 'string') codes.push(cur.code)
    if ('name' in cur && cur.name === 'TimeoutError') codes.push('ETIMEDOUT')
    cur = 'cause' in cur ? cur.cause : null
  }
  return codes
}

/** Name the cause of a failed connection. */
export function classifyUnifiError(err: unknown): UnifiFailure {
  if (err instanceof UnifiNoCredentialError) return { kind: 'no-credential', reason: err.message }
  if (err instanceof UnifiMfaRequiredError) return { kind: 'mfa-required', reason: err.message }
  if (err instanceof UnifiAuthError) return { kind: 'bad-credentials', reason: err.message }
  if (err instanceof UnifiSiteNotFoundError) return { kind: 'wrong-site', reason: err.message }
  if (err instanceof UnifiApiError) return { kind: 'controller-error', reason: err.message }
  const codes = errorCodes(err)
  const tls = codes.find((c) => TLS_CODES.has(c))
  if (tls !== undefined) {
    return {
      kind: 'tls',
      reason: `unifi: the console's certificate is not trusted (${tls}) — the console uses a self-signed certificate: turn on "Accept self-signed certificate"`,
    }
  }
  const down = codes.find((c) => UNREACHABLE_CODES.has(c))
  if (down !== undefined) {
    return {
      kind: 'unreachable',
      reason: `unifi: the controller did not answer (${down}) — check the host and the HTTPS port`,
    }
  }
  return {
    kind: 'unreachable',
    reason: `unifi: the controller could not be reached: ${errMsg(err)}`,
  }
}

/** A failure the remote ANSWERED (it refused) blocks creation; one where nobody answered does not. */
function statusOf(kind: UnifiFailureKind): 'rejected' | 'inconclusive' {
  return kind === 'unreachable' || kind === 'controller-error' ? 'inconclusive' : 'rejected'
}

function signedInWith(credential: UnifiCredentialKind | null): string {
  switch (credential) {
    case 'both':
      return 'the API key and the local account (PoE on/off available)'
    case 'local-account':
      return 'the local account (PoE on/off available)'
    default:
      return 'the API key (PoE on/off needs a local account)'
  }
}

/**
 * Sign in, find the site and list the devices once; the client is always disconnected after. With
 * both credentials, a refused local account fails the test although the API key worked: the
 * operator typed it to switch PoE, and it would not.
 */
export async function testUnifiConnection(
  connection: UnifiConnectionConfig,
  makeClient: UnifiControllerClientFactory,
): Promise<IntegrationTestConnectionResult> {
  const started = Date.now()
  try {
    const client = makeClient(connection)
    try {
      await client.connect()
      const devices = await client.listInfraDevices()
      const degraded = client.degradedError()
      if (degraded !== null) {
        const failure = classifyUnifiError(degraded)
        return {
          success: false,
          status: statusOf(failure.kind),
          error: `The API key works, but the local account does not: ${failure.reason}`,
        }
      }
      return {
        success: true,
        status: 'validated',
        latencyMs: Date.now() - started,
        detail: `Signed in with ${signedInWith(unifiCredentialOf(connection))}; ${devices.length} device(s) on site "${connection.site}"`,
      }
    } finally {
      await client.disconnect().catch((): null => null)
    }
  } catch (err) {
    const failure = classifyUnifiError(err)
    return {
      success: false,
      status: statusOf(failure.kind),
      error: failure.reason,
    }
  }
}
