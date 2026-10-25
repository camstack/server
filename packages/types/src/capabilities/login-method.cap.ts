import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { AppLoginPathSchema } from '../auth/app-flow.js'
import { WidgetRemoteSchema } from './addon-widgets-source.cap.js'

/**
 * `login-method` — collection cap through which auth addons contribute
 * their pre-auth login surfaces to the login page. This is the SINGLE,
 * generic mechanism that supersedes the dead `auth.listProviders` reader:
 * every auth addon (OIDC, WebAuthn/passkey) registers a
 * `login-method` provider and the PUBLIC `auth.listLoginMethods`
 * procedure aggregates them for the unauthenticated login page.
 *
 * A contribution is a discriminated union on `kind`:
 *
 *  - `redirect` — a declarative button. The login page renders a generic
 *    button that navigates to `startUrl` (an addon-owned HTTP route).
 *    Covers OIDC (`/addon/auth-oidc/<id>/start`) with ZERO shell-side JS. A future SSO addon plugs in the same way — the
 *    login page needs NO change.
 *
 *  - `widget` — a Module-Federation widget the login page mounts (via
 *    `loadRemoteBundle`) for an in-page ceremony. `auth.listLoginMethods`
 *    stamps a public `bundleUrl` from `addonId` + `bundle`. Generic
 *    mechanism kept for future use; no shipped addon uses it on the login
 *    page (the passkey ceremony below runs natively in the shell instead).
 *
 *  - `passkey` — a declarative WebAuthn ceremony the shell renders
 *    natively (`@simplewebauthn/browser` lives in `addon-admin-ui`, not in
 *    a remotely-loaded bundle). Carries the addon's effective `rpId` /
 *    `origin` (from its `resolveRpID()` / `resolveOrigin()`) so the shell
 *    can gate visibility (IP-literal origin, hostname/rpId mismatch) WITHOUT
 *    fetching any remote code pre-auth. Contribution stays unconditional —
 *    enrollment state is never leaked pre-auth; visibility is a shell
 *    decision.
 *
 * Every contribution carries a `stage`:
 *  - `primary`        — shown on the first credentials screen (OIDC
 *                       buttons; a usernameless passkey).
 *  - `second-factor`  — shown AFTER the password leg, gated on the
 *                       returned `factors` (passkey-as-2FA today).
 *
 * `mount: skip` — the cap is read server-side by the core auth router
 * (`registry.getCollection('login-method')`), never mounted as its own
 * tRPC router.
 */

/** When a login method renders in the two-phase login flow. */
export const LoginStageEnum = z.enum(['primary', 'second-factor'])

/**
 * A declarative redirect button — the login page navigates to `startUrl`.
 * OIDC contributes this; a future SSO addon does too.
 */
export const RedirectLoginMethodSchema = z.object({
  kind: z.literal('redirect'),
  /** Stable id within the login-method set (e.g. `auth-oidc/google`). */
  id: z.string(),
  /** Operator-facing button label. */
  label: z.string(),
  /** lucide-react icon name. */
  icon: z.string().optional(),
  /** Addon-owned HTTP route the button navigates to (GET). */
  startUrl: z.string(),
  stage: LoginStageEnum,
  /**
   * The provider names an external identity a signed-in user can link to
   * their own account (D782): `auth.listLinkableProviders` /
   * `beginExternalLink` offer exactly the redirect methods that set this,
   * whatever their id. Absent / false — a login button only.
   */
  linkable: z.boolean().optional(),
  /**
   * How a NATIVE app starts this method (D858): `{ kind: 'browser', startPath }`
   * when the route understands the app flow query (`app=1&code_challenge=…`),
   * `null`/absent when there is no app path - the app hides the method.
   */
  app: AppLoginPathSchema.nullable().optional(),
})

/**
 * A Module-Federation widget the login page mounts for an in-page
 * ceremony. `bundle` + `addonId` let `auth.listLoginMethods` stamp a
 * public `bundleUrl`; `remote` is the MF descriptor `loadRemoteBundle`
 * consumes. No `bundleUrl` here — it is server-stamped on the public
 * output so the addon never encodes the static-route scheme.
 */
export const WidgetLoginMethodSchema = z.object({
  kind: z.literal('widget'),
  /** Stable id within the login-method set (e.g. `auth-webauthn/passkey-login`). */
  id: z.string(),
  /** Owning addon id — drives the public bundle URL + the MF namespace. */
  addonId: z.string(),
  /** Bundle filename inside the addon's dist dir (`remoteEntry.js`). */
  bundle: z.string(),
  /** MF remote descriptor — `{ remoteName, exposedModule, componentKey }`. */
  remote: WidgetRemoteSchema,
  stage: LoginStageEnum,
  /** Widgets are web ceremonies: no native app path (D858). Absent reads as `null`. */
  app: AppLoginPathSchema.nullable().optional(),
})

/**
 * A declarative WebAuthn ceremony the shell renders natively (no remote
 * code). Carries the addon's EFFECTIVE `rpId`/`origin` so the shell can
 * gate visibility (IP-literal origin, hostname/rpId mismatch) before ever
 * showing the button — the contribution itself stays unconditional.
 */
export const PasskeyLoginMethodSchema = z.object({
  kind: z.literal('passkey'),
  /** Stable id within the login-method set (e.g. `auth-webauthn/passkey-direct-login`). */
  id: z.string(),
  /** Operator-facing button label. */
  label: z.string(),
  stage: LoginStageEnum,
  /** Effective WebAuthn RP ID (`resolveRpID()`) — the shell gates visibility on it. */
  rpId: z.string(),
  /** Effective expected origin (`resolveOrigin()`), null when unconfigured. */
  origin: z.string().nullable(),
  /** Set by the hub for the primary arm; a second-factor passkey has no app path (D858). */
  app: AppLoginPathSchema.nullable().optional(),
})

/** One login-method contribution — redirect button, pre-auth widget, or native passkey ceremony. */
export const LoginMethodContributionSchema = z.discriminatedUnion('kind', [
  RedirectLoginMethodSchema,
  WidgetLoginMethodSchema,
  PasskeyLoginMethodSchema,
])

export const loginMethodCapability = {
  name: 'login-method',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    getLoginMethods: method(z.void(), z.array(LoginMethodContributionSchema).readonly()),
  },
  /** BIG PLAN 2: declarative mount hint — read by `@camstack/system` `buildCapRouters`. */
  mount: { kind: 'skip' },
} as const satisfies CapabilityDefinition

export type ILoginMethodProvider = InferProvider<typeof loginMethodCapability>

/** A single login-method contribution (redirect | widget | passkey). */
export type LoginMethodContribution = z.infer<typeof LoginMethodContributionSchema>
export type RedirectLoginMethod = z.infer<typeof RedirectLoginMethodSchema>
export type WidgetLoginMethod = z.infer<typeof WidgetLoginMethodSchema>
export type PasskeyLoginMethod = z.infer<typeof PasskeyLoginMethodSchema>
export type LoginStage = z.infer<typeof LoginStageEnum>
