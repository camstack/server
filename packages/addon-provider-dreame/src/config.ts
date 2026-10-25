import type { NodreameOptions } from '@apocaliss92/nodedreame'
import type { ConfigUISchema } from '@camstack/types'
import { z } from 'zod'

/**
 * The Dreame cloud regions the wrapped `@apocaliss92/nodedreame` client
 * supports. Mirrors the library's `DreameRegion` union — kept local so the
 * addon validates the operator-supplied value at the system boundary without
 * importing a runtime value the library does not export.
 */
export const DREAME_REGIONS = ['eu', 'us', 'cn', 'ru', 'sg', 'in', 'de', 'tw'] as const
export const DreameRegionSchema = z.enum(DREAME_REGIONS)
export type DreameRegionValue = z.infer<typeof DreameRegionSchema>

/**
 * Operator-supplied Dreamehome account settings for ONE broker (= one cloud
 * account). The Dreame integration is cloud-only (outbound HTTPS + per-device
 * MQTT push), so the connection is just account credentials plus a region.
 *
 * `pollIntervalMs` is the fallback poll cadence the library uses while a
 * device's MQTT push is down; `0` disables poll fallback.
 *
 * The diagnostic catalog (enum/numeric sensors, switches, selects) is seeded
 * from the cloud SHADOW once at broker start and then tracked by the library's
 * MQTT push. Live `get_properties` is NOT polled: a docked/asleep robot times it
 * out (Home Assistant shows the same diagnostics as `unavailable` then), and
 * hammering it only adds cloud load — so we rely on the shadow seed + push.
 */
export const dreameConfigSchema = z.object({
  username: z.string().min(1).describe('Dreamehome account email / username'),
  password: z.string().min(1).describe('Dreamehome account password').meta({ secret: true }),
  region: DreameRegionSchema.default('eu').describe('Dreame cloud region'),
  pollIntervalMs: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(0).max(3_600_000).default(30_000),
    )
    .describe('Poll fallback interval (ms) while MQTT push is down — 0 disables'),
})

export type DreameConfig = z.infer<typeof dreameConfigSchema>

/**
 * Build the `NodreameOptions` the wrapped client constructor expects from the
 * validated addon config. Pure: same config in → same options out.
 */
export function toNodreameOptions(config: DreameConfig): NodreameOptions {
  return {
    username: config.username,
    password: config.password,
    region: config.region,
    // Seed each device's property cache on start() so the typed getters resolve
    // (they return null until the first values land).
    fetchInitialValues: true,
    pollIntervalMs: config.pollIntervalMs,
  }
}

// ---------------------------------------------------------------------------
// Account-mode connection (per-integration settings)
// ---------------------------------------------------------------------------
//
// `mode: account`: there is NO top-level broker array. Each Dreame integration
// carries its own account credentials in its `integration.settings`; the addon
// holds one manager per `integrationId` (see `DreameClientRegistry`). The
// connection schema above IS the integration's settings shape.

/**
 * Coerce a loose settings blob (an integration's `settings`) through the
 * connection schema, applying all defaults. Throws a `ZodError` on invalid
 * input so the caller surfaces a clear error at the system boundary. Returns
 * null when the mandatory credentials are absent (e.g. a not-yet-configured
 * integration) so the reconcile can skip it without throwing.
 */
export function settingsToDreameConfig(settings: unknown): DreameConfig {
  return dreameConfigSchema.parse(settings ?? {})
}

/**
 * Parse an integration's settings into a connection, or null when the mandatory
 * credentials (username + password) are missing. Used by the boot/lifecycle
 * reconcile to skip an integration whose account form was not completed.
 */
export function connectionFromSettings(settings: Record<string, unknown>): DreameConfig | null {
  const parsed = dreameConfigSchema.safeParse(settings)
  return parsed.success ? parsed.data : null
}

/**
 * Hand-written connection form for the account/integration creation UI — the
 * wizard's `account` config step renders this via `getGlobalSettings`. A flat
 * set of sections the admin UI renders into the "Add Dreame account" modal.
 */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'credentials',
        title: 'Dreamehome account',
        titleKey: 'provider-dreame:connection.s_credentials.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'username',
            label: 'Email / username',
            labelKey: 'provider-dreame:connection.s_credentials.username.label',
            required: true,
            placeholder: 'you@example.com',
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-dreame:connection.s_credentials.password.label',
            required: true,
            showToggle: true,
          },
        ],
      },
      {
        id: 'region',
        title: 'Region',
        titleKey: 'provider-dreame:connection.s_region.title',
        columns: 1,
        fields: [
          {
            type: 'select',
            key: 'region',
            label: 'Region',
            labelKey: 'provider-dreame:connection.s_region.region.label',
            default: 'eu',
            options: DREAME_REGIONS.map((r) => ({ value: r, label: r.toUpperCase() })),
          },
        ],
      },
      {
        id: 'advanced',
        title: 'Advanced',
        titleKey: 'provider-dreame:connection.s_advanced.title',
        columns: 1,
        fields: [
          {
            type: 'number',
            key: 'pollIntervalMs',
            label: 'Poll fallback interval (ms, 0 = disabled)',
            labelKey: 'provider-dreame:connection.s_advanced.pollIntervalMs.label',
            min: 0,
            max: 3_600_000,
            default: 30_000,
          },
        ],
      },
    ],
  }
}
