/**
 * `POST /addon/export-alexa/oauth/lwa-tokens` — the LEGACY (pre-D753)
 * callback a Lambda without the token broker invokes after the LWA grant
 * exchange. It hands this hub the refresh token itself. Kept so an old Lambda
 * keeps linking during the cut-over; the hub cannot renew such a grant (it
 * holds no client secret) and migrates it to the broker instead. The D753
 * Lambda calls `/oauth/broker-link` (`broker-link-callback.ts`).
 *
 * Auth: Bearer `<granteeToken>` where the grantee token is the OAuth
 * access token (kind=`oauth-access`) issued by the hub's core OAuth
 * server. The hub verifies it via the `user-management` capability's
 * `oauthVerifyAccessToken` method and derives the `userId` from the
 * verified claims.
 *
 * Errors:
 *   - 401 `unauthorized` when the Bearer token is absent or invalid.
 *   - 400 `invalid_body` when Zod rejects the body shape.
 *   - 200 `{ok: true}` on success.
 */
import { z } from 'zod'
import type { AddonContext, AddonHttpReply, AddonHttpRequest, IScopedLogger } from '@camstack/types'
import { TokenScopeSchema } from '@camstack/types'

import type { UpsertLwaTokenInput } from '../types.js'

// Schema for the verified result returned by oauthVerifyAccessToken.
const OauthVerifiedResultSchema = z
  .object({
    userId: z.string(),
    username: z.string(),
    scopes: z.array(TokenScopeSchema),
  })
  .nullable()

const LwaTokensCallbackBodySchema = z.object({
  lwaAccessToken: z.string().min(1),
  lwaRefreshToken: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
})
export type LwaTokensCallbackBody = z.infer<typeof LwaTokensCallbackBodySchema>

export interface LwaTokensCallbackDeps {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
  readonly upsertToken: (input: UpsertLwaTokenInput) => Promise<void>
  /** Records the linked account. In cloud mode AcceptGrant runs in the Lambda
   *  (never reaching the hub-side handler), so this callback is where the link
   *  gets recorded — drives getStatus 'linked' + the Event Gateway's audience. */
  readonly recordLinkedAccount: (input: { userId: string; username: string }) => Promise<void>
}

export async function handleLwaTokensCallback(
  request: AddonHttpRequest,
  reply: AddonHttpReply,
  deps: LwaTokensCallbackDeps,
): Promise<void> {
  const parsed = LwaTokensCallbackBodySchema.safeParse(request.body)
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid_body', message: parsed.error.message })
    return
  }
  const body: LwaTokensCallbackBody = parsed.data

  const caller = await resolveCaller(request, deps)
  if (!caller) {
    deps.logger.warn('alexa lwa-tokens-callback: unauthorized', {
      meta: {
        hasBearer: pickHeader(request.headers, 'authorization') !== null,
      },
    })
    reply.code(401).send({
      error: 'unauthorized',
      message: 'callback requires Bearer <granteeToken> (oauth-access token)',
    })
    return
  }
  const { userId, username } = caller

  await deps.upsertToken({
    userId,
    accessToken: body.lwaAccessToken,
    refreshToken: body.lwaRefreshToken,
    expiresAt: body.expiresAt,
  })
  // Record the linked account here (cloud mode's AcceptGrant runs in the Lambda
  // and never hits the hub-side handler that would otherwise record it). Without
  // this, getStatus stays 'unlinked' and the Event Gateway has no audience for
  // proactive doorbell/motion events even though the LWA tokens are stored.
  await deps.recordLinkedAccount({ userId, username })

  deps.logger.warn(
    'alexa lwa-tokens-callback: linked through a Lambda WITHOUT the token broker — this hub holds no LWA secret, so the grant cannot be renewed here; update the skill Lambda (D753). It migrates automatically once the Lambda advertises its broker.',
    { meta: { userId, expiresInMs: body.expiresAt - Date.now() } },
  )
  reply.code(200).send({ ok: true })
}

/**
 * Authenticate the inbound callback via Bearer token only.
 * Returns the userId on success, `null` otherwise.
 */
export async function resolveCaller(
  request: AddonHttpRequest,
  deps: LwaTokensCallbackDeps,
): Promise<{ userId: string; username: string } | null> {
  const bearer = extractBearer(request.headers)
  if (!bearer) return null
  const rawVerified: unknown = await deps.ctx.api.userManagement.oauthVerifyAccessToken.query({
    token: bearer,
  })
  const verifiedParse = OauthVerifiedResultSchema.safeParse(rawVerified)
  if (verifiedParse.success && verifiedParse.data) {
    return { userId: verifiedParse.data.userId, username: verifiedParse.data.username }
  }
  deps.logger.debug('alexa lwa-tokens-callback: bearer present but did not verify')
  return null
}

function extractBearer(headers: Record<string, string>): string | null {
  const value = pickHeader(headers, 'authorization')
  if (!value) return null
  const match = /^bearer\s+(.+)$/i.exec(value.trim())
  const token = match?.[1]
  return token ? token.trim() : null
}

export function pickHeader(headers: Record<string, string>, name: string): string | null {
  // Header names are case-insensitive — Fastify lowercases on ingress
  // but we don't rely on that here.
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const value = headers[key]
      return value && value.length > 0 ? value : null
    }
  }
  return null
}
