/**
 * The addon's HTTP surface. We do not own a socket — the hub's Fastify
 * catch-all (`/addon/:addonId/*`) calls the routes registered through the
 * `addon-routes` capability.
 *
 * One public URL per instance, assuming the hub is reachable as `https://<hub>`:
 *
 *   POST /addon/export-google/fulfillment/<instanceId>
 *   POST /addon/export-google/fulfillment            (the first instance, `export-google`)
 *
 * That is the URL the operator pastes into the Actions console as the
 * fulfillment URL of ONE project. The path alone names the instance: the token
 * never does (one OAuth client serves every instance). Account linking uses the hub's core `/api/oauth2/*` server
 * (`integration=export-google`) — this addon registers an `oauth-integration`
 * provider and owns no authorize/token route of its own.
 *
 * `access: 'public'` with the bearer verified HERE, exactly like Alexa's
 * `/directive`: Google presents the access token our own OAuth server minted,
 * and the route authenticates it itself rather than passing through the
 * `authenticated` gate. That is also why the OAuth descriptor declares no
 * `addon:` grant — the D103 check only applies to `access: 'authenticated'`
 * routes.
 */

import type {
  AddonContext,
  AddonHttpReply,
  AddonHttpRequest,
  IAddonHttpRoute,
  IScopedLogger,
} from '@camstack/types'
import { TokenScopeSchema } from '@camstack/types'
import { z } from 'zod'

import { GOOGLE_INSTANCE_ID } from './export-records.js'
import {
  type FulfillmentDeps,
  handleFulfillment,
  type VerifiedGoogleCaller,
} from './fulfillment-router.js'

/** Shape of `userManagement.oauthVerifyAccessToken`'s result. */
const OauthVerifiedResultSchema = z
  .object({
    userId: z.string(),
    username: z.string(),
    scopes: z.array(TokenScopeSchema),
  })
  .nullable()

/** What a path's instance id resolved to. */
export type FulfillmentLookup =
  | { readonly ok: true; readonly deps: FulfillmentDeps }
  | { readonly ok: false; readonly code: 'unknown_instance' | 'instance_disabled' }

export interface HttpRouteDeps {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
  /** The fulfillment wiring of one instance, loaded (links included) before it is returned. */
  readonly resolveFulfillment: (instanceId: string) => Promise<FulfillmentLookup>
}

export function buildRoutes(deps: HttpRouteDeps): readonly IAddonHttpRoute[] {
  return [
    {
      method: 'POST',
      path: '/fulfillment/:instanceId',
      access: 'public',
      description:
        'Google Home smart-home fulfillment of one instance (SYNC / QUERY / EXECUTE / DISCONNECT)',
      handler: (req, reply) =>
        handleFulfillmentRequest(req, reply, deps, req.params['instanceId'] ?? ''),
    },
    {
      method: 'POST',
      path: '/fulfillment',
      access: 'public',
      description: `Legacy fulfillment URL: answers for the first instance (${GOOGLE_INSTANCE_ID})`,
      handler: (req, reply) => handleFulfillmentRequest(req, reply, deps, GOOGLE_INSTANCE_ID),
    },
  ]
}

/** Read `Authorization: Bearer <token>` case-insensitively. Node lower-cases
 *  header names, but the route contract only promises a string map. */
export function readBearer(headers: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'authorization') continue
    const match = /^Bearer\s+(.+)$/i.exec(value.trim())
    return match?.[1] ?? null
  }
  return null
}

async function handleFulfillmentRequest(
  request: AddonHttpRequest,
  reply: AddonHttpReply,
  deps: HttpRouteDeps,
  instanceId: string,
): Promise<void> {
  const bearer = readBearer(request.headers)
  if (bearer === null) {
    // 401 (not a 200 `authFailure` envelope): Google retries the token
    // exchange on a 401 and only prompts the user to re-link when that also
    // fails, which is the behaviour we want for a malformed request.
    deps.logger.warn('google fulfillment: rejected — no bearer token')
    reply.code(401).send({ error: 'missing_bearer_token' })
    return
  }

  const rawVerified: unknown = await deps.ctx.api.userManagement.oauthVerifyAccessToken.query({
    token: bearer,
  })
  const verified = OauthVerifiedResultSchema.safeParse(rawVerified)
  if (!verified.success || verified.data === null) {
    deps.logger.warn('google fulfillment: rejected — bearer failed oauthVerifyAccessToken')
    reply.code(401).send({ error: 'invalid_bearer_token' })
    return
  }

  const caller: VerifiedGoogleCaller = {
    userId: verified.data.userId,
    username: verified.data.username,
    scopes: verified.data.scopes,
  }

  const lookup = await deps.resolveFulfillment(instanceId)
  if (!lookup.ok) {
    deps.logger.warn('google fulfillment: rejected — instance not served', {
      meta: { instanceId, reason: lookup.code },
    })
    reply.code(404).send({ error: lookup.code })
    return
  }

  const result = await handleFulfillment(request.body, lookup.deps, caller)
  reply.code(result.status).send(result.body)
}
