import { z } from 'zod'
import type { ConfigOption, ConfigUISchema } from '@camstack/types'

/** The device-registry `system` tag every VeSync device carries. */
export const VESYNC_SYSTEM = 'vesync' as const

/** The Gateway device's `kind`: the account's presence, a sibling of its purifiers. */
export const VESYNC_GATEWAY_KIND = 'account' as const

/** An ISO-3166 alpha-2 country code, upper case. */
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/

/**
 * The account's country code as the form and the record carry it: trimmed, upper-cased, blank =
 * not set. One schema for the record kind AND the connection, so a value the record accepts always
 * parses as a connection (a stored bad code would drop a working account at reconcile).
 */
export const vesyncCountryCodeSchema = z
  .preprocess(
    (v) => (typeof v === 'string' ? v.trim().toUpperCase() || undefined : (v ?? undefined)),
    z.string().regex(COUNTRY_CODE_PATTERN, 'a two-letter ISO country code, e.g. IT').optional(),
  )
  .describe('VeSync account country (ISO 3166 alpha-2)')

/** The countries the Country code select offers: ISO alpha-2 code and English name. */
const VESYNC_COUNTRIES: readonly { readonly code: string; readonly name: string }[] = [
  { code: 'AT', name: 'Austria' },
  { code: 'BE', name: 'Belgium' },
  { code: 'CA', name: 'Canada' },
  { code: 'CZ', name: 'Czechia' },
  { code: 'DK', name: 'Denmark' },
  { code: 'FI', name: 'Finland' },
  { code: 'FR', name: 'France' },
  { code: 'DE', name: 'Germany' },
  { code: 'GR', name: 'Greece' },
  { code: 'HU', name: 'Hungary' },
  { code: 'IE', name: 'Ireland' },
  { code: 'IT', name: 'Italy' },
  { code: 'JP', name: 'Japan' },
  { code: 'LU', name: 'Luxembourg' },
  { code: 'MX', name: 'Mexico' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'NO', name: 'Norway' },
  { code: 'PL', name: 'Poland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'RO', name: 'Romania' },
  { code: 'ES', name: 'Spain' },
  { code: 'SE', name: 'Sweden' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
]

const COUNTRY_CODE_KEY = 'provider-vesync:connection.s_connection.countryCode'

/**
 * The Country code select: "Not set" (empty value, which `vesyncCountryCodeSchema` reads as not
 * set) first, then the countries by English name. A stored code outside this list still parses.
 */
const COUNTRY_CODE_OPTIONS: readonly ConfigOption[] = [
  { label: 'Not set', labelKey: `${COUNTRY_CODE_KEY}.o_none.label`, value: '' },
  ...VESYNC_COUNTRIES.map((country) => ({
    label: country.name,
    labelKey: `${COUNTRY_CODE_KEY}.o_${country.code}.label`,
    value: country.code,
  })),
]

/**
 * Operator-supplied credentials for ONE VeSync cloud account. They live on the
 * integration's typed record, not on a device. VeSync is cloud / account and
 * exposes no push channel via the wrapper we target, so the account is POLLED.
 * The core's state-refresh scheduler decides when (D1062): `pollIntervalMs` can
 * only SLOW its cadence, never take it below `VESYNC_MIN_REFRESH_INTERVAL_MS`.
 */
export const vesyncConnectionSchema = z.object({
  email: z.string().min(1).describe('VeSync account email'),
  password: z.string().default('').describe('VeSync account password').meta({ secret: true }),
  region: z.enum(['US', 'EU']).default('EU').describe('VeSync account home region'),
  /**
   * The account's ISO-3166 alpha-2 country (`IT`, `DE` …). The library signs in as `US` without
   * it, which a non-US account is refused for at Step 2. Blank means "not set".
   */
  countryCode: vesyncCountryCodeSchema,
  pollIntervalMs: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(5000).max(3_600_000).default(30_000),
    )
    .describe('Device-state poll interval (ms)'),
})

export type VeSyncConnectionConfig = z.infer<typeof vesyncConnectionSchema>

/**
 * The account as a {@link import('@camstack/types').DeviceType.Gateway}. The
 * credentials live on the integration; this device is only the account's presence
 * in the device list, a sibling of the purifiers (parent null).
 */
export const vesyncGatewaySchema = z.object({
  kind: z.literal(VESYNC_GATEWAY_KIND),
  integrationId: z.string().min(1).describe('Owning integration'),
  system: z.literal(VESYNC_SYSTEM).optional(),
})

export type VeSyncGatewayConfig = z.infer<typeof vesyncGatewaySchema>

/**
 * Persisted config every VeSync purifier carries. `purifierNativeId` resolves the
 * live snapshot; `integrationId` selects the account. `accountId` is the legacy hub
 * stableId a migration keeps on the blob and nothing reads. The purifier is a
 * {@link import('@camstack/types').DeviceType.Fan} that registers `switch` +
 * `fan-control` and fans out accessory children. It is a sibling of the Gateway.
 */
export const vesyncPurifierSchema = z.object({
  purifierNativeId: z.string().min(1).describe('VeSync device cid'),
  integrationId: z.string().min(1).describe('Owning integration'),
  /** Legacy hub stableId. Kept so a migrated blob still parses; not read. */
  accountId: z.string().min(1).optional(),
  model: z.string().optional(),
  system: z.literal(VESYNC_SYSTEM).optional(),
})

export type VeSyncPurifierConfig = z.infer<typeof vesyncPurifierSchema>

/**
 * Persisted config every VeSync humidifier carries. `humidifierNativeId` resolves the
 * live snapshot; `integrationId` selects the account. A
 * {@link import('@camstack/types').DeviceType.Humidifier} that registers `humidifier`
 * and fans out accessory children (display switch, humidity + water-low sensors). It is
 * a sibling of the Gateway.
 */
export const vesyncHumidifierSchema = z.object({
  humidifierNativeId: z.string().min(1).describe('VeSync device cid'),
  integrationId: z.string().min(1).describe('Owning integration'),
  model: z.string().optional(),
  system: z.literal(VESYNC_SYSTEM).optional(),
})

export type VeSyncHumidifierConfig = z.infer<typeof vesyncHumidifierSchema>

/** The two boolean toggles a purifier exposes as `DeviceType.Switch` children. */
export const VeSyncToggleKindSchema = z.enum(['child-lock', 'display'])
export type VeSyncToggleKind = z.infer<typeof VeSyncToggleKindSchema>

/**
 * Persisted config for a VeSync purifier `DeviceType.Switch` accessory child. A
 * device may register the `switch` cap only ONCE, so `child_lock` and `display`
 * are modelled as two SEPARATE Switch accessory children (not extra `switch`
 * caps on the Fan). `kind` selects which client toggle the child drives.
 */
export const vesyncToggleSchema = z.object({
  kind: VeSyncToggleKindSchema,
  /** The PARENT's VeSync cid — a purifier or a humidifier (name kept: stored children parse). */
  purifierNativeId: z.string().min(1).describe('VeSync device cid of the parent'),
  integrationId: z.string().min(1).describe('Owning integration'),
  /** Legacy hub stableId. Kept so a migrated blob still parses; not read. */
  accountId: z.string().min(1).optional(),
  system: z.literal(VESYNC_SYSTEM).optional(),
})

export type VeSyncToggleConfig = z.infer<typeof vesyncToggleSchema>

/**
 * The read-only metrics exposed as `DeviceType.Sensor` children: `air-quality` and
 * `filter-life` of a purifier, `humidity` and `water-low` of a humidifier.
 */
export const VeSyncSensorKindSchema = z.enum([
  'air-quality',
  'filter-life',
  'humidity',
  'water-low',
])
export type VeSyncSensorKind = z.infer<typeof VeSyncSensorKindSchema>

/**
 * Persisted config for a VeSync purifier `DeviceType.Sensor` accessory child.
 * `air-quality` registers the `air-quality-sensor` cap; `filter-life` registers
 * a `numeric-sensor` cap (unit `%`).
 */
export const vesyncSensorSchema = z.object({
  kind: VeSyncSensorKindSchema,
  /** The PARENT's VeSync cid — a purifier or a humidifier (name kept: stored children parse). */
  purifierNativeId: z.string().min(1).describe('VeSync device cid of the parent'),
  integrationId: z.string().min(1).describe('Owning integration'),
  /** Legacy hub stableId. Kept so a migrated blob still parses; not read. */
  accountId: z.string().min(1).optional(),
  system: z.literal(VESYNC_SYSTEM).optional(),
})

export type VeSyncSensorConfig = z.infer<typeof vesyncSensorSchema>

/**
 * Narrow an `unknown` value to a shallow-cloned plain object record, or an empty
 * record when it is not a plain object. Mirrors the Velux / Ecowitt `toRecord`
 * helper — a cast-free boundary narrowing.
 */
function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value))
  }
  return {}
}

/** Coerce a loose settings blob through the connection schema, applying defaults. */
export function settingsToConnection(settings: unknown): VeSyncConnectionConfig {
  return vesyncConnectionSchema.parse(toRecord(settings))
}

/** The account fields a record body may carry. `name` is the instance name, ignored here. */
export interface VeSyncAccountFields {
  readonly email?: string | undefined
  readonly password?: string | undefined
  readonly region?: 'US' | 'EU' | undefined
  readonly countryCode?: string | undefined
  readonly pollIntervalMs?: number | undefined
}

/**
 * The account a record body holds, or null while email or password is missing.
 * A locked secret is not a body this function sees: the caller stops first.
 */
export function connectionFromBody(body: VeSyncAccountFields): VeSyncConnectionConfig | null {
  const email = (body.email ?? '').trim()
  const password = body.password ?? ''
  if (email.length === 0 || password.length === 0) return null
  return vesyncConnectionSchema.parse({
    email,
    password,
    ...(body.region !== undefined ? { region: body.region } : {}),
    ...(body.countryCode !== undefined ? { countryCode: body.countryCode } : {}),
    ...(body.pollIntervalMs !== undefined ? { pollIntervalMs: body.pollIntervalMs } : {}),
  })
}

/**
 * Slugify an account email into a readable, stable row-key fragment. Exported so
 * the account's `stableId` derivation is consistent across create / re-add.
 */
export function slugifyEmail(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Credential form for one integration instance. The instance name is the
 * registry's; this form is only the account the record stores.
 */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'connection',
        title: 'Credentials',
        titleKey: 'provider-vesync:connection.s_connection.title',
        description: 'Use the same email and password as the VeSync mobile app.',
        descriptionKey: 'provider-vesync:connection.s_connection.description',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'email',
            label: 'Email',
            labelKey: 'provider-vesync:connection.s_connection.email.label',
            required: true,
            placeholder: 'you@example.com',
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-vesync:connection.s_connection.password.label',
            showToggle: true,
          },
          {
            type: 'select',
            key: 'region',
            label: 'Region',
            labelKey: 'provider-vesync:connection.s_connection.region.label',
            default: 'EU',
            options: [
              {
                label: 'Europe',
                labelKey: 'provider-vesync:connection.s_connection.region.o_EU.label',
                value: 'EU',
              },
              {
                label: 'United States',
                labelKey: 'provider-vesync:connection.s_connection.region.o_US.label',
                value: 'US',
              },
            ],
          },
          {
            type: 'select',
            key: 'countryCode',
            label: 'Country code',
            labelKey: 'provider-vesync:connection.s_connection.countryCode.label',
            description:
              'Country the account was registered in. Set it when sign-in fails with "auth code expired".',
            descriptionKey: 'provider-vesync:connection.s_connection.countryCode.description',
            options: COUNTRY_CODE_OPTIONS,
          },
          {
            type: 'number',
            key: 'pollIntervalMs',
            label: 'Poll interval (ms)',
            labelKey: 'provider-vesync:connection.s_connection.pollIntervalMs.label',
            min: 5000,
            max: 3_600_000,
            default: 30_000,
          },
        ],
      },
    ],
  }
}
