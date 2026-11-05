/**
 * The legacy single embedded broker lived in FLAT addon-settings keys (`embeddedEnabled`,
 * `embeddedPort`, ...). It is an ONBOARD broker record now, so the instance list, the pickers,
 * the test and the delete all see it (D1013). Two migrations of the catalogue, in this order:
 *
 *  1. `embeddedToOnboardRecord` (procedure): a legacy broker (a stopped one as a switched-off
 *     record) becomes a `brokers` record
 *     under the SAME id (`embeddedId`, else the `'embedded'` id the old code derived), so a
 *     consumer that stored that id still resolves. It never overwrites a record of that id.
 *  2. `planDropEmbeddedKeys` (plan): the flat keys are deleted from the canonical
 *     `addon-settings` rows, and only while the record that replaces them exists and carries the
 *     password the legacy key held. `embeddedClients` / `embeddedAcl` are not flat broker keys
 *     and stay.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import { ADDON_SETTINGS_TABLE, MQTT_BROKER_ADDON_ID } from './brokers-to-records.js'
import type { MqttBrokerMigrationPorts } from './brokers-to-records.js'

/** The flat keys that described the legacy embedded broker. */
export const LEGACY_EMBEDDED_KEYS: readonly string[] = [
  'embeddedEnabled',
  'embeddedId',
  'embeddedPort',
  'embeddedAllowAnonymous',
  'embeddedUsername',
  'embeddedPassword',
]

/** The id the legacy code gave an embedded broker that never stored one. */
export const LEGACY_EMBEDDED_FALLBACK_ID = 'embedded'

export const LEGACY_EMBEDDED_NAME = 'Embedded broker'

/**
 * A legacy embedded broker, its password resolved. A STOPPED one (`enabled: false`) that was ever
 * configured is migrated too, as a switched-off record: its id, port and password are not lost.
 */
export interface LegacyEmbedded {
  readonly id: string
  readonly enabled: boolean
  readonly port: number
  readonly allowAnonymous: boolean
  readonly username?: string
  readonly password?: string
}

/** The onboard record the legacy broker becomes. */
export interface OnboardRecordBody {
  readonly name: string
  readonly url: string
  readonly username?: string
  readonly password?: string
  readonly onboard: { readonly port: number; readonly allowAnonymous: boolean }
  /** Present (false) only for a broker that was stopped. */
  readonly enabled?: false
}

export interface EmbeddedMigrationPorts extends MqttBrokerMigrationPorts {
  /**
   * The legacy embedded broker with its password resolved, enabled or stopped, or null when
   * nothing was ever configured (no keys, or only the form's untouched defaults). Throws when its
   * password cannot be read (a retired
   * `enc:v1` value with no key): the migration then fails and the keys stay.
   */
  readLegacyEmbedded(): Promise<LegacyEmbedded | null>
  /** The flat legacy keys as stored (markers unresolved), only those that exist. */
  readRawEmbeddedKeys(): Promise<Readonly<Record<string, unknown>>>
  /** Create the record `id`; it must not exist. */
  putOnboardRecord(id: string, body: OnboardRecordBody): Promise<void>
}

export function onboardBodyOf(legacy: LegacyEmbedded): OnboardRecordBody {
  return {
    name: LEGACY_EMBEDDED_NAME,
    url: `mqtt://127.0.0.1:${legacy.port}`,
    ...(legacy.username !== undefined ? { username: legacy.username } : {}),
    ...(legacy.password !== undefined ? { password: legacy.password } : {}),
    onboard: { port: legacy.port, allowAnonymous: legacy.allowAnonymous },
    ...(legacy.enabled ? {} : { enabled: false as const }),
  }
}

export async function embeddedToOnboardRecord(
  ports: EmbeddedMigrationPorts,
): Promise<MigrationProcedureResult> {
  const legacy = await ports.readLegacyEmbedded()
  if (legacy === null) return { outcome: 'already-done', summary: { migrated: 0 } }
  const records = await ports.readRecords()
  if (records.has(legacy.id)) return { outcome: 'already-done', summary: { migrated: 0 } }
  await ports.putOnboardRecord(legacy.id, onboardBodyOf(legacy))
  return { outcome: 'done', summary: { migrated: 1 } }
}

export async function planDropEmbeddedKeys(ports: EmbeddedMigrationPorts): Promise<MigrationPlan> {
  const raw = await ports.readRawEmbeddedKeys()
  const present = LEGACY_EMBEDDED_KEYS.filter((key) => key in raw)
  if (present.length === 0) return { edits: [] }
  const refuse = (reason: string): never => {
    ports.warn(`mqtt-broker migration: the legacy embedded keys are kept: ${reason}`)
    throw new Error(`the legacy embedded broker keys are not deleted: ${reason}`)
  }
  const legacy = await ports.readLegacyEmbedded()
  if (legacy !== null) {
    const record = (await ports.readRecords()).get(legacy.id)
    if (record === undefined) return refuse(`the record '${legacy.id}' does not exist`)
    if ((legacy.password ?? '').length > 0 && !record.hasPassword) {
      return refuse(`the record '${legacy.id}' holds no password`)
    }
  }
  const ids = present.map((key) => `${MQTT_BROKER_ADDON_ID}.${key}`)
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: ids,
        precondition: preconditionOf(
          Object.fromEntries(
            present.map((key) => [
              `${MQTT_BROKER_ADDON_ID}.${key}`,
              { addonId: MQTT_BROKER_ADDON_ID, key, value: raw[key] },
            ]),
          ),
        ),
      },
    ],
  }
}
