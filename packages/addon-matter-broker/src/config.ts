import { z } from 'zod'
import type { ConfigUISchema } from '@camstack/types'

/**
 * Matter broker connection settings for ONE fabric/controller (one broker entry).
 * v1 is intentionally minimal: optional Thread / Wi-Fi credentials supplied up
 * front for wireless commissioning. The pairing code itself is NOT stored here —
 * it is passed transiently to the commissioning action.
 *
 * The fabric credentials (root cert / NOC / node registry) live in the addon
 * `dataDir` via the controller's storage, NEVER in this typed KV.
 */
export const matterConnectionSchema = z.object({
  /** Optional Thread operational dataset (hex) for Thread device onboarding. */
  threadDataset: z
    .string()
    .default('')
    .describe('Thread operational dataset (hex) — required only for Thread devices')
    .meta({ secret: true }),
  /** Optional Wi-Fi SSID for Wi-Fi device onboarding over BLE. */
  wifiSsid: z.string().default('').describe('Wi-Fi SSID — required only for BLE Wi-Fi onboarding'),
  /** Optional Wi-Fi password for Wi-Fi device onboarding over BLE. */
  wifiPassword: z.string().default('').describe('Wi-Fi password (optional)').meta({ secret: true }),
  /** PULL-reconcile interval for the commissioned-node inventory. */
  reconcileIntervalMs: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(10_000).max(86_400_000).default(300_000),
    )
    .describe('Node-inventory reconcile interval (ms)'),
})

export type MatterConnection = z.infer<typeof matterConnectionSchema>

/** A single registered Matter fabric ("broker"). */
export const MatterBrokerEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  connection: matterConnectionSchema,
  integrationId: z.string().optional(),
})
export type MatterBrokerEntry = z.infer<typeof MatterBrokerEntrySchema>

/** Top-level addon config — an ordered list of broker entries (default empty). */
export const matterAddonConfigSchema = z.object({
  brokers: z.array(MatterBrokerEntrySchema).default([]),
})
export type MatterAddonConfig = z.infer<typeof matterAddonConfigSchema>

/** Narrow an `unknown` to a shallow plain-object record (cast-free boundary). */
function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value))
  }
  return {}
}

/** Coerce a loose settings blob through the connection schema, applying defaults. */
export function settingsToMatterConnection(settings: unknown): MatterConnection {
  return matterConnectionSchema.parse(toRecord(settings))
}

/** Hand-written connection form for the broker/integration creation UI. */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'matter-fabric',
        title: 'Matter fabric',
        titleKey: 'matter-broker:connection.s_matter-fabric.title',
        description:
          'CamStack owns a Matter fabric on this hub. Add wireless onboarding credentials only if you will commission Thread or BLE-Wi-Fi devices. On-network (Ethernet/Wi-Fi) Matter devices need none of these.',
        descriptionKey: 'matter-broker:connection.s_matter-fabric.description',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'threadDataset',
            // The operational dataset carries the Thread network key (D783).
            secret: true,
            label: 'Thread operational dataset (hex, optional)',
            labelKey: 'matter-broker:connection.s_matter-fabric.threadDataset.label',
            placeholder: '0e08000000000001…',
          },
          {
            type: 'text',
            key: 'wifiSsid',
            label: 'Wi-Fi SSID (optional)',
            labelKey: 'matter-broker:connection.s_matter-fabric.wifiSsid.label',
          },
          {
            type: 'password',
            key: 'wifiPassword',
            label: 'Wi-Fi password (optional)',
            labelKey: 'matter-broker:connection.s_matter-fabric.wifiPassword.label',
            showToggle: true,
          },
          {
            type: 'number',
            key: 'reconcileIntervalMs',
            label: 'Node reconcile interval (ms)',
            labelKey: 'matter-broker:connection.s_matter-fabric.reconcileIntervalMs.label',
            min: 10_000,
            max: 86_400_000,
            default: 300_000,
          },
        ],
      },
    ],
  }
}
