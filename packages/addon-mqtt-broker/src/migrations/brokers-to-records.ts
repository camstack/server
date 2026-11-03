/**
 * The external MQTT brokers live in the `brokers` records (D985, D996); the old addon-settings
 * key `brokers` was a mirror of them. Two migrations of the catalogue, in this order:
 *
 *  1. `verifyBrokersAreRecords` (procedure): every legacy entry id must already exist as a
 *     record, or the migration throws and names the ids. It writes and deletes nothing: a
 *     record is the broker's only live copy, and the addon no longer reads the key.
 *  2. `planDropBrokersKey` (plan): the legacy key is deleted from the canonical `addon-settings`
 *     rows. It refuses while any legacy password is still an `enc:v1` ciphertext (the operator's
 *     one-off keychain step reads that key), while a record is missing, and while a legacy
 *     password has no counterpart on its record.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import { retiredCiphertextPaths } from '../retired-ciphertext.js'

export const MQTT_BROKER_ADDON_ID = 'mqtt-broker'

/** The canonical `addon-settings` table: one row per key, id `<addonId>.<key>`. */
export const ADDON_SETTINGS_TABLE = 'addon-settings'

export const LEGACY_BROKERS_KEY = 'brokers'

/** What the migrations say about a decision they took; never carries a value. */
export interface MqttBrokerMigrationLog {
  warn(message: string): void
}

/** What a broker record holds, as far as the migrations care. */
export interface MqttBrokerRecordState {
  readonly hasPassword: boolean
}

export interface MqttBrokerMigrationPorts extends MqttBrokerMigrationLog {
  /** The `brokers` settings value as stored (markers unresolved); undefined when absent. */
  readRawBrokers(): Promise<unknown>
  /** The broker records by id. Throws when they cannot be read. */
  readRecords(): Promise<ReadonlyMap<string, MqttBrokerRecordState>>
}

interface LegacyBroker {
  readonly id: string
  /** The password as stored: a string (plain or `enc:v1`), a keychain marker, or nothing. */
  readonly password: unknown
}

function legacyBrokers(raw: unknown): readonly LegacyBroker[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item: unknown): LegacyBroker => {
    if (typeof item !== 'object' || item === null) return { id: '', password: undefined }
    const id = 'id' in item && typeof item.id === 'string' ? item.id : ''
    return { id, password: 'password' in item ? item.password : undefined }
  })
}

function carriesPassword(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0
  return typeof value === 'object' && value !== null
}

export async function verifyBrokersAreRecords(
  ports: MqttBrokerMigrationPorts,
): Promise<MigrationProcedureResult> {
  const legacy = legacyBrokers(await ports.readRawBrokers())
  if (legacy.length === 0) return { outcome: 'already-done', summary: { checked: 0 } }
  const records = await ports.readRecords()
  const missing = legacy.filter((b) => b.id.length === 0 || !records.has(b.id))
  if (missing.length > 0) {
    const names = missing.map((b) => (b.id.length === 0 ? '(no id)' : b.id)).join(', ')
    ports.warn(`mqtt-broker migration: legacy brokers without a record: ${names}`)
    throw new Error(`these legacy MQTT brokers have no record: ${names}`)
  }
  return { outcome: 'done', summary: { checked: legacy.length } }
}

export async function planDropBrokersKey(ports: MqttBrokerMigrationPorts): Promise<MigrationPlan> {
  const raw = await ports.readRawBrokers()
  if (raw === undefined) return { edits: [] }
  const legacy = legacyBrokers(raw)
  const retired = retiredCiphertextPaths({
    brokers: legacy.map((b) => ({
      id: b.id,
      ...(typeof b.password === 'string' ? { password: b.password } : {}),
    })),
    embeddedPassword: '',
  })
  const refuse = (reason: string): never => {
    ports.warn(`mqtt-broker migration: the legacy brokers key is kept: ${reason}`)
    throw new Error(`the legacy MQTT brokers key is not deleted: ${reason}`)
  }
  if (retired.length > 0) {
    return refuse(`${retired.join(', ')} still hold a retired enc:v1 password`)
  }
  if (legacy.length > 0) {
    const records = await ports.readRecords()
    for (const b of legacy) {
      const record = records.get(b.id)
      if (record === undefined) return refuse(`broker '${b.id}' has no record`)
      if (carriesPassword(b.password) && !record.hasPassword) {
        return refuse(`the record of broker '${b.id}' holds no password`)
      }
    }
  }
  const id = `${MQTT_BROKER_ADDON_ID}.${LEGACY_BROKERS_KEY}`
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: [id],
        // The row as the settings writer stores it: `{ addonId, key, value }`.
        precondition: preconditionOf({
          [id]: { addonId: MQTT_BROKER_ADDON_ID, key: LEGACY_BROKERS_KEY, value: raw },
        }),
      },
    ],
  }
}
