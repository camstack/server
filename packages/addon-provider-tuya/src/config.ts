import type { TuyaCloudOptions, TuyaRegion } from '@apocaliss92/nodetuya'
import type { ConfigUISchema } from '@camstack/types'
import { z } from 'zod'

/**
 * The Tuya IoT-cloud data-centre regions the wrapped `@apocaliss92/nodetuya`
 * cloud client supports. Mirrors the library's `TuyaRegion` union — kept local
 * so the addon validates the operator-supplied value at the system boundary
 * without importing a runtime value the library does not export.
 */
export const TUYA_REGION_VALUES = ['eu', 'us', 'cn', 'in'] as const
export const TuyaRegionSchema = z.enum(TUYA_REGION_VALUES)
export type TuyaRegionValue = z.infer<typeof TuyaRegionSchema>

/**
 * Operator-supplied Tuya IoT-cloud project settings for ONE integration (= one
 * cloud account, `mode: account`). Tuya only exposes each device's `localKey`
 * (the missing piece for LAN control) through an IoT project's OpenAPI, so the
 * connection carries the project's Access ID + Access Secret plus its region.
 * The Smart Life / Tuya app account must be linked to the project.
 *
 * Onboarding is CLOUD (fetch the device list + localKeys); ongoing CONTROL is
 * LOCAL (encrypted LAN protocol, one TCP client per device). `discoveryTimeoutMs`
 * bounds the passive LAN-broadcast sweep that resolves each device's IP + protocol
 * version (the cloud does not always report a reachable LAN IP).
 */
export const tuyaConfigSchema = z.object({
  accessId: z.string().min(1).describe('Tuya IoT project Access ID / Client ID'),
  accessSecret: z
    .string()
    .min(1)
    .describe('Tuya IoT project Access Secret / Client Secret')
    .meta({ secret: true }),
  region: TuyaRegionSchema.default('eu').describe('Tuya cloud data-centre region'),
  discoveryTimeoutMs: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(1_000).max(30_000).default(6_000),
    )
    .describe('LAN discovery sweep window (ms) used to resolve device IP / protocol version'),
})

export type TuyaConfig = z.infer<typeof tuyaConfigSchema>

/**
 * Build the `TuyaCloudOptions` the wrapped cloud client constructor expects from
 * the validated integration config. Pure: same config in → same options out.
 */
export function toTuyaCloudOptions(config: TuyaConfig): TuyaCloudOptions {
  return {
    accessId: config.accessId,
    accessSecret: config.accessSecret,
    region: config.region satisfies TuyaRegion,
  }
}

/**
 * Coerce a loose settings blob (an integration's `settings`) through the
 * connection schema, applying all defaults. Throws a `ZodError` on invalid
 * input so the caller surfaces a clear error at the system boundary.
 */
export function settingsToTuyaConfig(settings: unknown): TuyaConfig {
  return tuyaConfigSchema.parse(settings ?? {})
}

/**
 * Parse an integration's settings into a connection, or null when the mandatory
 * project credentials (accessId + accessSecret) are missing. Used by the
 * boot/lifecycle reconcile to skip an integration whose account form was not
 * completed.
 */
export function connectionFromSettings(settings: Record<string, unknown>): TuyaConfig | null {
  const parsed = tuyaConfigSchema.safeParse(settings)
  return parsed.success ? parsed.data : null
}

/**
 * True when two configs are the "same connection" (no cloud client rebuild
 * needed). Mirrors the Dreame/Wyze registry `sameConnection` predicate.
 */
export function sameConnection(a: TuyaConfig | null, b: TuyaConfig | null): boolean {
  if (a === null || b === null) return false
  return (
    a.accessId === b.accessId &&
    a.accessSecret === b.accessSecret &&
    a.region === b.region &&
    a.discoveryTimeoutMs === b.discoveryTimeoutMs
  )
}

/**
 * Hand-written connection form for the account/integration creation UI — the
 * wizard's `account` config step renders this via `getGlobalSettings`. A flat set
 * of sections the admin UI renders into the "Add Tuya account" modal.
 */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'credentials',
        title: 'Tuya IoT cloud project',
        titleKey: 'provider-tuya:connection.s_credentials.title',
        description:
          'Create a project at iot.tuya.com, link your Smart Life / Tuya account to it, and paste its Access ID and Access Secret.',
        descriptionKey: 'provider-tuya:connection.s_credentials.description',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'accessId',
            label: 'Access ID / Client ID',
            labelKey: 'provider-tuya:connection.s_credentials.accessId.label',
            required: true,
            placeholder: 'xxxxxxxxxxxxxxxxxxxx',
          },
          {
            type: 'password',
            key: 'accessSecret',
            label: 'Access Secret / Client Secret',
            labelKey: 'provider-tuya:connection.s_credentials.accessSecret.label',
            required: true,
            showToggle: true,
          },
        ],
      },
      {
        id: 'region',
        title: 'Region',
        titleKey: 'provider-tuya:connection.s_region.title',
        columns: 2,
        fields: [
          {
            type: 'select',
            key: 'region',
            label: 'Data-centre region',
            labelKey: 'provider-tuya:connection.s_region.region.label',
            default: 'eu',
            options: TUYA_REGION_VALUES.map((r) => ({ value: r, label: r.toUpperCase() })),
          },
          {
            type: 'number',
            key: 'discoveryTimeoutMs',
            label: 'LAN discovery window (ms)',
            labelKey: 'provider-tuya:connection.s_region.discoveryTimeoutMs.label',
            min: 1_000,
            max: 30_000,
            default: 6_000,
          },
        ],
      },
    ],
  }
}
