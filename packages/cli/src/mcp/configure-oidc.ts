/**
 * `configure_oidc`: connect an OpenID Connect identity provider.
 *
 * Called with only `provider` it is a questionnaire: what to ask, the redirect
 * URI to paste into the provider, and the provider-side steps. With a client id
 * and an issuer it previews the planned connection (after a discovery check run
 * from this machine) and, with the one-shot `confirm_token`, creates or updates
 * it through the `oidc-connections` cap.
 *
 * A client secret never crosses a tool call, in either direction: there is no
 * argument for it, and a confidential client is finished in the admin UI, whose
 * route the result names. A public client (PKCE) needs none.
 */

import { type DryRunOutcome, type GatedToolSpec, type HubClient, text } from '@camstack/develop'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  type AdminGatedResult,
  adminGated,
  adminLink,
  ConfirmTokenSchema,
} from './configure-common.js'
import {
  OIDC_PROVIDERS,
  type OidcProviderName,
  OidcProviderSchema,
  type OidcProviderSpec,
  pieceQuestion,
  resolveIssuer,
} from './configure-oidc-providers.js'
import type { FetchFn, McpContext, ToolTextResult } from './context.js'
import { readQuery, reasonOf, withHub } from './ops-hub.js'

export const OIDC_TOOL = 'configure_oidc'
export const OIDC_ADMIN_ROUTE = '/system/identity?tab=authentication'
const DISCOVERY_TIMEOUT_MS = 5000

export const ClientTypeSchema = z.enum(['public', 'confidential'])

export interface OidcArgs {
  readonly provider: OidcProviderName
  readonly issuer?: string
  readonly host?: string
  readonly application_slug?: string
  readonly realm?: string
  readonly tenant_id?: string
  readonly client_id?: string
  readonly client_type?: z.infer<typeof ClientTypeSchema>
  readonly display_name?: string
  readonly connection_id?: string
}

// ---------------------------------------------------------------------------
// redirect URI

const AddressesSchema = z.looseObject({
  roles: z.looseObject({
    publicEndpoint: z.looseObject({ resolved: z.string().nullish() }).optional(),
    appConnections: z.looseObject({ resolved: z.array(z.string()) }).optional(),
  }),
})

const LOOPBACK = /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0)/i

function isLoopback(url: string): boolean {
  try {
    return LOOPBACK.test(new URL(url).hostname)
  } catch {
    return true
  }
}

export interface HubBase {
  readonly base: string | null
  readonly source?: 'publicEndpoint' | 'appConnections'
  readonly reason?: string
}

/** The hub origin a provider redirects back to: the public endpoint, else an app-connections address. */
export async function resolveHubBase(client: HubClient): Promise<HubBase> {
  const read = await readQuery(client, 'localNetwork.getAddresses', {}, AddressesSchema)
  if (!read.ok) return { base: null, reason: read.reason }
  const pub = read.value.roles.publicEndpoint?.resolved
  if (typeof pub === 'string' && pub !== '' && !isLoopback(pub)) {
    return { base: pub.replace(/\/+$/, ''), source: 'publicEndpoint' }
  }
  const app = read.value.roles.appConnections?.resolved.find((u) => !isLoopback(u))
  if (app !== undefined) return { base: app.replace(/\/+$/, ''), source: 'appConnections' }
  return {
    base: null,
    reason: 'no non-loopback public endpoint or app-connections address is set (Network page)',
  }
}

export function callbackPath(connectionId: string): string {
  return `/addon/auth-oidc/${connectionId}/callback`
}

// ---------------------------------------------------------------------------
// discovery

const DiscoverySchema = z.looseObject({
  issuer: z.string().optional(),
  authorization_endpoint: z.string().optional(),
  token_endpoint: z.string().optional(),
  jwks_uri: z.string().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
})

export interface DiscoveryReport {
  readonly checked: boolean
  readonly url: string
  readonly issuerMatches?: boolean
  readonly authorizationEndpoint?: string
  readonly tokenEndpoint?: string
  readonly s256?: boolean
  readonly clientSecretPost?: boolean
  readonly warnings: readonly string[]
}

const trimSlash = (s: string): string => s.replace(/\/+$/, '')

/** Fetch and judge the discovery document. A failure is a warning, never a throw. */
export async function checkDiscovery(
  fetchFn: FetchFn,
  issuer: string,
  clientType: 'public' | 'confidential',
): Promise<DiscoveryReport> {
  const url = `${trimSlash(issuer)}/.well-known/openid-configuration`
  let body: unknown
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) })
    if (!res.ok) {
      return {
        checked: false,
        url,
        warnings: [`discovery answered ${res.status}: check the issuer URL`],
      }
    }
    body = await res.json()
  } catch (err) {
    return {
      checked: false,
      url,
      warnings: [`discovery could not be fetched from this machine (${reasonOf(err)})`],
    }
  }
  const parsed = DiscoverySchema.safeParse(body)
  if (!parsed.success) {
    return {
      checked: false,
      url,
      warnings: ['discovery answered something that is not a JSON document'],
    }
  }
  const doc = parsed.data
  const warnings: string[] = []
  const issuerMatches = doc.issuer !== undefined && trimSlash(doc.issuer) === trimSlash(issuer)
  if (!issuerMatches) {
    warnings.push(
      `the provider reports issuer "${doc.issuer ?? '(none)'}", which differs from "${issuer}"`,
    )
  }
  if (doc.authorization_endpoint === undefined || doc.token_endpoint === undefined) {
    warnings.push('the discovery document lacks an authorization or token endpoint')
  }
  const s256 = doc.code_challenge_methods_supported?.includes('S256') === true
  if (!s256)
    warnings.push('code_challenge_methods_supported does not include S256 (PKCE is always used)')
  const post = doc.token_endpoint_auth_methods_supported?.includes('client_secret_post') === true
  if (clientType === 'confidential' && !post) {
    warnings.push(
      'token_endpoint_auth_methods_supported does not include client_secret_post, which CamStack uses for a confidential client',
    )
  }
  return {
    checked: true,
    url,
    issuerMatches,
    ...(doc.authorization_endpoint !== undefined
      ? { authorizationEndpoint: doc.authorization_endpoint }
      : {}),
    ...(doc.token_endpoint !== undefined ? { tokenEndpoint: doc.token_endpoint } : {}),
    s256,
    clientSecretPost: post,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// questionnaire

const ConnectionListSchema = z.array(
  z.looseObject({ id: z.string(), displayName: z.string().optional() }),
)

function connectionIdOf(args: OidcArgs): string {
  return args.connection_id ?? args.provider
}

export function questionnaire(spec: OidcProviderSpec, args: OidcArgs, redirectUri: string | null) {
  const questions = [
    ...spec.pieces.map(pieceQuestion),
    ...(args.provider === 'generic'
      ? ['issuer: the exact issuer from the discovery document']
      : []),
    'client_id: the client id the provider shows after you create the client',
    `client_type: "public" (PKCE, no secret${spec.publicPkce ? '' : ' - NOT supported by this provider'}) or "confidential" (a secret you type into the admin UI)`,
    'display_name (optional): the text of the login button',
    'connection_id (optional): to update an existing connection instead of creating one',
  ]
  return {
    status: 'questions' as const,
    provider: args.provider,
    label: spec.label,
    questions,
    issuerFormat: spec.issuerFormat,
    defaultScopes: spec.scopes,
    publicClientSupported: spec.publicPkce,
    whereToCreateTheClient: spec.whereToCreate,
    providerSideSteps: spec.steps,
    ...(spec.note !== undefined ? { note: spec.note } : {}),
    redirectUri,
    ...(redirectUri === null
      ? {
          redirectUriNote:
            'the hub address could not be resolved; set a public endpoint on the Network page',
        }
      : {}),
    next: `Call ${OIDC_TOOL} again with the answers; it previews the connection and gives a confirm_token.`,
    secretRule:
      'A client secret is never a tool argument. For a confidential client you type it in the admin UI.',
  }
}

// ---------------------------------------------------------------------------
// the gated write

export function oidcSpec(client: HubClient, fetchFn: FetchFn): GatedToolSpec<OidcArgs> {
  return {
    tool: OIDC_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const spec = OIDC_PROVIDERS[args.provider]
      const clientType = args.client_type ?? 'public'
      const resolved = resolveIssuer(args.provider, args.issuer, args)
      if (
        resolved.issuer === null ||
        args.client_id === undefined ||
        args.client_id.trim() === ''
      ) {
        return { confirmable: false, describe: { problem: 'issuer and client_id are required' } }
      }
      if (clientType === 'public' && !spec.publicPkce) {
        return {
          confirmable: false,
          describe: {
            problem: `${spec.label} does not issue public clients; use client_type "confidential"`,
          },
        }
      }
      const id = connectionIdOf(args)
      const list = await readQuery(
        client,
        'oidcConnections.listConnections',
        {},
        ConnectionListSchema,
      )
      if (!list.ok) return { confirmable: false, describe: { problem: list.reason } }
      const exists = list.value.some((c) => c.id === id)
      if (exists && args.connection_id === undefined) {
        return {
          confirmable: false,
          describe: {
            problem: `a connection "${id}" already exists; pass connection_id "${id}" to update it, or another id to create a new one`,
          },
        }
      }
      const base = await resolveHubBase(client)
      const discovery = await checkDiscovery(fetchFn, resolved.issuer, clientType)
      const link = await adminLink(client, OIDC_ADMIN_ROUTE)
      return {
        confirmable: true,
        describe: {
          action: exists ? 'update OIDC connection' : 'create OIDC connection',
          connection: {
            id,
            displayName: args.display_name ?? spec.label,
            issuerUrl: resolved.issuer,
            clientId: args.client_id.trim(),
            clientType,
            scopes: spec.scopes,
            usernameClaim: spec.usernameClaim,
            clientSecret:
              clientType === 'public' ? 'none (public PKCE client)' : 'entered in the admin UI',
          },
          redirectUri: base.base !== null ? `${base.base}${callbackPath(id)}` : null,
          ...(base.base === null ? { redirectUriProblem: base.reason } : {}),
          discovery,
          warnings: discovery.warnings,
          ...secretStep(clientType, link.url),
        },
      }
    },
    async execute(args) {
      const spec = OIDC_PROVIDERS[args.provider]
      const clientType = args.client_type ?? 'public'
      const resolved = resolveIssuer(args.provider, args.issuer, args)
      const id = connectionIdOf(args)
      const displayName = args.display_name ?? spec.label
      const list = await readQuery(
        client,
        'oidcConnections.listConnections',
        {},
        ConnectionListSchema,
      )
      const exists = list.ok && list.value.some((c) => c.id === id)
      if (!exists) {
        await client.call('POST', 'oidcConnections.createConnection', { id, displayName })
      }
      await client.call('POST', 'oidcConnections.updateConnection', {
        id,
        displayName,
        issuerUrl: resolved.issuer ?? '',
        clientId: (args.client_id ?? '').trim(),
        scopes: spec.scopes,
        usernameClaim: spec.usernameClaim,
        ...(exists && clientType === 'public' ? { clientSecret: { $secretClear: true } } : {}),
      })
      const link = await adminLink(client, OIDC_ADMIN_ROUTE)
      return {
        connectionId: id,
        applied: exists ? 'updated' : 'created',
        ...secretStep(clientType, link.url),
      }
    },
  }
}

function secretStep(clientType: 'public' | 'confidential', url: string | null) {
  if (clientType === 'public') return {}
  return {
    secretStep: {
      required: true,
      how:
        url !== null
          ? `open ${url}, edit the connection and type the client secret in the Client Secret field`
          : `open ${OIDC_ADMIN_ROUTE} in the admin UI, edit the connection and type the client secret in the Client Secret field`,
      note: 'The secret is never a tool argument and is not shown here.',
    },
  }
}

// ---------------------------------------------------------------------------
// entry

export async function configureOidc(
  ctx: McpContext,
  args: OidcArgs,
  confirmToken: string | undefined,
): Promise<AdminGatedResult | Record<string, unknown>> {
  const spec = OIDC_PROVIDERS[args.provider]
  const resolved = resolveIssuer(args.provider, args.issuer, args)
  const asking = resolved.issuer === null || (args.client_id ?? '').trim() === ''
  if (asking) {
    const base = await withHub(ctx, async ({ client }) => resolveHubBase(client))
    const redirect =
      'status' in base || base.base === null
        ? null
        : `${base.base}${callbackPath(connectionIdOf(args))}`
    return questionnaire(spec, args, redirect)
  }
  return adminGated(ctx, (client) => oidcSpec(client, ctx.fetch), args, confirmToken)
}

export const OIDC_TOOL_SHAPE = {
  provider: OidcProviderSchema,
  issuer: z.string().optional(),
  host: z.string().optional(),
  application_slug: z.string().optional(),
  realm: z.string().optional(),
  tenant_id: z.string().optional(),
  client_id: z.string().optional(),
  client_type: ClientTypeSchema.optional(),
  display_name: z.string().optional(),
  connection_id: z.string().optional(),
  confirm_token: ConfirmTokenSchema,
}

export function registerOidcTools(server: McpServer, ctx: McpContext): void {
  server.tool(
    OIDC_TOOL,
    'Connect an OpenID Connect identity provider (authentik, pocket-id, authelia, keycloak, zitadel, kanidm, google, microsoft-entra, auth0, okta, generic). Call with only `provider` for the questions, the provider-side setup steps and the redirect URI to paste into the provider. With the answers it previews the connection and checks the provider discovery document (warnings, never a crash); call again with the SAME arguments and the confirm_token to create or update it. A client secret is NEVER an argument or output: a confidential client is finished by typing the secret in the admin UI (the route is given); a public PKCE client needs none. Needs an admin `camstack login` session for the write.',
    OIDC_TOOL_SHAPE,
    async ({ confirm_token, ...args }): Promise<ToolTextResult> =>
      text(await configureOidc(ctx, args, confirm_token)),
  )
}
