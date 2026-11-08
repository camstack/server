import { z } from 'zod'
import type { ConfigUISchema } from '@camstack/types'

/** The ESPHome native API port every board listens on unless its YAML says otherwise. */
export const ESPHOME_DEFAULT_PORT = 6053

/**
 * Connection to ONE board. ESPHome has no hub: every device serves its own
 * native API, so an integration holds a LIST of boards and keeps one session
 * per board (D952, extended by the multi-board integration).
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

/** One board a session runs for: a row of an integration's `boards` list. */
export const espBrokerEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  connection: espConnectionSchema,
  /** The integration whose `boards` list holds the row. */
  integrationId: z.string().optional(),
})

export type EspBrokerEntry = z.infer<typeof espBrokerEntrySchema>

/** The addon keeps no addon-level state: boards live in their integration's settings. */
export const espAddonConfigSchema = z.object({})

export type EspAddonConfig = z.infer<typeof espAddonConfigSchema>

/**
 * One row of the integration's `boards` list, as the form stores it. The two
 * secrets are keychain-stored by row id (`boards[id].encryptionKey`), never
 * inline: a read by the owning addon answers values, by the admin form a "set"
 * view.
 */
export const espBoardRowSchema = z.object({
  id: z.string().min(1),
  host: z.string().min(1),
  port: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.number().int().min(1).max(65535).default(ESPHOME_DEFAULT_PORT),
  ),
  name: z.string().default(''),
  encryptionKey: z.string().default('').meta({ secret: true }),
  password: z.string().default('').meta({ secret: true }),
})

export type EspBoardRow = z.infer<typeof espBoardRowSchema>

/**
 * The integration form. An ESPHome integration has nothing to configure on the
 * integration itself: boards are never entered here. They arrive through the
 * "Add device" dialog of the integration page, which offers the boards found on
 * the network (asking for the key of an encrypted one) and the manual form below.
 */
export function buildIntegrationFormSchema(): ConfigUISchema {
  return { sections: [] }
}

/** What the operator is told about the encryption key, on the form that asks for it. */
export const ESPHOME_KEY_HINT =
  'Needed only when the board is encrypted, that is when its YAML has api: encryption: key:. Copy the base64 value from there. Leave it empty for an unencrypted board; CamStack then tries to read the key from the ESPHome Builder in Home Assistant.'

/** The board a creation form describes. The key is a keychain secret once saved. */
export const espBoardCreationSchema = z.object({
  host: z.string().trim().min(1),
  port: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.number().int().min(1).max(65535).default(ESPHOME_DEFAULT_PORT),
  ),
  name: z.string().default(''),
  encryptionKey: z.string().default('').meta({ secret: true }),
  password: z.string().default('').meta({ secret: true }),
})

export type EspBoardCreation = z.infer<typeof espBoardCreationSchema>

/** The manual "Enter parameters" form, also the parameter step of a board found on the network. */
export function buildBoardCreationSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'board',
        title: 'Board',
        titleKey: 'provider-esphome:creation.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'host',
            label: 'Host / IP',
            labelKey: 'provider-esphome:creation.host.label',
            required: true,
            placeholder: 'living-room-relay.local',
          },
          {
            type: 'number',
            key: 'port',
            label: 'API port',
            labelKey: 'provider-esphome:creation.port.label',
            min: 1,
            max: 65535,
            default: ESPHOME_DEFAULT_PORT,
          },
          {
            type: 'text',
            key: 'name',
            label: 'Name',
            labelKey: 'provider-esphome:creation.name.label',
            placeholder: 'Living room relay',
          },
          {
            type: 'password',
            key: 'encryptionKey',
            label: 'Encryption key',
            labelKey: 'provider-esphome:creation.encryptionKey.label',
            description: ESPHOME_KEY_HINT,
            descriptionKey: 'provider-esphome:creation.encryptionKey.description',
            showToggle: true,
          },
          {
            type: 'password',
            key: 'password',
            label: 'Legacy API password',
            labelKey: 'provider-esphome:creation.password.label',
            description: 'Only for a board that predates encryption and has api: password:.',
            descriptionKey: 'provider-esphome:creation.password.description',
            showToggle: true,
          },
        ],
      },
    ],
  }
}

/** True when two connections would open the same session. */
export function sameConnection(a: Readonly<EspConnection>, b: Readonly<EspConnection>): boolean {
  return (
    a.host === b.host && a.port === b.port && a.noisePsk === b.noisePsk && a.password === b.password
  )
}

/** The session a stored row asks for. */
export function connectionOfRow(row: Readonly<EspBoardRow>): EspConnection {
  return {
    host: row.host,
    port: row.port,
    noisePsk: row.encryptionKey,
    password: row.password,
  }
}

/** The row an existing connection becomes (migration of a single-board record). */
export function rowOfEntry(entry: Readonly<EspBrokerEntry>): EspBoardRow {
  return {
    id: entry.id,
    host: entry.connection.host,
    port: entry.connection.port,
    name: entry.name,
    encryptionKey: entry.connection.noisePsk,
    password: entry.connection.password,
  }
}
