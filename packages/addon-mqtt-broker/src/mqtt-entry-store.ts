import { type RecordKindHandle, type RecordsAccess } from '@camstack/types'
import {
  mqttAclEntryKind,
  MqttAclBodySchema,
  mqttClientEntryKind,
  MqttClientBodySchema,
  type MqttAclBody,
  type MqttClientBody,
} from './mqtt-entry-record-kinds.js'

export interface EmbeddedClientEntry {
  readonly username: string
  readonly passwordHash: string
}

export interface EmbeddedAclEntry {
  readonly username: string
  readonly topicPattern: string
  readonly access: MqttAclBody['access']
}

export function mqttAclRecordId(rule: Pick<EmbeddedAclEntry, 'username' | 'topicPattern'>): string {
  return `${rule.username}\u0000${rule.topicPattern}`
}

export class MqttClientStore {
  private readonly kind: RecordKindHandle<MqttClientBody>

  constructor(kind: RecordKindHandle<MqttClientBody>) {
    this.kind = kind
  }

  static of(records: Pick<RecordsAccess, 'kind'>): MqttClientStore {
    return new MqttClientStore(records.kind(mqttClientEntryKind))
  }

  async listResolved(): Promise<EmbeddedClientEntry[]> {
    const page = await this.kind.query({ limit: 1000 })
    const out: EmbeddedClientEntry[] = []
    for (const record of page.records) {
      const parsed = MqttClientBodySchema.safeParse(record.data)
      if (!parsed.success) continue
      out.push({ username: record.id, passwordHash: parsed.data.passwordHash })
    }
    return out
  }

  async replaceAll(entries: readonly EmbeddedClientEntry[]): Promise<void> {
    const page = await this.kind.query({ limit: 1000 })
    const nextIds = new Set(entries.map((e) => e.username))
    for (const row of page.records) {
      if (!nextIds.has(row.id)) await this.kind.delete(row.id)
    }
    for (const entry of entries) {
      const body = { name: entry.username, passwordHash: entry.passwordHash }
      const parsed = mqttClientEntryKind.schema.safeParse(body)
      if (!parsed.success) {
        throw new Error(`invalid MQTT client '${entry.username}': ${parsed.error.message}`)
      }
      await this.kind.put({ id: entry.username, data: parsed.data })
    }
  }
}

export class MqttAclStore {
  private readonly kind: RecordKindHandle<MqttAclBody>

  constructor(kind: RecordKindHandle<MqttAclBody>) {
    this.kind = kind
  }

  static of(records: Pick<RecordsAccess, 'kind'>): MqttAclStore {
    return new MqttAclStore(records.kind(mqttAclEntryKind))
  }

  async listResolved(): Promise<EmbeddedAclEntry[]> {
    const page = await this.kind.query({ limit: 1000 })
    const out: EmbeddedAclEntry[] = []
    for (const record of page.records) {
      const parsed = MqttAclBodySchema.safeParse(record.data)
      if (!parsed.success) continue
      out.push({
        username: parsed.data.username,
        topicPattern: parsed.data.topicPattern,
        access: parsed.data.access,
      })
    }
    return out
  }

  async replaceAll(entries: readonly EmbeddedAclEntry[]): Promise<void> {
    const page = await this.kind.query({ limit: 1000 })
    const nextIds = new Set(entries.map((e) => mqttAclRecordId(e)))
    for (const row of page.records) {
      if (!nextIds.has(row.id)) await this.kind.delete(row.id)
    }
    for (const entry of entries) {
      const body = {
        name: `${entry.username} · ${entry.topicPattern}`,
        username: entry.username,
        topicPattern: entry.topicPattern,
        access: entry.access,
      }
      const parsed = mqttAclEntryKind.schema.safeParse(body)
      if (!parsed.success) {
        throw new Error(
          `invalid MQTT ACL '${entry.username}/${entry.topicPattern}': ${parsed.error.message}`,
        )
      }
      await this.kind.put({ id: mqttAclRecordId(entry), data: parsed.data })
    }
  }
}
