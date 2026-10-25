import { z } from 'zod'
import type { ConfigUISchema } from '@camstack/types'

/**
 * Operator-supplied connection to ONE Velux KLF-200 gateway on the local
 * network. The addon runs in `standalone` mode (the Reolink / Ecowitt /
 * Rademacher pattern): the CONNECTION lives on the gateway DEVICE config, not a
 * broker registry. The KLF-200 has no push channel exposed by the wrapper we
 * target, so the gateway is POLLED — `pollIntervalMs` drives the node-state
 * refresh cadence.
 */
export const veluxConnectionSchema = z.object({
  host: z.string().min(1).describe('KLF-200 host name or IP address'),
  password: z
    .string()
    .default('')
    .describe('KLF-200 WiFi/web password (printed on the back of the unit)')
    .meta({ secret: true }),
  pollIntervalMs: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(2000).max(3_600_000).default(30_000),
    )
    .describe('Node-state poll interval (ms)'),
})

export type VeluxConnectionConfig = z.infer<typeof veluxConnectionSchema>

/**
 * Persisted config for a Velux gateway {@link import('@camstack/types').DeviceType.Hub}
 * device. The gateway owns exactly one live client keyed on its own `stableId`;
 * adopted cover children reference it via their `gatewayId` config field.
 */
export const veluxGatewaySchema = z.object({
  connection: veluxConnectionSchema,
  /** Provenance marker used to scope offline / cascade helpers. */
  system: z.literal('velux-gateway').optional(),
})

export type VeluxGatewayConfig = z.infer<typeof veluxGatewaySchema>

/** HA-oriented cover device class (`device_class` window vs shutter). */
export const VeluxCoverClassSchema = z.enum(['window', 'shutter'])
export type VeluxCoverClass = z.infer<typeof VeluxCoverClassSchema>

/**
 * Persisted config every Velux cover child carries. `nodeId` resolves the live
 * node from the gateway's client; `gatewayId` selects the parent gateway (its
 * Hub `stableId`). `coverClass` records whether the actuator is a window or a
 * roller shutter (drives the cover `device_class` / icon). Velux actuators are
 * positional with no tilt, so there is no tilt gate here.
 */
export const veluxCoverSchema = z.object({
  nodeId: z.number().int().nonnegative().describe('KLF-200 actuator node id'),
  gatewayId: z.string().min(1).describe('Parent gateway stableId'),
  coverClass: VeluxCoverClassSchema.default('window'),
  system: z.literal('velux').optional(),
})

export type VeluxCoverConfig = z.infer<typeof veluxCoverSchema>

/**
 * Narrow an `unknown` value to a shallow-cloned plain object record, or an empty
 * record when it is not a plain object. Mirrors the Rademacher / Ecowitt
 * `toRecord` helper — a cast-free boundary narrowing.
 */
function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value))
  }
  return {}
}

/** Coerce a loose settings blob through the connection schema, applying defaults. */
export function settingsToConnection(settings: unknown): VeluxConnectionConfig {
  return veluxConnectionSchema.parse(toRecord(settings))
}

/**
 * Slugify a host into a readable, stable row-key fragment. Exported so the
 * discovery candidate's `stableId` matches exactly what `generateStableId`
 * derives on adopt.
 */
export function slugifyHost(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Hand-written connection form for the gateway device-creation UI (standalone
 * mode — Reolink / Rademacher pattern). The connection lives on the gateway
 * DEVICE config, not in a broker registry. A `name` field lets the operator name
 * the gateway at creation time.
 */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'identity',
        title: 'Gateway',
        titleKey: 'provider-velux:connection.s_identity.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'name',
            label: 'Name',
            labelKey: 'provider-velux:connection.s_identity.name.label',
            required: true,
            placeholder: 'Velux KLF-200',
          },
        ],
      },
      {
        id: 'connection',
        title: 'Connection',
        titleKey: 'provider-velux:connection.s_connection.title',
        description: 'The password is the WiFi/web password printed on the back of the unit.',
        descriptionKey: 'provider-velux:connection.s_connection.description',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'host',
            label: 'Gateway host / IP',
            labelKey: 'provider-velux:connection.s_connection.host.label',
            required: true,
            placeholder: '192.168.20.65',
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-velux:connection.s_connection.password.label',
            showToggle: true,
          },
          {
            type: 'number',
            key: 'pollIntervalMs',
            label: 'Poll interval (ms)',
            labelKey: 'provider-velux:connection.s_connection.pollIntervalMs.label',
            min: 2000,
            max: 3_600_000,
            default: 30_000,
          },
        ],
      },
    ],
  }
}
