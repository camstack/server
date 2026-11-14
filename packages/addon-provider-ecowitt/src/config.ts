import { z } from 'zod'
import { isSecretMarkerLike, type ConfigUISchema } from '@camstack/types'

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

/** A password the keychain could not serve reads as a marker object, not a string. */
function markerToEmpty(value: unknown): unknown {
  if (isSecretMarkerLike(value)) return ''
  return value === null || value === undefined ? '' : value
}

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
    .preprocess(markerToEmpty, z.string().default(''))
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
  /** Model the LAN scan announced. Not a form field; kept so the gateway is named from it. */
  model: z.string().optional(),
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
// Integration settings
// ---------------------------------------------------------------------------

/** The device-registry `system` tag every Ecowitt device carries. */
export const ECOWITT_SYSTEM = 'ecowitt'

/** A connection read from an integration's record, plus whether its password is stored but unreadable. */
export interface EcowittConnectionRead {
  readonly connection: EcowittConfig
  readonly passwordLocked: boolean
}

/**
 * Parse an integration's settings into a connection, or null while they are unusable (no host for
 * the local transport). `secretsLocked` reports a record whose secrets the keychain cannot serve
 * now: the caller must not dial with an empty password.
 */
export function connectionFromSettings(
  settings: unknown,
  secretsLocked: boolean,
): EcowittConnectionRead | null {
  const raw = toRecord(settings)
  try {
    return {
      connection: settingsToEcowittConfig(raw),
      passwordLocked: secretsLocked,
    }
  } catch {
    return null
  }
}

/** True when two connections would dial the gateway the same way. */
export function sameConnection(a: EcowittConfig, b: EcowittConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The key the live client, the group Containers and their sensors share (their `gatewayId`):
 * the integration's `originStableId` when it records one, else one derived
 * from the integration id. It never changes once children carry it.
 */
export function gatewayKeyOf(integration: {
  readonly id: string
  readonly originStableId?: string | undefined
}): string {
  const origin = integration.originStableId?.trim() ?? ''
  return origin.length > 0 ? origin : `ecowitt:${slugifyHost(integration.id)}`
}

/**
 * The integration instance form (the `formSchema` of its instances): the connection lives on the
 * INTEGRATION, which carries the name. The `password` field is what puts the value in the keychain.
 */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
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
