import { z } from 'zod'
import type { ConfigUISchema } from '../interfaces/config-ui.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * `oidc-connections` — CRUD for IdP rows under `auth-oidc` (D828 sibling).
 *
 * One hub-only singleton (`auth-oidc`). The Settings UI is a DataTable +
 * ItemFormDialog; there is no `editable-array` in `globalSettingsSchema`.
 * Operator-chosen `id` is the URL slug (`/addon/auth-oidc/<id>/…`) and is
 * immutable after create.
 */

const ConfigSchemaPassthrough = z.unknown()

export const OidcConnectionSchema = z.object({
  id: z.string().min(1),
  displayName: z.string(),
  icon: z.string(),
  issuerUrl: z.string(),
  clientId: z.string(),
  /** Client id + secret present — never the secret value. */
  configured: z.boolean(),
  /**
   * Values for the connection form schema. `clientSecret` is a keychain
   * {@link SecretFieldView} or `null` / `''`, never plaintext (D789).
   */
  formValues: z.record(z.string(), z.unknown()).optional(),
})
export type OidcConnection = z.infer<typeof OidcConnectionSchema>

/**
 * Patch one connection. Omitted or empty `clientSecret` keeps the stored
 * secret (D787). `{ $secretClear: true }` clears it. `id` is never renamed.
 */
export const OidcConnectionUpdateInputSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  icon: z.string().optional(),
  issuerUrl: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.union([z.string(), z.object({ $secretClear: z.literal(true) })]).optional(),
  redirectUri: z.string().optional(),
  scopes: z.string().optional(),
  usernameClaim: z.enum(['preferred_username', 'email', 'sub']).optional(),
})
export type OidcConnectionUpdateInput = z.infer<typeof OidcConnectionUpdateInputSchema>

export const oidcConnectionsCapability = {
  name: 'oidc-connections',
  scope: 'system',
  mode: 'singleton',
  methods: {
    /** Form fields for Add/Edit (ConfigFormBuilder). */
    connectionFormSchema: method(z.object({}), ConfigSchemaPassthrough, { auth: 'admin' }),

    listConnections: method(z.object({}), z.array(OidcConnectionSchema).readonly(), {
      auth: 'admin',
    }),

    /**
     * Create a row with the operator-chosen URL slug. Credentials follow via
     * `updateConnection` (same Save path as Training Providers).
     */
    createConnection: method(
      z.object({
        id: z
          .string()
          .min(1)
          .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'id must be a lowercase slug'),
        displayName: z.string().min(1),
      }),
      z.object({ id: z.string() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    updateConnection: method(OidcConnectionUpdateInputSchema, z.object({ ok: z.literal(true) }), {
      kind: 'mutation',
      auth: 'admin',
    }),

    deleteConnection: method(
      z.object({ id: z.string().min(1) }),
      z.object({ ok: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IOidcConnectionsProvider = InferProvider<typeof oidcConnectionsCapability> & {
  connectionFormSchema: () => Promise<ConfigUISchema>
}
