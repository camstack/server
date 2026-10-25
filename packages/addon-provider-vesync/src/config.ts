import { z } from 'zod'
import type { ConfigUISchema } from '@camstack/types'

/**
 * Operator-supplied credentials for ONE VeSync cloud account. The addon runs in
 * `standalone` mode (the Reolink / Ecowitt / Velux pattern): the CONNECTION lives
 * on the account DEVICE config, not a broker registry. VeSync is cloud / account
 * (not local) and exposes no push channel via the wrapper we target, so the
 * account is POLLED — `pollIntervalMs` drives the device-state refresh cadence.
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
 * Persisted config for a VeSync account {@link import('@camstack/types').DeviceType.Hub}
 * device. The account owns exactly one live client keyed on its own `stableId`;
 * adopted purifier children reference it via their `accountId` config field.
 */
export const vesyncAccountSchema = z.object({
  connection: vesyncConnectionSchema,
  /** Provenance marker used to scope offline / cascade helpers. */
  system: z.literal('vesync-account').optional(),
})

export type VeSyncAccountConfig = z.infer<typeof vesyncAccountSchema>

/**
 * Persisted config every VeSync purifier child carries. `purifierNativeId`
 * resolves the live snapshot from the account's client; `accountId` selects the
 * parent account (its Hub `stableId`). `model` records the VeSync model string
 * for display / icon. The purifier is a {@link import('@camstack/types').DeviceType.Fan}
 * that registers `switch` + `fan-control` and fans out accessory children.
 */
export const vesyncPurifierSchema = z.object({
  purifierNativeId: z.string().min(1).describe('VeSync device cid'),
  accountId: z.string().min(1).describe('Parent account stableId'),
  model: z.string().optional(),
  system: z.literal('vesync').optional(),
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
  accountId: z.string().min(1).describe('Parent account stableId'),
  system: z.literal('vesync').optional(),
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
  accountId: z.string().min(1).describe('Parent account stableId'),
  system: z.literal('vesync').optional(),
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
 * Hand-written credential form for the account device-creation UI (standalone
 * mode — Reolink / Velux pattern). The connection lives on the account DEVICE
 * config, not in a broker registry. A `name` field lets the operator name the
 * account at creation time.
 */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'identity',
        title: 'Account',
        titleKey: 'provider-vesync:connection.s_identity.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'name',
            label: 'Name',
            labelKey: 'provider-vesync:connection.s_identity.name.label',
            required: true,
            placeholder: 'VeSync',
          },
        ],
      },
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
