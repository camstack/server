import { z } from 'zod'
import type { ConfigUISchema } from '@camstack/types'

/**
 * Dreo cloud regions the wrapped `@apocaliss92/nodedreo` client accepts. The
 * library does not export a region enum (region is a free `opts.region` string),
 * so we mirror the common Dreo regions locally and validate the operator-supplied
 * value at the system boundary. `us` is the default (the most common Dreo cloud).
 */
export const DREO_REGIONS = ['us', 'eu'] as const
export const DreoRegionSchema = z.enum(DREO_REGIONS)
export type DreoRegionValue = z.infer<typeof DreoRegionSchema>

/**
 * Operator-supplied Dreo account settings for ONE integration (= one cloud
 * account). The Dreo integration is cloud-only (REST auth + a persistent
 * WebSocket push), so the connection is just account credentials plus a region.
 */
export const dreoConfigSchema = z.object({
  email: z.string().min(1).describe('Dreo account email'),
  password: z.string().min(1).describe('Dreo account password').meta({ secret: true }),
  region: DreoRegionSchema.default('us').describe('Dreo cloud region'),
})

export type DreoConfig = z.infer<typeof dreoConfigSchema>

/** Credentials object the `Nodedreo` constructor's first argument expects. */
export interface DreoCredentials {
  readonly email: string
  readonly password: string
}

/** Options object the `Nodedreo` constructor's second argument accepts. */
export interface DreoClientOptions {
  readonly region: string
}

/**
 * Split the validated addon config into the two arguments the `Nodedreo`
 * constructor expects (`creds`, `opts`). Pure: same config in → same args out.
 */
export function toDreoConstructorArgs(config: DreoConfig): {
  readonly creds: DreoCredentials
  readonly opts: DreoClientOptions
} {
  return {
    creds: { email: config.email, password: config.password },
    opts: { region: config.region },
  }
}

// ---------------------------------------------------------------------------
// Account-mode connection (per-integration settings)
// ---------------------------------------------------------------------------
//
// `mode: account`: there is NO top-level broker array. Each Dreo integration
// carries its own account credentials in its `integration.settings`; the addon
// holds one manager per `integrationId` (see `DreoClientRegistry`). The
// connection schema above IS the integration's settings shape.

/**
 * Coerce a loose settings blob (an integration's `settings`) through the
 * connection schema, applying all defaults. Throws a `ZodError` on invalid
 * input so the caller surfaces a clear error at the system boundary.
 */
export function settingsToDreoConfig(settings: unknown): DreoConfig {
  return dreoConfigSchema.parse(settings ?? {})
}

/**
 * Parse an integration's settings into a connection, or null when the mandatory
 * credentials (email + password) are missing. Used by the boot/lifecycle
 * reconcile to skip an integration whose account form was not completed.
 */
export function connectionFromSettings(settings: Record<string, unknown>): DreoConfig | null {
  const parsed = dreoConfigSchema.safeParse(settings)
  return parsed.success ? parsed.data : null
}

/**
 * Hand-written connection form for the account/integration creation UI — the
 * wizard's `account` config step renders this via `getGlobalSettings`. A flat
 * set of sections the admin UI renders into the "Add Dreo account" modal.
 */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'credentials',
        title: 'Dreo account',
        titleKey: 'provider-dreo:connection.s_credentials.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'email',
            label: 'Email',
            labelKey: 'provider-dreo:connection.s_credentials.email.label',
            required: true,
            placeholder: 'you@example.com',
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-dreo:connection.s_credentials.password.label',
            required: true,
            showToggle: true,
          },
        ],
      },
      {
        id: 'region',
        title: 'Region',
        titleKey: 'provider-dreo:connection.s_region.title',
        columns: 1,
        fields: [
          {
            type: 'select',
            key: 'region',
            label: 'Region',
            labelKey: 'provider-dreo:connection.s_region.region.label',
            default: 'us',
            options: DREO_REGIONS.map((r) => ({ value: r, label: r.toUpperCase() })),
          },
        ],
      },
    ],
  }
}
