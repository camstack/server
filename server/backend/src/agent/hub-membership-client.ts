/**
 * The agent asks its hub "am I still a member?" (D857).
 *
 * Two plain HTTPS calls (`MEMBERSHIP_PATHS`): fetch a nonce, then prove possession of the mesh leaf's
 * private key by signing it. The hub's HTTPS certificate is NOT what this trusts - the hub may serve a
 * private one - the answer is a JWS signed by the mesh CA key, verified here against the CA this agent
 * pinned at pairing, bound to the nonce and the leaf. The key never leaves the process: it signs, and
 * only the signature travels (no argv, no env).
 *
 * Every doubt is `unreachable`, never an answer: a hub that cannot be reached, a status other than
 * 200, a token that does not verify. The caller changes nothing on `unreachable` (D49).
 */
import { X509Certificate } from 'node:crypto'
import {
  MEMBERSHIP_PATHS,
  signMembershipProof,
  verifyMembershipAnswer,
  type MembershipAnswer,
} from '@camstack/system'
import { Agent, fetch as undiciFetch } from 'undici'

export interface HubMembershipQuery {
  /** `https://<host>:<port>` of the hub's API. */
  readonly hubUrl: string
  readonly nodeId: string
  /** This agent's mesh leaf, its private key and the CA it pinned at pairing. */
  readonly certPem: string
  readonly keyPem: string
  readonly caCertPem: string
}

export type HubMembershipResult =
  | { readonly kind: 'answer'; readonly answer: MembershipAnswer }
  | { readonly kind: 'unreachable'; readonly error: string }

/** The slice of a fetch response this client reads. */
interface ResponseLike {
  readonly status: number
  json(): Promise<unknown>
}

export type MembershipFetch = (
  url: string,
  init: { readonly body?: string },
) => Promise<ResponseLike>

const REQUEST_TIMEOUT_MS = 8_000

/** Production transport: JSON POST with a timeout, TLS not verified (the answer is CA-signed). */
export const membershipFetch: MembershipFetch = (url, init) =>
  undiciFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    dispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
  })

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function askHubMembership(
  query: HubMembershipQuery,
  doFetch: MembershipFetch = membershipFetch,
): Promise<HubMembershipResult> {
  try {
    const base = query.hubUrl.replace(/\/+$/, '')
    const challenge = await doFetch(`${base}${MEMBERSHIP_PATHS.challenge}`, {
      body: '{}',
    })
    if (challenge.status !== 200) {
      return {
        kind: 'unreachable',
        error: `challenge answered HTTP ${challenge.status}`,
      }
    }
    const nonce: unknown = Reflect.get(Object(await challenge.json()), 'nonce')
    if (typeof nonce !== 'string' || nonce.length === 0) {
      return { kind: 'unreachable', error: 'challenge carried no nonce' }
    }
    const response = await doFetch(`${base}${MEMBERSHIP_PATHS.query}`, {
      body: JSON.stringify({
        nodeId: query.nodeId,
        certPem: query.certPem,
        nonce,
        signature: signMembershipProof(query.keyPem, query.nodeId, nonce),
      }),
    })
    if (response.status !== 200) {
      return {
        kind: 'unreachable',
        error: `membership answered HTTP ${response.status}`,
      }
    }
    const token: unknown = Reflect.get(Object(await response.json()), 'token')
    if (typeof token !== 'string') return { kind: 'unreachable', error: 'answer carried no token' }
    const answer = verifyMembershipAnswer(query.caCertPem, token, {
      nodeId: query.nodeId,
      nonce,
      leafFingerprint: new X509Certificate(query.certPem).fingerprint256,
    })
    if (answer === null) {
      return {
        kind: 'unreachable',
        error: 'the answer is not signed by the pinned mesh CA',
      }
    }
    return { kind: 'answer', answer }
  } catch (err: unknown) {
    return { kind: 'unreachable', error: errorMessage(err) }
  }
}
