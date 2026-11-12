/**
 * Build the addon's HTTP route table. We don't own a socket — the
 * hub's Fastify catch-all (`/addon/:addonId/*`) calls into the routes
 * we register via the `addon-routes` capability.
 *
 * Public URLs (assuming the hub is reachable as `https://<hub>`):
 *   POST /addon/export-alexa[/instances/:instanceId]/directive
 *   POST /addon/export-alexa[/instances/:instanceId]/oauth/broker-link (Lambda → hub, D753)
 *   POST /addon/export-alexa[/instances/:instanceId]/oauth/lwa-tokens (Lambda → hub, pre-D753)
 *
 * The three are `perInstance` routes (D1046): the hub reads the instance segment. Without one
 * the skill is found by its ingress token, then falls back to the default skill
 * (`instance-routing.ts`). The same three with a trailing `/:instanceId` are the addresses a
 * Lambda built with `HUB_INSTANCE_ID` before D1046 still calls (planning#422); they stay.
 *
 * A token linked to another instance is refused (`token-instance.ts`, D1047).
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
import type { PublicEndpointReader } from './public-endpoint.js'
import { judgeRoutingClaim, readRoutingClaim } from './routing-claim.js'
import { handleSnapshotFetch, type SnapshotRouteDeps } from './snapshots/snapshot-route.js'
import type { AddonContext, IScopedLogger } from '@camstack/types'
import type { AlexaSettings } from './alexa-settings.js'
import type { SkillLookup } from './instance-routing.js'
import {
  ALEXA_ADDON_ID,
  describeTokenInstanceRefusal,
  judgeTokenInstance,
} from './token-instance.js'

// Schema for the verified result returned by oauthVerifyAccessToken.
const OauthVerifiedResultSchema = z
  .object({
    userId: z.string(),
    username: z.string(),
    scopes: z.array(TokenScopeSchema),
    /** The instance the link was made for; absent = the default instance (D1047). */
    instanceId: z.string().optional(),
  })
  .nullable()

/** One skill as the routes act on it: its settings and the wiring its requests run on. */
export interface RoutedSkill {
  readonly id: string
  readonly getSettings: () => AlexaSettings
  readonly directiveDeps: DirectiveRouterDeps
  readonly lwaTokensCallbackDeps: LwaTokensCallbackDeps
  /** Whether this skill's link ledger already lists the user (a link made before D1047). */
  readonly hasLinkedUser: (userId: string) => boolean
  /**
   * The skill Lambda advertised its token broker (`x-camstack-broker`) on a
   * directive whose bearer verified. Called with the raw header value; the
   * receiver validates it. D753.
   */
  readonly onBrokerAdvertised?: (rawUrl: string) => void
}

export interface HttpRouteDeps {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
  /** The skill a request is for (path, then ingress header, then the legacy skill), or null. */
  readonly resolveSkill: (lookup: SkillLookup) => RoutedSkill | null
  /** The hub's `publicEndpoint` role, read on every use. A directive token's routing claim is judged against it. */
  readonly publicEndpoint: PublicEndpointReader
  /** R2 (D773): where Alexa fetches a snapshot it was handed. */
  readonly snapshotRoute: SnapshotRouteDeps
}

/** Header the D753 Lambda sends its broker origin on. */
export const BROKER_HEADER = 'x-camstack-broker'

export function buildRoutes(deps: HttpRouteDeps): readonly IAddonHttpRoute[] {
  const forSkill = (
    description: string,
    path: string,
    handler: (req: AddonHttpRequest, reply: AddonHttpReply, skill: RoutedSkill) => Promise<void>,
  ): readonly IAddonHttpRoute[] => [
    {
      method: 'POST',
      path,
      access: 'public',
      perInstance: true,
      description: `${description} (the skill named by the instance segment; without one, the skill that presents its ingress token, else the default skill)`,
      handler: (req, reply) =>
        routeToSkill(req, reply, deps, explicitInstance(req.instanceId), handler),
    },
    {
      // A Lambda built with HUB_INSTANCE_ID before D1046 calls this address (planning#422).
      method: 'POST',
      path: `${path}/:instanceId`,
      access: 'public',
      description: `${description} (one skill, named after the path: the address older Lambdas call)`,
      handler: (req, reply) => routeToSkill(req, reply, deps, req.params['instanceId'], handler),
    },
  ]
  return [
    ...forSkill(
      'Alexa Smart Home directive ingress (forwarded by the user-owned Lambda)',
      '/directive',
      (req, reply, skill) => handleDirective(req, reply, deps, skill),
    ),
    // The broker link is D753.
    ...forSkill(
      'Lambda → hub broker link: broker URL + per-link credential + first access token; bearer-authenticated via oauth-access token',
      '/oauth/broker-link',
      async (req, reply, skill) => {
        if (ingressRejected(req, reply, deps, skill, 'alexa broker-link')) return
        await handleBrokerLinkCallback(req, reply, skill.lwaTokensCallbackDeps)
      },
    ),
    ...forSkill(
      'Lambda → hub LWA token callback (bearer-authenticated via oauth-access token)',
      '/oauth/lwa-tokens',
      async (req, reply, skill) => {
        if (ingressRejected(req, reply, deps, skill, 'alexa lwa-tokens')) return
        await handleLwaTokensCallback(req, reply, skill.lwaTokensCallbackDeps)
      },
    ),
    {
      // Public at the hub because Alexa has no hub session; the handler is the
      // gate (signed URL, expiry, the account-link token, the S1 grant). NOT
      // behind the ingress token: Amazon fetches it, not the skill Lambda. It
      // names no skill: the signed URL is the same for all of them.
      method: 'GET',
      path: '/snapshot/:file',
      access: 'public',
      description: 'Alexa SnapshotProvider image (signed, 10 min, account-link token required)',
      handler: (req, reply) => handleSnapshotFetch(req, reply, deps.snapshotRoute),
    },
  ]
}

/**
 * The instance a per-instance request names for the resolver. The default instance (no segment,
 * or the addon id) names none: its address is shared with a Lambda that finds its skill by the
 * ingress header (planning#422), so the resolver keeps that lookup for it.
 */
function explicitInstance(instanceId: string | undefined): string | undefined {
  return instanceId === undefined || instanceId === ALEXA_ADDON_ID ? undefined : instanceId
}

/** Resolve the request's skill, or answer that there is none. */
async function routeToSkill(
  request: AddonHttpRequest,
  reply: AddonHttpReply,
  deps: HttpRouteDeps,
  pathInstanceId: string | undefined,
  handler: (req: AddonHttpRequest, reply: AddonHttpReply, skill: RoutedSkill) => Promise<void>,
): Promise<void> {
  const skill = deps.resolveSkill({
    pathInstanceId,
    ingressHeader: readIngressHeader(request.headers),
  })
  if (skill === null) {
    deps.logger.warn('alexa: no enabled skill instance for this request', {
      meta: { instanceId: pathInstanceId ?? null },
    })
    if (isDirectiveBody(request.body)) {
      reply
        .code(200)
        .send(
          preParseErrorEnvelope(
            'INVALID_AUTHORIZATION_CREDENTIAL',
            'unknown or disabled skill instance',
          ),
        )
      return
    }
    reply.code(404).send({ error: 'unknown_skill_instance' })
    return
  }
  await handler(request, reply, skill)
}

/** Whether a body looks like an Alexa directive (the reply to it must be an Alexa envelope). */
function isDirectiveBody(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'directive' in body
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
  skill: RoutedSkill,
  label: string,
): boolean {
  const settings = skill.getSettings()
  if (!settings.enforceIngressToken) return false
  if (verifyIngressToken(settings.ingressToken, readIngressHeader(request.headers))) return false
  deps.logger.warn(`${label}: rejected — missing/invalid ingress token`, {
    meta: { instanceId: skill.id },
  })
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
  skill: RoutedSkill,
): Promise<void> {
  if (ingressRejected(request, reply, deps, skill, 'alexa directive')) return

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

  const settings = skill.getSettings()
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

  // The token verified, so its `hubUrl` claim is ours. The skill Lambda routes on it: a claim
  // that no longer names the hub's `publicEndpoint` role is refused with a logged reason
  // (planning#378, option B - no transition; the operator re-links once).
  const verdict = judgeRoutingClaim(readRoutingClaim(bearer), await deps.publicEndpoint())
  if (verdict.kind === 'stale' || verdict.kind === 'no-endpoint') {
    deps.logger.warn(
      verdict.kind === 'stale'
        ? 'alexa directive: refused — routing-claim-stale: the token was issued for another hub address; re-link the Alexa skill'
        : `alexa directive: refused — ${verdict.reason.code}: the token carries a routing claim but the hub has no public endpoint to compare it with`,
      {
        meta: {
          userId: verified.userId,
          claim: verdict.claim,
          ...(verdict.kind === 'stale' ? { current: verdict.current } : {}),
        },
      },
    )
    reply
      .code(200)
      .send(
        preParseErrorEnvelope(
          'INVALID_AUTHORIZATION_CREDENTIAL',
          verdict.kind === 'stale'
            ? 'token was issued for another hub address; re-link the Alexa skill'
            : `hub has no public endpoint (${verdict.reason.code}); set it on the Network page`,
        ),
      )
    return
  }

  const instanceVerdict = judgeTokenInstance(verified, skill)
  if (instanceVerdict.kind === 'refused') {
    deps.logger.warn(`alexa directive: refused — ${instanceVerdict.reason}`, {
      ...(arrival.deviceId !== undefined ? { tags: { deviceId: arrival.deviceId } } : {}),
      meta: {
        instanceId: skill.id,
        tokenInstanceId: verified.instanceId ?? null,
        userId: verified.userId,
      },
    })
    reply
      .code(200)
      .send(
        preParseErrorEnvelope(
          'INVALID_AUTHORIZATION_CREDENTIAL',
          describeTokenInstanceRefusal(instanceVerdict.reason),
        ),
      )
    return
  }

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
  if (advertised && skill.onBrokerAdvertised) skill.onBrokerAdvertised(advertised)

  const callerIdentity: VerifiedDirectiveIdentity = {
    userId: verified.userId,
    username: verified.username,
    scopes: verified.scopes,
  }

  const result = await dispatchDirective(request.body, skill.directiveDeps, callerIdentity)
  reply.code(result.status).send(result.body)
}

function readHeader(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value
  }
  return undefined
}
