/**
 * Build the addon's HTTP route table. We don't own a socket — the
 * hub's Fastify catch-all (`/addon/:addonId/*`) calls into the routes
 * we register via the `addon-routes` capability.
 *
 * Public URLs (assuming the hub is reachable as `https://<hub>`):
 *   POST /addon/export-alexa/directive
 *   POST /addon/export-alexa/oauth/broker-link (Lambda → hub, D753 broker link)
 *   POST /addon/export-alexa/oauth/lwa-tokens (Lambda → hub, legacy pre-D753)
 *
 * OAuth account-linking is handled by the core `/oauth2/*` server
 * (integration=export-alexa). This addon registers an `oauth-integration`
 * provider; it no longer owns /oauth/authorize or /oauth/token routes.
 */
import { TokenScopeSchema } from '@camstack/types'
import type { AddonHttpReply, AddonHttpRequest, IAddonHttpRoute } from '@camstack/types'
import { z } from 'zod'

import {
  dispatchDirective,
  extractDirectiveBearer,
  assertDeviceScope,
  type DirectiveRouterDeps,
  type VerifiedDirectiveIdentity,
} from './directive-router.js'
import { parseCameraEndpointId } from './handlers/endpoint-id.js'
import { handleBrokerLinkCallback } from './handlers/broker-link-callback.js'
import {
  handleLwaTokensCallback,
  type LwaTokensCallbackDeps,
} from './handlers/lwa-tokens-callback.js'
import { readIngressHeader, verifyIngressToken } from './ingress-token.js'
import { handleSnapshotFetch, type SnapshotRouteDeps } from './snapshots/snapshot-route.js'
import type { AddonContext, IScopedLogger } from '@camstack/types'
import type { AlexaSettings } from './export-alexa.addon.js'

// Schema for the verified result returned by oauthVerifyAccessToken.
const OauthVerifiedResultSchema = z
  .object({
    userId: z.string(),
    username: z.string(),
    scopes: z.array(TokenScopeSchema),
  })
  .nullable()

export interface HttpRouteDeps {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
  readonly getSettings: () => AlexaSettings
  readonly directiveDeps: DirectiveRouterDeps
  readonly lwaTokensCallbackDeps: LwaTokensCallbackDeps
  /**
   * Wizard-button callback — re-runs the public-hub-URL detection
   * against the live `network-access` providers. Bypasses the admin
   * needing to restart the addon to pick up a new ingress provider.
   */
  readonly redetectPublicHubUrl: () => Promise<{ publicHubUrl: string }>
  /**
   * The skill Lambda advertised its token broker (`x-camstack-broker`) on a
   * directive whose bearer verified. Called with the raw header value; the
   * receiver validates it. D753.
   */
  readonly onBrokerAdvertised?: (rawUrl: string) => void
  /** R2 (D773): where Alexa fetches a snapshot it was handed. */
  readonly snapshotRoute: SnapshotRouteDeps
}

/** Header the D753 Lambda sends its broker origin on. */
export const BROKER_HEADER = 'x-camstack-broker'

export function buildRoutes(deps: HttpRouteDeps): readonly IAddonHttpRoute[] {
  return [
    {
      method: 'POST',
      path: '/directive',
      access: 'public',
      description: 'Alexa Smart Home directive ingress (forwarded by the user-owned Lambda)',
      handler: (req, reply) => handleDirective(req, reply, deps),
    },
    {
      method: 'POST',
      path: '/oauth/broker-link',
      access: 'public',
      // The broker link is D753.
      description:
        'Lambda → hub broker link: broker URL + per-link credential + first access token; bearer-authenticated via oauth-access token',
      handler: async (req, reply) => {
        if (ingressRejected(req, reply, deps, 'alexa broker-link')) return
        await handleBrokerLinkCallback(req, reply, deps.lwaTokensCallbackDeps)
      },
    },
    {
      method: 'POST',
      path: '/oauth/lwa-tokens',
      access: 'public',
      description: 'Lambda → hub LWA token callback (bearer-authenticated via oauth-access token)',
      handler: async (req, reply) => {
        if (ingressRejected(req, reply, deps, 'alexa lwa-tokens')) return
        await handleLwaTokensCallback(req, reply, deps.lwaTokensCallbackDeps)
      },
    },
    {
      // Public at the hub because Alexa has no hub session; the handler is the
      // gate (signed URL, expiry, the account-link token, the S1 grant). NOT
      // behind the ingress token: Amazon fetches it, not the skill Lambda.
      method: 'GET',
      path: '/snapshot/:file',
      access: 'public',
      description: 'Alexa SnapshotProvider image (signed, 10 min, account-link token required)',
      handler: (req, reply) => handleSnapshotFetch(req, reply, deps.snapshotRoute),
    },
    {
      method: 'POST',
      path: '/admin/redetect-hub-url',
      access: 'admin',
      description: 'Wizard hook — re-runs publicHubUrl auto-detection',
      handler: async (_req, reply) => {
        const result = await deps.redetectPublicHubUrl()
        reply.code(200).send(result)
      },
    },
  ]
}

// ── Ingress-token channel guard ─────────────────────────────────────

/**
 * Defense-in-depth: when the operator enables `enforceIngressToken`, every
 * Lambda→hub server call must carry the shared `X-CamStack-Ingress` header
 * matching the configured secret. Rejects (401) before any OAuth work when
 * the header is missing/wrong. Disabled (returns false = "not rejected") when
 * enforcement is off, so the token can be rolled out without breaking links.
 * Returns true when it has already sent the 401 (caller must return).
 */
function ingressRejected(
  request: AddonHttpRequest,
  reply: AddonHttpReply,
  deps: HttpRouteDeps,
  label: string,
): boolean {
  const settings = deps.getSettings()
  if (!settings.enforceIngressToken) return false
  if (verifyIngressToken(settings.ingressToken, readIngressHeader(request.headers))) return false
  deps.logger.warn(`${label}: rejected — missing/invalid ingress token`)
  reply.code(401).send({ error: 'invalid_ingress_token' })
  return true
}

// ── /directive ──────────────────────────────────────────────────────

/**
 * Minimal Alexa error envelope for pre-parse errors (no real messageId
 * is available yet).
 */
function preParseErrorEnvelope(type: string, message: string): unknown {
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'ErrorResponse',
        messageId: 'unknown',
        payloadVersion: '3',
      },
      payload: { type, message },
    },
  }
}

/**
 * Defensively pull the directive's namespace/name and (when present) the
 * target endpoint's camera deviceId out of an inbound directive body.
 *
 * Device-targeted directives (live-view, stream-init, control) carry
 * `directive.endpoint.endpointId`; discovery / authorization directives
 * have NO endpoint. The endpoint parse is optional — a missing or
 * unparseable endpoint (e.g. a child accessory `parent__child` id, which
 * is not a bare camera id) simply yields no deviceId tag, never a throw.
 */
export interface DirectiveArrivalInfo {
  readonly namespace: string
  readonly name: string
  readonly endpointId?: string
  readonly deviceId?: number
}

/**
 * The narrow, fully-optional shape we read off an inbound directive body.
 * The body arrives as `unknown` (untrusted Lambda payload); this named
 * interface documents exactly which nested fields the arrival parse
 * touches. Every field is optional so the parse stays defensive — a
 * missing/wrong-typed field simply yields `'unknown'`/no deviceId, never
 * a throw.
 */
interface RawDirectiveArrivalBody {
  readonly directive?: {
    readonly header?: { readonly namespace?: unknown; readonly name?: unknown }
    readonly endpoint?: { readonly endpointId?: unknown }
  }
}

export function describeDirectiveArrival(body: unknown): DirectiveArrivalInfo {
  // Single documented boundary: untrusted `unknown` → the named partial
  // shape we read. Every access below is optional-chained + typeof-guarded.
  const directive = (body as RawDirectiveArrivalBody).directive
  const namespace =
    typeof directive?.header?.namespace === 'string' ? directive.header.namespace : 'unknown'
  const name = typeof directive?.header?.name === 'string' ? directive.header.name : 'unknown'
  const endpointId =
    typeof directive?.endpoint?.endpointId === 'string' ? directive.endpoint.endpointId : undefined
  if (endpointId === undefined) return { namespace, name }
  const parsed = parseCameraEndpointId(endpointId)
  if (parsed.kind === 'camera') return { namespace, name, endpointId, deviceId: parsed.deviceId }
  return { namespace, name, endpointId }
}

async function handleDirective(
  request: AddonHttpRequest,
  reply: AddonHttpReply,
  deps: HttpRouteDeps,
): Promise<void> {
  if (ingressRejected(request, reply, deps, 'alexa directive')) return

  // Arrival log — makes "did this directive actually reach our addon?"
  // greppable. For device-targeted directives (live-view, stream-init,
  // control) the camera deviceId goes in the QUERYABLE `tags` column so a
  // whole session is filterable by `tags.deviceId`; discovery/auth
  // directives carry no endpoint and log without a deviceId tag.
  //
  // INTENTIONAL placement + level: this fires here on arrival —
  // AFTER the ingress-token guard but BEFORE OAuth verification — and
  // stays at `info`, by design. It must answer "did the directive reach
  // our addon?" independently of whether OAuth later passes/fails, so it
  // cannot be moved below the token check. It is NOT an unauthenticated
  // log line: the ingress-token guard above (`ingressRejected`) is the
  // gate — only our own Lambda forwards the shared `X-CamStack-Ingress`
  // header, so anything reaching this point already passed that channel
  // check. Do NOT downgrade to `debug` (operators need it visible) and do
  // NOT move it past OAuth.
  const arrival = describeDirectiveArrival(request.body)
  deps.logger.info('alexa directive: arrived', {
    ...(arrival.deviceId !== undefined ? { tags: { deviceId: arrival.deviceId } } : {}),
    meta: {
      namespace: arrival.namespace,
      name: arrival.name,
      ...(arrival.endpointId !== undefined ? { endpointId: arrival.endpointId } : {}),
    },
  })

  const settings = deps.getSettings()
  if (!settings.expectedAudience) {
    // Defensive: if the operator hasn't pasted the skill id we still
    // run the dispatch (token verification handles auth), but log a
    // warning so they remember to set it.
    deps.logger.warn('directive received but expectedAudience (skill id) not configured')
  }

  // ── Centralized auth (verify ONCE, before dispatch) ─────────────────
  const bearer = extractDirectiveBearer(request.body)
  if (!bearer) {
    reply
      .code(200)
      .send(
        preParseErrorEnvelope(
          'INVALID_AUTHORIZATION_CREDENTIAL',
          'missing bearer token — expected in directive.endpoint.scope.token or directive.payload.scope.token',
        ),
      )
    return
  }

  const rawVerified: unknown = await deps.ctx.api.userManagement.oauthVerifyAccessToken.query({
    token: bearer,
  })
  const verifiedParse = OauthVerifiedResultSchema.safeParse(rawVerified)
  if (!verifiedParse.success || !verifiedParse.data) {
    deps.logger.warn('alexa directive: bearer token failed oauthVerifyAccessToken')
    reply
      .code(200)
      .send(
        preParseErrorEnvelope('INVALID_AUTHORIZATION_CREDENTIAL', 'bearer token did not validate'),
      )
    return
  }
  const verified = verifiedParse.data

  try {
    assertDeviceScope(verified.scopes)
  } catch {
    deps.logger.warn('alexa directive: bearer token lacks device scope', {
      meta: { userId: verified.userId },
    })
    reply
      .code(200)
      .send(
        preParseErrorEnvelope(
          'INVALID_AUTHORIZATION_CREDENTIAL',
          'token does not grant access to device capabilities',
        ),
      )
    return
  }

  // Only now — after the bearer verified — is the broker advertisement believed.
  const advertised = readHeader(request.headers, BROKER_HEADER)
  if (advertised && deps.onBrokerAdvertised) deps.onBrokerAdvertised(advertised)

  const callerIdentity: VerifiedDirectiveIdentity = {
    userId: verified.userId,
    username: verified.username,
    scopes: verified.scopes,
  }

  const result = await dispatchDirective(request.body, deps.directiveDeps, callerIdentity)
  reply.code(result.status).send(result.body)
}

function readHeader(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value
  }
  return undefined
}
