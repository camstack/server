import { z } from 'zod'
import type { ConfigUISchema } from '@camstack/types'

/** The device-registry `system` tag every VeSync device carries. */
export const VESYNC_SYSTEM = 'vesync' as const

/** The Gateway device's `kind`: the account's presence, a sibling of its purifiers. */
export const VESYNC_GATEWAY_KIND = 'account' as const

/**
 * Operator-supplied credentials for ONE VeSync cloud account. They live on the
 * integration's typed record, not on a device. VeSync is cloud / account and
 * exposes no push channel via the wrapper we target, so the account is POLLED —
 * `pollIntervalMs` drives the device-state refresh cadence.
 */
export const vesyncConnectionSchema = z.object({
  email: z.string().min(1).describe('VeSync account email'),
  password: z.string().default('').describe('VeSync account password').meta({ secret: true }),
  region: z.enum(['US', 'EU']).default('EU').describe('VeSync account home region'),
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
  purifierNativeId: z.string().min(1).describe('VeSync device cid'),
  integrationId: z.string().min(1).describe('Owning integration'),
  /** Legacy hub stableId. Kept so a migrated blob still parses; not read. */
  accountId: z.string().min(1).optional(),
  system: z.literal(VESYNC_SYSTEM).optional(),
})

export type VeSyncToggleConfig = z.infer<typeof vesyncToggleSchema>

/** The two read-only metrics a purifier exposes as `DeviceType.Sensor` children. */
export const VeSyncSensorKindSchema = z.enum(['air-quality', 'filter-life'])
export type VeSyncSensorKind = z.infer<typeof VeSyncSensorKindSchema>

/**
 * Persisted config for a VeSync purifier `DeviceType.Sensor` accessory child.
 * `air-quality` registers the `air-quality-sensor` cap; `filter-life` registers
 * a `numeric-sensor` cap (unit `%`).
 */
export const vesyncSensorSchema = z.object({
  kind: VeSyncSensorKindSchema,
  purifierNativeId: z.string().min(1).describe('VeSync device cid'),
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
