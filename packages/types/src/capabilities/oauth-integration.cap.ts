import { z } from 'zod'
import { TokenScopeSchema } from '../schemas/auth-records.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * `oauth-integration` — a collection cap by which an addon declares
 * itself a linkable OAuth client of the hub's core `/oauth2/*` server.
 * Each provider returns a static descriptor; the core enumerates them
 * to validate the `integration=` query param and resolve the consent
 * label + the scopes baked into the issued token.
 *
 * ## Declaring one
 *
 * An OAuth client is integration-specific knowledge — who the client is, what
 * it may ask for, where it may be sent — so it is declared by the ADDON that
 * owns the integration, never by the kernel and never as a branch inside
 * `oauth2-routes.ts` ([D101](../../../../docs/decisions/adr-0101.md)). Three
 * steps, no others:
 *
 * 1. Add `{ "name": "oauth-integration" }` to the addon's `camstack.addons[]`
 *    manifest entry. This is also what tells the hub, at addon-LOAD time, that
 *    a descriptor is owed — see "the boot window" below.
 * 2. Return a provider from `onInitialize()`:
 *
 *    ```ts
 *    const provider: IOauthIntegrationProvider = {
 *      getDescriptor: async () => ({
 *        integrationId: 'my-thing',      // the `integration=` query param
 *        displayName: 'My Thing',
 *        requestedScopes: [ … ],         // see below
 *        allowedRedirectPrefixes: ['https://callback.example/'],
 *      }),
 *    }
 *    return [{ capability: oauthIntegrationCapability, provider }]
 *    ```
 *
 *    The descriptor must be **static** — it is read on the authorize path, so
 *    never put an await on network or disk behind it, and never register it
 *    behind one either (a provider is registered only once `onInitialize`
 *    RETURNS, so anything awaited before the return delays linking).
 * 3. Nothing else. There is no allow-list to join, no id to register with the
 *    core, and no per-integration branch anywhere: `/api/oauth2/authorize` and
 *    `/api/oauth2/integrations` are built from this collection alone.
 *
 * **Scopes. `requestedScopes` has exactly ONE meaning: what the integration
 * NEEDS to function.** Not a blast radius, not a conservative
 * under-declaration, not a description of some other path the addon happens to
 * have. Derive it from what the client actually calls **with this token** —
 * every tRPC path against `METHOD_ACCESS_MAP`, plus an `addon:` grant for every
 * addon HTTP route it posts to — and write the call that justifies each entry
 * next to it. Two integrations once used this field to mean two different
 * things; the operator ruled there is one meaning, and any third integration
 * inherits it (2026-08-09).
 *
 * This is not documentation, it is the ENFORCEMENT INPUT. Since
 * [D103](../../../../docs/decisions/adr-0103.md) the `/addon/:addonId/*` gate
 * checks an integration token's grant before letting it reach an
 * `access: 'authenticated'` route, so an **under-declaration is an integration
 * that stops working** — a missing `addon:` entry means `403 Token scope
 * mismatch` on every control the client tries to actuate. Widen the descriptor
 * honestly rather than weakening a check to make a route pass.
 *
 * Prefer a narrow `capability:` scope to a `category:` one unless the client
 * genuinely needs a whole family; a category scope grants every future member
 * of that category too. `category:system [create]` has been rejected once and
 * should stay rejected: it hands `addons.installPackage` to an integration.
 *
 * Calls the ADDON itself makes over `ctx.api` run as the addon and are not
 * scope-checked, so they are not what this field describes — but reaching the
 * addon's route in the first place IS, and that is the entry to declare.
 *
 * **The boot window.** An addon registers its provider after its runner forks
 * and initialises, so between hub start and that moment this collection is
 * incomplete and an `integrationId` can be legitimately absent. The core does
 * not wait, poll or cache around this ([D3](../../../../docs/decisions/adr-0003.md)):
 * it compares the manifest declarers against the registered providers and
 * answers `503 temporarily_unavailable` (with `Retry-After` and the pending
 * addon ids) instead of `400 unknown integration`, and reports
 * `complete: false` on `GET /api/oauth2/integrations`. A client should retry
 * while the list is incomplete rather than conclude the hub cannot do OAuth.
 */
const OauthIntegrationDescriptorSchema = z.object({
  /** Stable id used as the `integration=` query param, e.g. 'export-alexa'. */
  integrationId: z.string(),
  /** Human label rendered on the consent page. */
  displayName: z.string(),
  /** Scopes baked into every token issued for this integration. */
  requestedScopes: z.array(TokenScopeSchema),
  /** Allowed redirect_uri prefixes. /api/oauth2/authorize rejects any
   *  redirect_uri that does not start with one of these. Required —
   *  an empty list means the integration can never complete linking. */
  allowedRedirectPrefixes: z.array(z.string()).min(1),
  /** Paths accepted as a `redirect_uri` when the host is PRIVATE — loopback,
   *  RFC1918, CGNAT (100.64/10, Tailscale), link-local, IPv6 ULA, or an
   *  `.local` / `.internal` / `.ts.net` name. Exists for self-hosted clients
   *  whose address the hub cannot know in advance (a Home Assistant at
   *  `http://<lan-ip>:8123/auth/external/callback`). The PATH must match
   *  exactly; a public host never satisfies this branch, so it is not a
   *  wildcard prefix by another name. */
  allowedPrivateHostPaths: z.array(z.string()).optional(),
  /** When true this is a PUBLIC client (source is published, no secret can be
   *  protected) and PKCE is mandatory: `/authorize` refuses without an S256
   *  `code_challenge`, `/token` refuses without the matching `code_verifier`. */
  requiresPkce: z.boolean().optional(),
  /** Optional public origin (no trailing slash) that this integration's
   *  issued codes/tokens should carry as the `hubUrl` claim — typically the
   *  operator-selected external-access endpoint resolved by the addon. When
   *  present, /api/oauth2/authorize bakes THIS into the code instead of the
   *  hub-global `publicHubUrl()`, so a forked exporter addon (which can't set
   *  the hub's env) drives the claim that its cloud Lambda routes back on. */
  hubUrl: z.string().optional(),
  /**
   * How long a REFRESH token issued for this integration lives — seconds, or
   * `'never'` for a token minted with no `exp` claim at all. Omit to keep the
   * 30-day default, which is what every link used before this field existed.
   *
   * Declared here for the same reason `requestedScopes` is: the integration
   * knows what it needs. Amazon's account linking and a Home Assistant config
   * entry are both meant to survive indefinitely, and re-linking is a manual
   * user action, so a 30-day expiry silently unlinks a working integration.
   *
   * **The security posture, stated so it is owned deliberately.** A refresh
   * token that never expires is permanent access if it leaks. What bounds it is
   * revocation, not time: `oauthRefresh` re-reads the session on every use and
   * returns `null` once `revokedAt` is set, as does `oauthVerifyAccessToken`.
   * The one gap is the ACCESS token — it is a plain signed JWT that nothing
   * re-checks against the session on the `/trpc` and `/addon/*` paths, so
   * revoking a link takes effect there only after its remaining hour. That hour
   * is why the access TTL is not configurable.
   *
   * The value is baked into the authorization code at `/authorize` and travels
   * on the tokens, so editing this field changes FUTURE links only.
   */
  refreshTokenTtlSec: z.union([z.number().int().positive(), z.literal('never')]).optional(),
})

export const oauthIntegrationCapability = {
  name: 'oauth-integration',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    /**
     * `internal: true` did not gate the mount (see the 2026-08-26 note on
     * `data-store-provider`) — `getDescriptor` was reachable on the AppRouter
     * by ANY authenticated session at the default `auth: 'protected'`. The
     * real caller is `/api/oauth2/authorize` and `/api/oauth2/integrations`
     * (`oauth2-routes.ts`), which resolve the provider directly off the
     * capability registry — never through tRPC. `auth: 'admin'` closes the
     * tRPC surface without touching that path.
     */
    getDescriptor: method(z.void(), OauthIntegrationDescriptorSchema, { auth: 'admin' }),
  },
} as const satisfies CapabilityDefinition

export type IOauthIntegrationProvider = InferProvider<typeof oauthIntegrationCapability>
export type OauthIntegrationDescriptor = z.infer<typeof OauthIntegrationDescriptorSchema>
export { OauthIntegrationDescriptorSchema }
