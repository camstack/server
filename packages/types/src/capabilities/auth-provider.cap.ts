import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

const AuthResultSchema = z.object({
  userId: z.string(),
  username: z.string(),
  email: z.string().optional(),
  displayName: z.string().optional(),
  /**
   * Whether the authenticating user is an admin. The auth-provider
   * surface returns this so the server's login flow can mint a JWT
   * with the correct bypass flag. Non-admin users authenticated via
   * an external IdP still need their scopes assigned by an admin via
   * `setUserScopes` — the SSO flow doesn't carry permissions.
   */
  isAdmin: z.boolean().default(false),
})

export const authProviderCapability = {
  name: 'auth-provider',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    validateCredentials: method(
      z.object({ username: z.string(), password: z.string() }),
      AuthResultSchema.nullable(),
      { kind: 'mutation' },
    ),
    getLoginUrl: method(z.object({ state: z.string() }), z.string()),
    handleCallback: method(z.record(z.string(), z.string()), AuthResultSchema, {
      kind: 'mutation',
    }),
    validateToken: method(z.object({ token: z.string() }), AuthResultSchema.nullable()),
  },
  /** BIG PLAN 2: declarative mount hint — read by `@camstack/system` `buildCapRouters`. */
  mount: { kind: 'skip' },
} as const satisfies CapabilityDefinition

export type IAuthProvider = InferProvider<typeof authProviderCapability>

export { AuthResultSchema }
