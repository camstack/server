/**
 * The hub's side of the skill's token broker (D753).
 *
 * The hub holds NO Login With Amazon client secret. To push a proactive event
 * it needs an LWA access token for the linked Amazon account, and it gets one
 * from the skill's Lambda (the broker) by presenting the per-link credential
 * the Lambda minted at link time (`csb1.<linkId>.<secret>`). The Lambda keeps
 * the refresh token and the client secret; the hub keeps a credential that
 * opens exactly one link and can be revoked or rotated.
 *
 * Every function here is a single HTTPS call with a timeout and a Zod-parsed
 * answer. Errors carry a `kind` so the gateway can tell "re-link needed" from
 * "try again later"; their messages never contain a token or a credential.
 */
import { z } from 'zod'

const BROKER_TIMEOUT_MS = 8_000

/** Origin-only, HTTPS-only. Anything else is refused before a credential is sent. */
export function normaliseBrokerUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || u.username || u.password) return null
    return u.origin
  } catch {
    return null
  }
}

/**
 * Why a broker call failed:
 *   - `unauthorized`: the credential is unknown / revoked / expired → re-link.
 *   - `revoked`: Amazon no longer honours the grant (skill disabled) → re-link.
 *   - `rejected`: the broker refused the request as malformed or disabled.
 *   - `unavailable`: network, timeout, 5xx, unexpected body → retry later.
 */
export type BrokerErrorKind = 'unauthorized' | 'revoked' | 'rejected' | 'unavailable'

export class BrokerError extends Error {
  constructor(
    readonly kind: BrokerErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'BrokerError'
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const AccessTokenSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.number().int().positive(),
})
export type BrokerAccessToken = z.infer<typeof AccessTokenSchema>

const MigrationSchema = AccessTokenSchema.extend({
  brokerCredential: z.string().min(1),
  brokerUrl: z.string().min(1),
})
export type BrokerMigration = z.infer<typeof MigrationSchema>

const RotationSchema = z.object({ brokerCredential: z.string().min(1) })

function kindForStatus(status: number): BrokerErrorKind {
  if (status === 401) return 'unauthorized'
  if (status === 410) return 'revoked'
  if (status === 400 || status === 403 || status === 404 || status === 405) return 'rejected'
  return 'unavailable'
}

async function call<T>(
  fetchImpl: FetchLike,
  brokerUrl: string,
  path: string,
  init: { bearer?: string; body?: unknown },
  schema: z.ZodType<T>,
): Promise<T> {
  const origin = normaliseBrokerUrl(brokerUrl)
  if (!origin) throw new BrokerError('rejected', 'broker URL is not an https origin')
  let response: Response
  try {
    response = await fetchImpl(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      },
      body: JSON.stringify(init.body ?? {}),
      signal: AbortSignal.timeout(BROKER_TIMEOUT_MS),
    })
  } catch (err) {
    throw new BrokerError(
      'unavailable',
      `broker ${path} unreachable: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const text = await response.text().catch(() => '')
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!response.ok) {
    const code =
      json && typeof json === 'object' && 'error' in json && typeof json.error === 'string'
        ? json.error
        : 'error'
    throw new BrokerError(
      kindForStatus(response.status),
      `broker ${path} ${response.status} ${code}`,
      response.status,
    )
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    throw new BrokerError('unavailable', `broker ${path} answered an unexpected shape`)
  }
  return parsed.data
}

/** A fresh (or still-valid) Event Gateway access token for this link. */
export function fetchBrokerAccessToken(
  fetchImpl: FetchLike,
  brokerUrl: string,
  credential: string,
): Promise<BrokerAccessToken> {
  return call(fetchImpl, brokerUrl, '/broker/token', { bearer: credential }, AccessTokenSchema)
}

/**
 * Hand a pre-D753 refresh token to the broker in exchange for a link. The
 * caller deletes its own copy of the refresh token on success.
 */
export function migrateLegacyGrant(
  fetchImpl: FetchLike,
  brokerUrl: string,
  input: { refreshToken: string; hubUrl?: string },
): Promise<BrokerMigration> {
  return call(fetchImpl, brokerUrl, '/broker/migrate', { body: input }, MigrationSchema)
}

/** Swap the credential's secret; the old one stops working at once. */
export async function rotateBrokerCredential(
  fetchImpl: FetchLike,
  brokerUrl: string,
  credential: string,
): Promise<string> {
  const out = await call(
    fetchImpl,
    brokerUrl,
    '/broker/rotate',
    { bearer: credential },
    RotationSchema,
  )
  return out.brokerCredential
}

/** Delete the link at the broker (the refresh token goes with it). */
export async function revokeBrokerCredential(
  fetchImpl: FetchLike,
  brokerUrl: string,
  credential: string,
): Promise<void> {
  await call(fetchImpl, brokerUrl, '/broker/revoke', { bearer: credential }, z.unknown())
}
