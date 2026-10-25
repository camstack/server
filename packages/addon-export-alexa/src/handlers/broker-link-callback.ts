/**
 * `POST /addon/export-alexa/oauth/broker-link` — the skill Lambda tells this
 * hub that an Amazon account was linked (D753).
 *
 * The Lambda has already exchanged the AcceptGrant code with Amazon and kept
 * the refresh token. It gives this hub:
 *   - `brokerUrl`        where to ask for renewed access tokens,
 *   - `brokerCredential` this link's credential at the broker,
 *   - `lwaAccessToken` / `expiresAt` the first Event Gateway token.
 * No refresh token and no client secret reach the hub.
 *
 * Auth: identical to the legacy `/oauth/lwa-tokens` callback — Bearer
 * `<granteeToken>`, the hub's own `oauth-access` token Amazon presented with
 * the AcceptGrant, verified by `oauthVerifyAccessToken` (and the ingress-token
 * guard in `http-server.ts`). A Lambda that does not know this route gets 404
 * and falls back to the legacy callback, which is how the cut-over stays
 * zero-downtime in both directions.
 *
 * Errors: 400 `invalid_body` / `invalid_broker_url`, 401 `unauthorized`.
 */
import { z } from 'zod'
import type { AddonHttpReply, AddonHttpRequest } from '@camstack/types'

import { normaliseBrokerUrl } from '../broker-client.js'
import { type LwaTokensCallbackDeps, pickHeader, resolveCaller } from './lwa-tokens-callback.js'

const BrokerLinkBodySchema = z.object({
  brokerUrl: z.string().min(1).max(512),
  brokerCredential: z.string().min(1).max(512),
  lwaAccessToken: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
})

export async function handleBrokerLinkCallback(
  request: AddonHttpRequest,
  reply: AddonHttpReply,
  deps: LwaTokensCallbackDeps,
): Promise<void> {
  const parsed = BrokerLinkBodySchema.safeParse(request.body)
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid_body', message: parsed.error.message })
    return
  }
  const body = parsed.data
  const brokerUrl = normaliseBrokerUrl(body.brokerUrl)
  if (!brokerUrl) {
    reply
      .code(400)
      .send({ error: 'invalid_broker_url', message: 'brokerUrl must be an https origin' })
    return
  }

  const caller = await resolveCaller(request, deps)
  if (!caller) {
    deps.logger.warn('alexa broker-link: unauthorized', {
      meta: { hasBearer: pickHeader(request.headers, 'authorization') !== null },
    })
    reply.code(401).send({
      error: 'unauthorized',
      message: 'callback requires Bearer <granteeToken> (oauth-access token)',
    })
    return
  }

  await deps.upsertToken({
    userId: caller.userId,
    accessToken: body.lwaAccessToken,
    expiresAt: body.expiresAt,
    brokerUrl,
    brokerCredential: body.brokerCredential,
  })
  await deps.recordLinkedAccount({ userId: caller.userId, username: caller.username })

  deps.logger.info('alexa broker-link: linked — push grant held by the skill broker', {
    meta: { userId: caller.userId, expiresInMs: body.expiresAt - Date.now() },
  })
  reply.code(200).send({ ok: true })
}
