import { z } from 'zod'
import type { ConfigUISchema } from '@camstack/types'

/**
 * Operator-supplied Ecowitt gateway settings for ONE broker (= one station).
 * Two transports behind a `transport` discriminator:
 *
 * - `local` (local-poll): the addon polls the gateway over HTTP (`host`/`port`/
 *   optional `password`, with poll + mapping intervals).
 * - `listener` (push): the addon runs an HTTP server the gateway uploads to
 *   (the gateway's "Customized" upload must point at the hub's LAN IP:port).
 *
 * Local-poll is the recommended default — it has no inbound-IP constraint.
 */

const baseFields = {
  /** Human-overridable station identity used to scope the adopted gateway. */
  stationId: z
    .string()
    .default('')
    .describe('Optional stable station id (auto-derived when blank)'),
}

export const ecowittLocalConfigSchema = z.object({
  transport: z.literal('local'),
  host: z.string().min(1).describe('Ecowitt gateway host name or IP address'),
  port: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(1).max(65535).default(80),
    )
    .describe('Gateway HTTP port'),
  password: z
    .string()
    .default('')
    .describe('Gateway password (optional — newer firmware)')
    .meta({ secret: true }),
  pollIntervalMs: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(1000).max(3_600_000).default(60_000),
    )
    .describe('Live-data poll interval (ms)'),
  mappingIntervalMs: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(10_000).max(86_400_000).default(600_000),
    )
    .describe('Sensor-map refresh interval (ms)'),
  ...baseFields,
})

export const ecowittListenerConfigSchema = z.object({
  transport: z.literal('listener'),
  listenPort: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(1).max(65535).default(4199),
    )
    .describe('Local TCP port the gateway uploads to'),
  listenHost: z.string().default('').describe('Optional bind host (blank = all interfaces)'),
  ...baseFields,
})

export const ecowittConfigSchema = z.discriminatedUnion('transport', [
  ecowittLocalConfigSchema,
  ecowittListenerConfigSchema,
])

export type EcowittConfig = z.infer<typeof ecowittConfigSchema>
export type EcowittLocalConfig = z.infer<typeof ecowittLocalConfigSchema>
export type EcowittListenerConfig = z.infer<typeof ecowittListenerConfigSchema>

/**
 * Narrow an `unknown` value to a shallow-cloned plain object record, or an empty
 * record when it is not a plain object. Mirrors the Homematic `toRecord` helper —
 * a cast-free boundary narrowing.
 */
function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value))
  }
  return {}
}

/** Coerce a loose settings blob through the connection schema, applying defaults.
 *  A blob with no `transport` defaults to `local` for back-compat with simple forms. */
export function settingsToEcowittConfig(settings: unknown): EcowittConfig {
  const raw = toRecord(settings)
  if (raw['transport'] !== 'local' && raw['transport'] !== 'listener') {
    raw['transport'] = 'local'
  }
  return ecowittConfigSchema.parse(raw)
}

// ---------------------------------------------------------------------------
// Gateway Hub persisted config (standalone mode)
// ---------------------------------------------------------------------------

/**
 * Persisted config for an Ecowitt gateway {@link import('@camstack/types').DeviceType.Hub}
 * device. The operator-supplied CONNECTION lives directly on the device (Reolink
 * pattern) — there is no broker registry. The gateway owns its own live nodewitt
 * client keyed on its own `stableId`; group Container children reference it via
 * their `gatewayId` config field.
 */
export const ecowittGatewaySchema = z.object({
  /** The transport + endpoint the gateway's live client dials / binds. */
  connection: ecowittConfigSchema,
  /** Provenance marker used to scope offline / cascade helpers. */
  system: z.literal('ecowitt-gateway').optional(),
})

export type EcowittGatewayConfig = z.infer<typeof ecowittGatewaySchema>

/**
 * Hand-written connection form for the gateway device-creation UI (standalone
 * mode — Reolink pattern). The connection lives on the gateway DEVICE config,
 * not in a broker registry. A `name` field is included so the operator names
 * the gateway Hub at creation time (mirrors the Reolink creation form).
 */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'identity',
        title: 'Gateway',
        titleKey: 'provider-ecowitt:connection.s_identity.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'name',
            label: 'Name',
            labelKey: 'provider-ecowitt:connection.s_identity.name.label',
            required: true,
            placeholder: 'Weather station',
          },
        ],
      },
      {
        id: 'transport',
        title: 'Transport',
        titleKey: 'provider-ecowitt:connection.s_transport.title',
        description:
          'Local poll connects out to the gateway (recommended). Push listener needs the gateway "Customized" upload pointed at this hub.',
        descriptionKey: 'provider-ecowitt:connection.s_transport.description',
        columns: 1,
        fields: [
          {
            type: 'select',
            key: 'transport',
            label: 'Transport',
            labelKey: 'provider-ecowitt:connection.s_transport.transport.label',
            default: 'local',
            options: [
              {
                value: 'local',
                label: 'Local poll (recommended)',
                labelKey: 'provider-ecowitt:connection.s_transport.transport.o_local.label',
              },
              {
                value: 'listener',
                label: 'Push listener',
                labelKey: 'provider-ecowitt:connection.s_transport.transport.o_listener.label',
              },
            ],
          },
        ],
      },
      {
        id: 'local',
        title: 'Local poll settings',
        titleKey: 'provider-ecowitt:connection.s_local.title',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'host',
            label: 'Gateway host / IP',
            labelKey: 'provider-ecowitt:connection.s_local.host.label',
            placeholder: '192.168.10.50',
            showWhen: { field: 'transport', equals: 'local' },
          },
          {
            type: 'number',
            key: 'port',
            label: 'HTTP port',
            labelKey: 'provider-ecowitt:connection.s_local.port.label',
            min: 1,
            max: 65535,
            default: 80,
            showWhen: { field: 'transport', equals: 'local' },
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password (optional)',
            labelKey: 'provider-ecowitt:connection.s_local.password.label',
            showToggle: true,
            showWhen: { field: 'transport', equals: 'local' },
          },
          {
            type: 'number',
            key: 'pollIntervalMs',
            label: 'Poll interval (ms)',
            labelKey: 'provider-ecowitt:connection.s_local.pollIntervalMs.label',
            min: 1000,
            max: 3_600_000,
            default: 60_000,
            showWhen: { field: 'transport', equals: 'local' },
          },
        ],
      },
      {
        id: 'listener',
        title: 'Push listener settings',
        titleKey: 'provider-ecowitt:connection.s_listener.title',
        columns: 2,
        fields: [
          {
            type: 'number',
            key: 'listenPort',
            label: 'Listen port',
            labelKey: 'provider-ecowitt:connection.s_listener.listenPort.label',
            min: 1,
            max: 65535,
            default: 4199,
            showWhen: { field: 'transport', equals: 'listener' },
          },
          {
            type: 'text',
            key: 'listenHost',
            label: 'Bind host (optional)',
            labelKey: 'provider-ecowitt:connection.s_listener.listenHost.label',
            placeholder: 'all interfaces',
            showWhen: { field: 'transport', equals: 'listener' },
          },
        ],
      },
    ],
  }
}

/**
 * Slugify a host / station id into a readable, stable row-key fragment. Exported so the discovery
 * candidate's `stableId` matches exactly what `generateStableId` derives on adopt (else a re-scan of
 * an already-added gateway would not be detected as onboarded).
 */
export function slugifyHost(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
