import type { NodepetkitOptions, PetkitCredentials } from '@apocaliss92/nodepetkit'
import type { ConfigUISchema } from '@camstack/types'
import { z } from 'zod'

/**
 * The PetKit cloud regions offered in the account form. The wrapped
 * `@apocaliss92/nodepetkit` client resolves any region name / ISO id to a
 * gateway at login, but a fixed select keeps the UI honest for the common
 * cases. Kept local so the addon validates the operator-supplied value at the
 * system boundary. Default `de` mirrors the library's own default.
 */
export const PETKIT_REGIONS = [
  'de',
  'us',
  'gb',
  'ca',
  'au',
  'fr',
  'it',
  'es',
  'nl',
  'pl',
  'cn',
  'sg',
  'in',
] as const
export const PetkitRegionSchema = z.enum(PETKIT_REGIONS)
export type PetkitRegionValue = z.infer<typeof PetkitRegionSchema>

/**
 * Operator-supplied PetKit account settings for ONE integration (= one cloud
 * account). PetKit is cloud-only (a REST client with no push channel), so the
 * connection is just account credentials plus a region and a poll cadence.
 *
 * `pollIntervalMs` is the per-device refresh cadence: PetKit exposes no push
 * channel, so each adopted feeder re-polls its detail on this interval (and
 * eagerly after every command). `0` leaves only the eager + stale-read
 * refreshes.
 */
export const petkitConfigSchema = z.object({
  email: z.string().min(1).describe('PetKit account email'),
  password: z.string().min(1).describe('PetKit account password').meta({ secret: true }),
  region: PetkitRegionSchema.default('de').describe('PetKit cloud region'),
  timezone: z
    .string()
    .default('Europe/Berlin')
    .describe('IANA timezone used for cloud request headers'),
  pollIntervalMs: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(0).max(3_600_000).default(30_000),
    )
    .describe('Per-feeder poll cadence (ms) — 0 leaves only eager/stale refresh'),
})

export type PetkitConfig = z.infer<typeof petkitConfigSchema>

/** Build the `PetkitCredentials` the client login expects. Pure. */
export function toPetkitCredentials(config: PetkitConfig): PetkitCredentials {
  return { email: config.email, password: config.password }
}

/** Build the `NodepetkitOptions` (region + timezone) the client expects. Pure. */
export function toNodepetkitOptions(config: PetkitConfig): NodepetkitOptions {
  return { region: config.region, timezone: config.timezone }
}

/**
 * Coerce a loose settings blob (an integration's `settings`) through the
 * connection schema, applying all defaults. Throws a `ZodError` on invalid
 * input so the caller surfaces a clear error at the system boundary.
 */
export function settingsToPetkitConfig(settings: unknown): PetkitConfig {
  return petkitConfigSchema.parse(settings ?? {})
}

/**
 * Parse an integration's settings into a connection, or null when the
 * mandatory credentials (email + password) are missing. Used by the
 * boot/lifecycle reconcile to skip an integration whose account form was not
 * completed.
 */
export function connectionFromSettings(settings: Record<string, unknown>): PetkitConfig | null {
  const parsed = petkitConfigSchema.safeParse(settings)
  return parsed.success ? parsed.data : null
}

/** True when two configs are the "same connection" (no client rebuild needed). */
export function sameConnection(a: PetkitConfig | null, b: PetkitConfig | null): boolean {
  if (a === null || b === null) return false
  return (
    a.email === b.email &&
    a.password === b.password &&
    a.region === b.region &&
    a.timezone === b.timezone &&
    a.pollIntervalMs === b.pollIntervalMs
  )
}

// ---------------------------------------------------------------------------
// Adopted feeder device persisted config (account mode)
// ---------------------------------------------------------------------------

/**
 * Persisted config for an adopted PetKit feeder
 * ({@link import('@camstack/types').DeviceType.PetFeeder}). `integrationId`
 * selects the account's live client (published on the in-process facade
 * resolver); `petkitDeviceId` resolves the live `FeederDevice` handle within
 * it. `petkitDeviceType` (`d4sh`, `feeder`, …) + `isDualHopper` are captured at
 * adoption so the cold-start slice gates the two-hopper UI before the first
 * poll. `system`/`name`/`model` are provenance.
 */
export const petkitFeederDeviceSchema = z.object({
  petkitDeviceId: z.string().min(1).describe('PetKit cloud device id'),
  integrationId: z.string().min(1).describe('Owning integration (account) id'),
  petkitDeviceType: z.string().min(1).describe('PetKit device type (e.g. d4sh, feeder)'),
  isDualHopper: z.boolean().optional().describe('D4S/D4SH dual-hopper hardware'),
  model: z.string().optional().describe('PetKit model string'),
  system: z.literal('petkit').optional(),
  name: z.string().optional(),
  lastFeedGrams: z
    .number()
    .int()
    .min(4)
    .max(200)
    .nullable()
    .optional()
    .describe('Last manual-feed portion (single hopper)'),
  lastFeedHopper1: z
    .number()
    .int()
    .min(4)
    .max(200)
    .nullable()
    .optional()
    .describe('Last manual-feed portion, hopper 1'),
  lastFeedHopper2: z
    .number()
    .int()
    .min(4)
    .max(200)
    .nullable()
    .optional()
    .describe('Last manual-feed portion, hopper 2'),
})

export type PetkitFeederDeviceConfig = z.infer<typeof petkitFeederDeviceSchema>

/** Operator guidance on the one-session-per-account rule (shown under the account section). */
export const ACCOUNT_SESSION_GUIDANCE =
  'PetKit allows only one active session per account: signing in here signs the same account out of the PetKit phone app and Home Assistant. In the PetKit app, add a family member (share your devices with a second account) and use that account here, so your main account stays on your phone.'

/**
 * Hand-written account form for the integration creation UI — the wizard's
 * `account` config step renders this via `getGlobalSettings`. The submitted
 * values are stored PER-INTEGRATION (`integrations.create({ addonId, name,
 * settings })`); the addon reads creds from `integration.settings`, not a
 * global store.
 */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'credentials',
        title: 'PetKit account',
        titleKey: 'provider-petkit:connection.s_credentials.title',
        description: ACCOUNT_SESSION_GUIDANCE,
        descriptionKey: 'provider-petkit:connection.s_credentials.description',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'email',
            label: 'Email',
            labelKey: 'provider-petkit:connection.s_credentials.email.label',
            required: true,
            placeholder: 'you@example.com',
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-petkit:connection.s_credentials.password.label',
            required: true,
            showToggle: true,
          },
        ],
      },
      {
        id: 'region',
        title: 'Region',
        titleKey: 'provider-petkit:connection.s_region.title',
        columns: 1,
        fields: [
          {
            type: 'select',
            key: 'region',
            label: 'Region',
            labelKey: 'provider-petkit:connection.s_region.region.label',
            default: 'de',
            options: PETKIT_REGIONS.map((r) => ({
              value: r,
              label: r.toUpperCase(),
            })),
          },
        ],
      },
      {
        id: 'advanced',
        title: 'Advanced',
        titleKey: 'provider-petkit:connection.s_advanced.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'timezone',
            label: 'Timezone (IANA)',
            labelKey: 'provider-petkit:connection.s_advanced.timezone.label',
            required: false,
            placeholder: 'Europe/Berlin',
          },
          {
            type: 'number',
            key: 'pollIntervalMs',
            label: 'Poll cadence (ms, 0 = eager only)',
            labelKey: 'provider-petkit:connection.s_advanced.pollIntervalMs.label',
            min: 0,
            max: 3_600_000,
            default: 30_000,
          },
        ],
      },
    ],
  }
}
