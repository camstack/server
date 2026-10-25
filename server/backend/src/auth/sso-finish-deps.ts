import { userError } from '@camstack/types'
/**
 * The live wiring of `finishSsoLogin`'s deps (D777, D782) — kept out of
 * `main.ts` so the route there stays a three-line mapping.
 */
import { createHash } from 'node:crypto'
import { type CapabilityRegistry, getUserManagementInternal } from '@camstack/system'
import { SSO_STATE_COOKIE } from '@camstack/types'
import type { AuthService } from '../core/auth/auth.service.js'
import type { MoleculerService } from '../core/moleculer/moleculer.service.js'
import { isAuthAddonDisabled } from './auth-provider-gate.js'
import type { ExternalLinkIntents } from './external-link-intents.js'
import type { NativeLinkCompletions } from './native-link-completions.js'
import { resolvePasskeyProvider } from './passkey-provider.js'
import { collectSecondFactors } from './second-factors.js'
import { readSessionCookieFromHeader } from './session-cookie.js'
import type { SessionMinter } from './session-mint.js'
import type { SsoFinishDeps } from './sso-finish.js'
import type { UsedBridgeIds } from './used-bridge-ids.js'

/**
 * The user a REAL session cookie names, or `null`. Same rule as
 * `auth.exchangeSession`: a bridge or challenge token verifies under the same
 * secret but carries a `kind`, and a session always has a boolean `isAdmin`
 * and a string `userId`.
 */
export function sessionUserIdFromCookie(
  auth: Pick<AuthService, 'verifyToken'>,
  cookieHeader: string | undefined,
): string | null {
  const token = readSessionCookieFromHeader(cookieHeader)
  if (token === null) return null
  try {
    const payload = auth.verifyToken(token)
    if (Reflect.get(payload, 'kind') !== undefined) return null
    if (typeof payload.isAdmin !== 'boolean' || typeof payload.userId !== 'string') return null
    return payload.userId
  } catch {
    return null
  }
}

/** The value of one cookie in a raw `Cookie` header, or `null`. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq).trim() !== name) continue
    const value = pair.slice(eq + 1).trim()
    return value.length > 0 ? value : null
  }
  return null
}

/** SHA-256 (hex) of the request's SSO state cookie, or `null` without one. */
export function ssoBrowserBinding(cookieHeader: string | undefined): string | null {
  const value = readCookie(cookieHeader, SSO_STATE_COOKIE)
  return value === null ? null : createHash('sha256').update(value).digest('hex')
}

export interface SsoFinishWiring {
  readonly auth: AuthService
  readonly registry: CapabilityRegistry
  readonly moleculer: MoleculerService | null
  readonly minter: SessionMinter
  readonly linkIntents: ExternalLinkIntents
  /** Native links parked for the app to claim (D801). */
  readonly nativeLinks: NativeLinkCompletions
  /** `jti`s of bridges already finished — a bridge is single-use. */
  readonly usedBridgeIds: UsedBridgeIds
  /** Client label and address of the finishing request, for the session it opens. */
  readonly sessionIssue?: () => { readonly client?: string; readonly ip?: string }
  /** Did the finishing request come directly from a trusted network (opt-in 2FA skip)? */
  readonly trustedNetworkLogin?: () => boolean
  readonly logFailure?: (error: unknown) => void
}

export function createSsoFinishDeps(
  wiring: SsoFinishWiring,
  cookieHeader: string | undefined,
): SsoFinishDeps {
  const { auth, registry, moleculer } = wiring
  const userManagement = () => {
    const um = registry.getSingleton('user-management')
    if (!um)
      throw userError(
        'server.login-unavailable',
        undefined,
        'Login unavailable — `user-management` capability not registered',
      )
    return um
  }
  return {
    verifyBridge: (token) => auth.verifySsoBridgeToken(token),
    minter: wiring.minter,
    isProviderDisabled: (addonId) => isAuthAddonDisabled(registry, addonId),
    identities: {
      findUser: async (provider, subject) =>
        userManagement().findUserByExternalIdentity({ provider, subject }),
      link: async (input) => {
        const um = userManagement()
        const holder = await um.findUserByExternalIdentity({
          provider: input.provider,
          subject: input.subject,
        })
        if (holder !== null && holder.userId !== input.userId) return 'conflict'
        // Hub-internal: creating a link is on no wire (not tRPC, not the
        // mesh, not ctx.api) — only this in-process caller reaches it.
        const internal = getUserManagementInternal(um)
        if (internal === null) throw new Error('External sign-in linking not available')
        await internal.linkExternalIdentity(input)
        return 'linked'
      },
    },
    consumeLinkIntent: (handle) => wiring.linkIntents.consume(handle),
    parkNativeLink: (link) => wiring.nativeLinks.park(link),
    browserBinding: () => ssoBrowserBinding(cookieHeader),
    consumeBridgeId: (jti) => wiring.usedBridgeIds.consume(jti),
    ...(wiring.sessionIssue !== undefined ? { sessionIssue: wiring.sessionIssue } : {}),
    ...(wiring.trustedNetworkLogin !== undefined
      ? {
          trustedNetworkLogin: wiring.trustedNetworkLogin,
          auditSkip: async (userId: string, factors: readonly string[]) => {
            const internal = getUserManagementInternal(registry.getSingleton('user-management'))
            if (internal === null) throw new Error('auth audit unavailable')
            const ip = wiring.sessionIssue?.().ip
            await internal.audit.record({
              action: 'second-factor-skipped',
              userId,
              ...(ip !== undefined ? { ip } : {}),
              detail: { method: 'sso', factors: factors.join(',') },
            })
          },
        }
      : {}),
    sessionUserId: () => sessionUserIdFromCookie(auth, cookieHeader),
    secondFactors: (userId) => {
      const um = registry.getSingleton('user-management')
      return collectSecondFactors(
        {
          ...(um && typeof um.getTotpStatus === 'function'
            ? { getTotpStatus: (input: { userId: string }) => um.getTotpStatus(input) }
            : {}),
          passkeyProvider: () => resolvePasskeyProvider(registry, moleculer),
        },
        userId,
        'sso',
      )
    },
    signChallenge: (user) => auth.signTotpChallengeToken(user),
    ...(wiring.logFailure !== undefined ? { logFailure: wiring.logFailure } : {}),
  }
}
