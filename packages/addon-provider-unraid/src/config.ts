import { z } from 'zod'
import type { ConfigUISchema } from '@camstack/types'

/** The device-registry `system` tag every Unraid device carries. */
export const UNRAID_SYSTEM = 'unraid'

/**
 * Operator-supplied connection to ONE Unraid server: the settings of the INTEGRATION
 * (`mode: account`, broker-less), not of a device. The Unraid GraphQL API exposes live
 * subscriptions, but this scaffold POLLS on a fixed cadence for a single, simple
 * aggregation path — `pollIntervalMs` drives the refresh. The `apiKey` is a keychain
 * secret, declared by type here and by the `password` field of the form.
 */
export const unraidConnectionSchema = z.object({
  host: z.string().min(1).describe('Unraid host name or IP address'),
  port: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(1).max(65535).default(443),
    )
    .describe('WebGUI port (80 plain, 443 https)'),
  https: z
    .preprocess((v) => (v === '' || v === null ? undefined : v), z.boolean().default(true))
    .describe('Use https/wss for the WebGUI'),
  allowSelfSigned: z
    .preprocess((v) => (v === '' || v === null ? undefined : v), z.boolean().default(false))
    .describe('Accept a self-signed certificate (https only)'),
  apiKey: z
    .string()
    .default('')
    .describe('ADMIN-role API key (`unraid-api apikey --create`)')
    .meta({ secret: true }),
  pollIntervalMs: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(2000).max(3_600_000).default(15_000),
    )
    .describe('Snapshot poll interval (ms)'),
})

export type UnraidConnectionConfig = z.infer<typeof unraidConnectionSchema>

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
export function settingsToConnection(settings: unknown): UnraidConnectionConfig {
  return unraidConnectionSchema.parse(toRecord(settings))
}

/** A connection plus whether its API key is stored but unreadable right now. */
export interface UnraidConnectionRead {
  readonly connection: UnraidConnectionConfig
  readonly apiKeyLocked: boolean
}

/**
 * Parse an integration's record body into a connection, or null while its host is missing.
 * `apiKeyLocked` says the keychain could not serve the key (the record read came back without it).
 */
export function connectionFromSettings(
  settings: unknown,
  apiKeyLocked: boolean,
): UnraidConnectionRead | null {
  const parsed = unraidConnectionSchema.safeParse(toRecord(settings))
  if (!parsed.success) return null
  return { connection: parsed.data, apiKeyLocked }
}

/** True when two connections would poll the server the same way. */
export function sameConnection(a: UnraidConnectionConfig, b: UnraidConnectionConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The integration's settings form (`globalSettingsSchema`); the integration carries the name. */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'connection',
        title: 'Connection',
        titleKey: 'provider-unraid:connection.s_connection.title',
        description: 'The API key must be ADMIN-role, created with `unraid-api apikey --create`.',
        descriptionKey: 'provider-unraid:connection.s_connection.description',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'host',
            label: 'Host / IP',
            labelKey: 'provider-unraid:connection.s_connection.host.label',
            required: true,
            placeholder: '192.168.10.10',
          },
          {
            type: 'number',
            key: 'port',
            label: 'Port',
            labelKey: 'provider-unraid:connection.s_connection.port.label',
            min: 1,
            max: 65535,
            default: 443,
          },
          {
            type: 'boolean',
            key: 'https',
            label: 'Use HTTPS',
            labelKey: 'provider-unraid:connection.s_connection.https.label',
            default: true,
          },
          {
            type: 'boolean',
            key: 'allowSelfSigned',
            label: 'Allow self-signed certificate',
            labelKey: 'provider-unraid:connection.s_connection.allowSelfSigned.label',
            default: false,
          },
          {
            type: 'password',
            key: 'apiKey',
            label: 'API key',
            labelKey: 'provider-unraid:connection.s_connection.apiKey.label',
            required: true,
            showToggle: true,
          },
          {
            type: 'number',
            key: 'pollIntervalMs',
            label: 'Poll interval (ms)',
            labelKey: 'provider-unraid:connection.s_connection.pollIntervalMs.label',
            min: 2000,
            max: 3_600_000,
            default: 15_000,
          },
        ],
      },
    ],
  }
}
