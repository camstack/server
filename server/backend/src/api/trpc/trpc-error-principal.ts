/**
 * Attribution for the tRPC error log.
 *
 * `onError` used to log `{code, path, message}` and nothing about WHO was
 * refused. On 2026-08-09 that cost an afternoon: a linked Home Assistant was
 * refused on its first authenticated call, the hub logged
 *
 *     WARN (tRPC) tRPC error {code=FORBIDDEN path=deviceExport.listExposedDevices
 *       message="No scope grants view on 'device-export' …"}
 *
 * — a line that says exactly what is wrong — and the operator, searching the
 * container's ~2700-lines-per-four-minutes stream for `oauth` and `token`,
 * concluded the hub had logged nothing. The refusal was unattributable: nothing
 * on the line said it came from an account-linked integration, from which link,
 * or from which user.
 *
 * These two functions close that. Neither ever renders a token: the session id
 * is the same identifier `userManagement.listOauthSessions` already returns, so
 * a log line and a session listing can be joined by eye.
 */
import type { AuthenticatedAgent } from './trpc.context.js'

/**
 * What a credential says about ITSELF, lifted off verified JWT claims.
 *
 * Both fields are absent for an ordinary login token — that is the common case
 * and it deliberately renders as nothing extra.
 */
export interface CredentialIdentity {
  /** The `provider` claim of an sso-bridge token, e.g. `oauth-access`. */
  readonly credential?: string
  /** The OAuth session the token was minted against, as listed by the hub. */
  readonly sessionId?: string
}

/**
 * Read the credential's self-description off verified claims.
 *
 * The claim set on the wire is WIDER than `TokenPayload` describes — an
 * `oauth-access` token is an sso-bridge token and carries `kind`, `provider`
 * and `sessionId` besides. Those are read structurally rather than by widening
 * `TokenPayload`, which would invite every consumer to assume they are always
 * there.
 *
 * Gated on `kind === 'sso-bridge'`: `provider` is a common enough field name
 * that a future token type could carry one meaning something else entirely, and
 * mislabelling a principal in a security log is worse than not labelling it.
 */
export function readCredentialIdentity(claims: object): CredentialIdentity {
  const kind: unknown = Reflect.get(claims, 'kind')
  if (kind !== 'sso-bridge') return {}
  const provider: unknown = Reflect.get(claims, 'provider')
  const sessionId: unknown = Reflect.get(claims, 'sessionId')
  return {
    ...(typeof provider === 'string' && provider !== '' ? { credential: provider } : {}),
    ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
  }
}

/**
 * Render a principal for one log line.
 *
 * Shapes, in the order they are distinguished (the label comes from the
 * principal's audit tag — attribution only, D892):
 *
 *   anonymous
 *   apocaliss92 (admin)
 *   token:ci (token)
 *   token:ops (token admin)
 *   apocaliss92 (oauth-access session=910a6179-…)
 *   apocaliss92 (session)
 */
export function describeTrpcPrincipal(user: AuthenticatedAgent | null | undefined): string {
  // Never blank: an empty field reads as a logging defect rather than as an
  // unauthenticated request, and the two need different fixes.
  if (!user) return 'anonymous'

  const name = user.username || user.id || 'unknown'
  if (user.auditTag === 'session' && user.isAdmin) return `${name} (admin)`
  if (user.credential) {
    const session = user.oauthSessionId ? ` session=${user.oauthSessionId}` : ''
    return `${name} (${user.credential}${session})`
  }
  if (user.auditTag !== undefined) {
    return `${name} (${user.auditTag}${user.isAdmin && user.auditTag !== 'session' ? ' admin' : ''})`
  }
  return user.isAdmin ? `${name} (admin)` : `${name} (session)`
}
