import { z } from 'zod'
import type { ConfigUISchema } from '@camstack/types'

/** The ESPHome native API port every board listens on unless its YAML says otherwise. */
export const ESPHOME_DEFAULT_PORT = 6053

/**
 * Operator-supplied connection to ONE board. A broker is a board: ESPHome has
 * no hub, every device serves its own API, so there is no "list of boards"
 * behind a single address (D952).
 *
 * `noisePsk` is the base64 key from the board's `api: encryption: key:`. It
 * is a keychain secret (`.meta({ secret: true })`) and never an env var or a
 * log field. `password` is the legacy API password, kept for boards that
 * predate Noise; a board configured with neither takes both empty.
 */
export const espConnectionSchema = z.object({
  host: z.string().min(1).describe('Board host name or IP address'),
  port: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(1).max(65535).default(ESPHOME_DEFAULT_PORT),
    )
    .describe('Native API port'),
  noisePsk: z
    .string()
    .default('')
    .describe('API encryption key (base64), empty when the board is unencrypted')
    .meta({ secret: true }),
  password: z
    .string()
    .default('')
    .describe('Legacy API password, empty when the board has none')
    .meta({ secret: true }),
})

export type EspConnection = z.infer<typeof espConnectionSchema>

/** One registered board: the broker record. */
export const espBrokerEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  connection: espConnectionSchema,
  /** FK to the spawning integration, for cleanup when it is deleted. */
  integrationId: z.string().optional(),
})

export type EspBrokerEntry = z.infer<typeof espBrokerEntrySchema>

/** Addon-level config. Brokers live in the records store; this stays a typed default. */
export const espAddonConfigSchema = z.object({
  brokers: z.array(espBrokerEntrySchema).default([]),
})

export type EspAddonConfig = z.infer<typeof espAddonConfigSchema>

/** Coerce a loose settings blob through the connection schema (defaults applied). */
export function settingsToConnection(settings: unknown): EspConnection {
  return espConnectionSchema.parse(settings ?? {})
}

/**
 * The settings blob the admin API may read back: the secrets are blanked, so
 * a read never carries a key. An empty secret in a write means "keep the
 * stored one" (see {@link mergeConnectionSecrets}).
 */
export function redactConnection(connection: Readonly<EspConnection>): Record<string, unknown> {
  return { ...connection, noisePsk: '', password: '' }
}

/**
 * A write that echoes the redacted round-trip value (empty) keeps the stored
 * secret instead of erasing it.
 */
export function mergeConnectionSecrets(
  incoming: Readonly<EspConnection>,
  stored: Readonly<EspConnection>,
): EspConnection {
  return {
    ...incoming,
    noisePsk: incoming.noisePsk.length > 0 ? incoming.noisePsk : stored.noisePsk,
    password: incoming.password.length > 0 ? incoming.password : stored.password,
  }
}

/** True when two connections would open the same session. */
export function sameConnection(a: Readonly<EspConnection>, b: Readonly<EspConnection>): boolean {
  return (
    a.host === b.host && a.port === b.port && a.noisePsk === b.noisePsk && a.password === b.password
  )
}

/** Form the broker dialog renders for an ESPHome board. */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'connection',
        title: 'Board',
        titleKey: 'provider-esphome:connection.s_connection.title',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'host',
            label: 'Host / IP',
            labelKey: 'provider-esphome:connection.s_connection.host.label',
            required: true,
            placeholder: 'living-room-relay.local',
          },
          {
            type: 'number',
            key: 'port',
            label: 'API port',
            labelKey: 'provider-esphome:connection.s_connection.port.label',
            min: 1,
            max: 65535,
            default: ESPHOME_DEFAULT_PORT,
          },
        ],
      },
      {
        id: 'security',
        title: 'API security',
        titleKey: 'provider-esphome:connection.s_security.title',
        description:
          'The encryption key is the one in the board YAML under api: encryption: key:. Leave both empty for an unencrypted board.',
        descriptionKey: 'provider-esphome:connection.s_security.description',
        columns: 1,
        fields: [
          {
            type: 'password',
            key: 'noisePsk',
            label: 'Encryption key',
            labelKey: 'provider-esphome:connection.s_security.noisePsk.label',
            showToggle: true,
          },
          {
            type: 'password',
            key: 'password',
            label: 'Legacy API password',
            labelKey: 'provider-esphome:connection.s_security.password.label',
            showToggle: true,
          },
        ],
      },
    ],
  }
}
