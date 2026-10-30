/**
 * The identity providers `configure_oidc` knows: how each one's issuer URL is
 * built from the pieces the operator knows, which scopes it needs, whether it
 * accepts a public (PKCE, no secret) client, and where its UI creates one.
 * Data only — the tool reads this table and holds no per-provider branch.
 */
import { z } from 'zod'

export const OidcProviderSchema = z.enum([
  'authentik',
  'pocket-id',
  'authelia',
  'keycloak',
  'zitadel',
  'kanidm',
  'google',
  'microsoft-entra',
  'auth0',
  'okta',
  'generic',
])
export type OidcProviderName = z.infer<typeof OidcProviderSchema>

/** The tool arguments that name a piece of an issuer URL. */
export type IssuerPiece = 'host' | 'application_slug' | 'realm' | 'tenant_id'

export interface IssuerPieces {
  readonly host?: string
  readonly application_slug?: string
  readonly realm?: string
  readonly tenant_id?: string
}

export type UsernameClaim = 'preferred_username' | 'email' | 'sub'

export interface OidcProviderSpec {
  readonly label: string
  /** Pieces needed to build the issuer; `generic` has none and asks for `issuer`. */
  readonly pieces: readonly IssuerPiece[]
  /** An example of the issuer, for the questionnaire. */
  readonly issuerFormat: string
  readonly scopes: string
  readonly publicPkce: boolean
  readonly usernameClaim: UsernameClaim
  readonly whereToCreate: string
  readonly steps: readonly string[]
  /** Optional extra scope the operator may add by hand, never a default. */
  readonly note?: string
  readonly build: (p: Required<IssuerPieces>) => string
}

const PIECE_QUESTION: Readonly<Record<IssuerPiece, string>> = {
  host: 'host: the provider host name, with or without https:// (no path)',
  application_slug: 'application_slug: the application slug (authentik) or client name (kanidm)',
  realm: 'realm: the Keycloak realm name',
  tenant_id: 'tenant_id: the Entra directory (tenant) id, a GUID or a verified domain',
}

export function pieceQuestion(piece: IssuerPiece): string {
  return PIECE_QUESTION[piece]
}

/** A bare host or a URL as an https origin without a trailing slash. */
export function hostOrigin(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

const COMMON_STEPS = [
  'Create the client as an OpenID Connect / OAuth2 web application, authorization-code flow.',
  'Paste the redirect URI shown below as the ONLY allowed redirect URI.',
  'Allow the scopes listed below.',
]

export const OIDC_PROVIDERS: Readonly<Record<OidcProviderName, OidcProviderSpec>> = {
  authentik: {
    label: 'authentik',
    pieces: ['host', 'application_slug'],
    issuerFormat: 'https://<host>/application/o/<application_slug>/',
    scopes: 'openid profile email',
    publicPkce: true,
    usernameClaim: 'preferred_username',
    whereToCreate:
      'Admin interface > Applications > Applications > Create with Provider (OAuth2/OpenID)',
    steps: [
      'Create an application with an OAuth2/OpenID provider; its slug is the application_slug.',
      'Set the client type to Public for PKCE without a secret, or Confidential.',
      'Add the redirect URI below as a Strict redirect URI.',
    ],
    build: (p) => `${hostOrigin(p.host)}/application/o/${p.application_slug}/`,
  },
  'pocket-id': {
    label: 'Pocket ID',
    pieces: ['host'],
    issuerFormat: 'https://<host>',
    scopes: 'openid profile email',
    publicPkce: true,
    usernameClaim: 'preferred_username',
    whereToCreate: 'Settings > Administration > OIDC Clients > Add OIDC Client',
    steps: [
      'Add an OIDC client and paste the redirect URI below as its callback URL.',
      'Switch on "Public Client" for PKCE without a secret; leave it off for a confidential client.',
      'Copy the client ID.',
    ],
    build: (p) => hostOrigin(p.host),
  },
  authelia: {
    label: 'Authelia',
    pieces: ['host'],
    issuerFormat: 'https://<host>',
    scopes: 'openid profile email',
    publicPkce: true,
    usernameClaim: 'preferred_username',
    whereToCreate:
      'configuration.yml > identity_providers.oidc.clients (a file edit, then a restart)',
    steps: [
      'Add a client with its redirect URI below and `authorization_policy` of your choice.',
      'For PKCE without a secret set `public: true` and `require_pkce: true`.',
      'Set `token_endpoint_auth_method: client_secret_post` for a confidential client.',
    ],
    build: (p) => hostOrigin(p.host),
  },
  keycloak: {
    label: 'Keycloak',
    pieces: ['host', 'realm'],
    issuerFormat: 'https://<host>/realms/<realm>',
    scopes: 'openid profile email',
    publicPkce: true,
    usernameClaim: 'preferred_username',
    whereToCreate: 'Admin console > the realm > Clients > Create client',
    steps: [
      'Client type OpenID Connect; switch "Client authentication" on for confidential, off for public.',
      'Under Advanced, set "Proof Key for Code Exchange Code Challenge Method" to S256.',
      'Add the redirect URI below as a valid redirect URI.',
    ],
    build: (p) => `${hostOrigin(p.host)}/realms/${p.realm}`,
  },
  zitadel: {
    label: 'ZITADEL',
    pieces: ['host'],
    issuerFormat: 'https://<host>',
    scopes: 'openid profile email',
    publicPkce: true,
    usernameClaim: 'preferred_username',
    whereToCreate: 'Console > Project > Applications > New > Web',
    steps: [
      'Choose authentication method PKCE (public) or Basic/Post (confidential).',
      'Add the redirect URI below.',
      'Copy the client ID.',
    ],
    build: (p) => hostOrigin(p.host),
  },
  kanidm: {
    label: 'Kanidm',
    pieces: ['host', 'application_slug'],
    issuerFormat: 'https://<host>/oauth2/openid/<application_slug>',
    scopes: 'openid profile email',
    publicPkce: true,
    usernameClaim: 'preferred_username',
    whereToCreate: '`kanidm system oauth2 create(-public) <name> <display> <origin>` on the server',
    steps: [
      'Use `create-public` for PKCE without a secret, `create` for a confidential client.',
      'Add the redirect URI below with `add-redirect-url`.',
      'Grant scopes with `update-scope-map <name> <group> openid profile email`.',
      'The application_slug is the client name you created.',
    ],
    build: (p) => `${hostOrigin(p.host)}/oauth2/openid/${p.application_slug}`,
  },
  google: {
    label: 'Google',
    pieces: [],
    issuerFormat: 'https://accounts.google.com',
    scopes: 'openid profile email',
    publicPkce: false,
    usernameClaim: 'email',
    whereToCreate:
      'Google Cloud console > APIs & Services > Credentials > Create credentials > OAuth client ID (Web application)',
    steps: [
      'Choose "Web application"; Google issues a client secret for it, so the client is confidential.',
      'Add the redirect URI below as an authorized redirect URI (it must be a public https host).',
    ],
    build: () => 'https://accounts.google.com',
  },
  'microsoft-entra': {
    label: 'Microsoft Entra ID',
    pieces: ['tenant_id'],
    issuerFormat: 'https://login.microsoftonline.com/<tenant_id>/v2.0',
    scopes: 'openid profile email',
    publicPkce: true,
    usernameClaim: 'preferred_username',
    whereToCreate: 'Entra admin center > App registrations > New registration',
    steps: [
      'Register a Web app (confidential, with a client secret) or a Single-page application (public, PKCE).',
      'Add the redirect URI below under Authentication.',
      'Copy the Application (client) ID and the Directory (tenant) ID.',
    ],
    build: (p) => `https://login.microsoftonline.com/${p.tenant_id}/v2.0`,
  },
  auth0: {
    label: 'Auth0',
    pieces: ['host'],
    issuerFormat: 'https://<host>/',
    scopes: 'openid profile email',
    publicPkce: true,
    usernameClaim: 'email',
    whereToCreate: 'Dashboard > Applications > Applications > Create Application',
    steps: [
      'Regular Web Application for confidential, Single Page Application for public (PKCE).',
      'Add the redirect URI below under Allowed Callback URLs.',
      'host is the tenant domain, for example example.eu.auth0.com.',
    ],
    build: (p) => `${hostOrigin(p.host)}/`,
  },
  okta: {
    label: 'Okta',
    pieces: ['host'],
    issuerFormat: 'https://<host>/oauth2/default',
    scopes: 'openid profile email',
    publicPkce: true,
    usernameClaim: 'preferred_username',
    whereToCreate: 'Admin console > Applications > Applications > Create App Integration > OIDC',
    steps: [
      'Web Application for confidential, Single-Page Application for public (PKCE).',
      'Add the redirect URI below as a sign-in redirect URI.',
      'host is your Okta domain; the default authorization server is used.',
    ],
    build: (p) => `${hostOrigin(p.host)}/oauth2/default`,
  },
  generic: {
    label: 'Any OpenID Connect provider',
    pieces: [],
    issuerFormat: "the `issuer` value of the provider's discovery document",
    scopes: 'openid profile email',
    publicPkce: true,
    usernameClaim: 'preferred_username',
    whereToCreate: "the provider's admin interface (create an OIDC web client)",
    steps: COMMON_STEPS,
    note: "Pass `issuer` exactly as the provider's /.well-known/openid-configuration reports it.",
    build: () => '',
  },
}

export interface IssuerResolution {
  readonly issuer: string | null
  readonly missing: readonly IssuerPiece[]
}

/** The issuer from an explicit `issuer`, else from the provider's pieces. */
export function resolveIssuer(
  provider: OidcProviderName,
  explicit: string | undefined,
  pieces: IssuerPieces,
): IssuerResolution {
  if (explicit !== undefined && explicit.trim() !== '') {
    return { issuer: explicit.trim(), missing: [] }
  }
  const spec = OIDC_PROVIDERS[provider]
  const missing = spec.pieces.filter((k) => (pieces[k] ?? '').trim() === '')
  if (missing.length > 0 || provider === 'generic') return { issuer: null, missing }
  return {
    issuer: spec.build({
      host: pieces.host ?? '',
      application_slug: pieces.application_slug ?? '',
      realm: pieces.realm ?? '',
      tenant_id: pieces.tenant_id ?? '',
    }),
    missing: [],
  }
}
