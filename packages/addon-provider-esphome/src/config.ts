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

/** The integration form: the boards of ONE integration. */
export function buildIntegrationFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'boards',
        title: 'Boards',
        titleKey: 'provider-esphome:connection.s_boards.title',
        description:
          'Every ESPHome board of this integration. The encryption key is the one in the board YAML under api: encryption: key:. Leave it empty for an unencrypted board.',
        descriptionKey: 'provider-esphome:connection.s_boards.description',
        columns: 1,
        fields: [
          {
            type: 'editable-array',
            key: 'boards',
            label: 'Boards',
            labelKey: 'provider-esphome:connection.s_boards.boards.label',
            itemIdKey: 'id',
            minRows: 1,
            addLabel: 'Add board',
            rowTitleTemplate: '{name} ({host})',
            defaultItem: { port: ESPHOME_DEFAULT_PORT },
            itemFields: [
              {
                type: 'text',
                key: 'host',
                label: 'Host / IP',
                labelKey: 'provider-esphome:connection.s_boards.host.label',
                required: true,
                placeholder: 'living-room-relay.local',
              },
              {
                type: 'number',
                key: 'port',
                label: 'API port',
                labelKey: 'provider-esphome:connection.s_boards.port.label',
                min: 1,
                max: 65535,
                default: ESPHOME_DEFAULT_PORT,
              },
              {
                type: 'text',
                key: 'name',
                label: 'Name',
                labelKey: 'provider-esphome:connection.s_boards.name.label',
                placeholder: 'Living room relay',
              },
              {
                type: 'password',
                key: 'encryptionKey',
                label: 'Encryption key',
                labelKey: 'provider-esphome:connection.s_boards.encryptionKey.label',
                showToggle: true,
              },
              {
                type: 'password',
                key: 'password',
                label: 'Legacy API password',
                labelKey: 'provider-esphome:connection.s_boards.password.label',
                showToggle: true,
              },
              {
                type: 'text',
                key: 'id',
                label: 'Board id',
                labelKey: 'provider-esphome:connection.s_boards.id.label',
                description: 'Leave empty: it is generated when the board is saved.',
                descriptionKey: 'provider-esphome:connection.s_boards.id.description',
              },
            ],
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
