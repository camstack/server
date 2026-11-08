/**
 * The embedded broker's per-client credentials and ACL lived in two addon-settings lists
 * (`embeddedClients`, `embeddedAcl`), mirrored into the `mqtt-client` and `mqtt-acl-rule` record
 * kinds by a boot copy. The records are the instances now (D1013): the boot copy is gone and the
 * lists move once, as two migrations of the catalogue, in this order:
 *
 *  1. `clientsAclToRecords` (procedure): every legacy entry becomes a record under the id the
 *     stores always used (the username; `username NUL topicPattern`). A record that is already
 *     there is the live copy and is never overwritten.
 *  2. `planDropClientsAclKeys` (plan): the two keys are deleted from the canonical
 *     `addon-settings` rows, only while every legacy entry has its record.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import { z } from 'zod'
import { MQTT_BROKER_ADDON_ID, ADDON_SETTINGS_TABLE } from './brokers-to-records.js'
import type { EmbeddedMigrationPorts } from './embedded-to-onboard.js'

export const LEGACY_CLIENT_ACL_KEYS: readonly string[] = ['embeddedClients', 'embeddedAcl']

const LegacyClientSchema = z.object({
  username: z.string().min(1),
  passwordHash: z.string(),
})
const LegacyAclSchema = z.object({
  username: z.string().min(1),
  topicPattern: z.string().min(1),
  access: z.enum(['sub', 'pub', 'both']),
})

export type LegacyClient = z.infer<typeof LegacyClientSchema>
export type LegacyAcl = z.infer<typeof LegacyAclSchema>

/** The record id of an ACL rule: the same string the ACL store has always used. */
export function aclRecordId(rule: Pick<LegacyAcl, 'username' | 'topicPattern'>): string {
  return `${rule.username}\u0000${rule.topicPattern}`
}

export interface ClientAclMigrationPorts extends EmbeddedMigrationPorts {
  /** The two list values as stored; a key that is absent is absent from the result. */
  readRawClientsAcl(): Promise<Readonly<Record<string, unknown>>>
  /** The ids of the `mqtt-client` and `mqtt-acl-rule` records. Throws when they cannot be read. */
  readClientAclRecordIds(): Promise<{
    readonly clients: ReadonlySet<string>
    readonly acl: ReadonlySet<string>
  }>
  /** Create the record; it must not exist. */
  putClient(entry: LegacyClient): Promise<void>
  putAcl(entry: LegacyAcl): Promise<void>
}

function entriesOf<T>(raw: unknown, schema: z.ZodType<T>): readonly T[] {
  if (!Array.isArray(raw)) return []
  const out: T[] = []
  for (const item of raw) {
    const parsed = schema.safeParse(item)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

export async function clientsAclToRecords(
  ports: ClientAclMigrationPorts,
): Promise<MigrationProcedureResult> {
  const raw = await ports.readRawClientsAcl()
  const clients = entriesOf(raw['embeddedClients'], LegacyClientSchema)
  const acl = entriesOf(raw['embeddedAcl'], LegacyAclSchema)
  const have = await ports.readClientAclRecordIds()
  let migrated = 0
  for (const client of clients) {
    if (have.clients.has(client.username)) continue
    await ports.putClient(client)
    migrated += 1
  }
  for (const rule of acl) {
    if (have.acl.has(aclRecordId(rule))) continue
    await ports.putAcl(rule)
    migrated += 1
  }
  return migrated === 0
    ? { outcome: 'already-done', summary: { migrated: 0 } }
    : { outcome: 'done', summary: { migrated } }
}

export async function planDropClientsAclKeys(
  ports: ClientAclMigrationPorts,
): Promise<MigrationPlan> {
  const raw = await ports.readRawClientsAcl()
  const present = LEGACY_CLIENT_ACL_KEYS.filter((key) => key in raw)
  if (present.length === 0) return { edits: [] }
  const have = await ports.readClientAclRecordIds()
  const missing = [
    ...entriesOf(raw['embeddedClients'], LegacyClientSchema)
      .filter((c) => !have.clients.has(c.username))
      .map((c) => `client '${c.username}'`),
    ...entriesOf(raw['embeddedAcl'], LegacyAclSchema)
      .filter((r) => !have.acl.has(aclRecordId(r)))
      .map((r) => `acl '${r.username}' ${r.topicPattern}`),
  ]
  if (missing.length > 0) {
    const reason = `no record for ${missing.slice(0, 5).join(', ')}`
    ports.warn(`mqtt-broker migration: the legacy client and ACL lists are kept: ${reason}`)
    throw new Error(`the legacy client and ACL lists are not deleted: ${reason}`)
  }
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: present.map((key) => `${MQTT_BROKER_ADDON_ID}.${key}`),
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
