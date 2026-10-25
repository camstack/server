import { z } from 'zod'
import type { ConfigUISchema } from '@camstack/types'

/**
 * Operator-supplied connection to ONE Unraid server. The addon runs in
 * `standalone` mode (the Reolink / Ecowitt / Velux pattern): the CONNECTION
 * lives on the instance Hub DEVICE config, not a broker registry. The Unraid
 * GraphQL API exposes live subscriptions, but this scaffold POLLS on a fixed
 * cadence for a single, simple aggregation path — `pollIntervalMs` drives the
 * refresh.
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
 * Persisted config for an Unraid instance {@link import('@camstack/types').DeviceType.Hub}
 * device. The Hub owns exactly one live client keyed on its own `stableId`; its
 * adopted instance Container references it via `instanceId`.
 */
export const unraidHubSchema = z.object({
  connection: unraidConnectionSchema,
  /** Provenance marker used to scope offline / cascade helpers. */
  system: z.literal('unraid-hub').optional(),
})

export type UnraidHubConfig = z.infer<typeof unraidHubSchema>

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
 * Hand-written connection form for the instance device-creation UI (standalone
 * mode — Reolink / Velux pattern). The connection lives on the instance Hub
 * DEVICE config, not in a broker registry. A `name` field lets the operator name
 * the server at creation time.
 */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'identity',
        title: 'Unraid server',
        titleKey: 'provider-unraid:connection.s_identity.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'name',
            label: 'Name',
            labelKey: 'provider-unraid:connection.s_identity.name.label',
            required: true,
            placeholder: 'agent-a',
          },
        ],
      },
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
