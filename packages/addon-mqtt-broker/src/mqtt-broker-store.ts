import {
  type RecordKindHandle,
  type RecordsAccess,
  RecordSecretUnavailableError,
} from '@camstack/types'
import {
  MqttExternalBrokerEntrySchema,
  type MqttExternalBrokerEntry,
} from './mqtt-external-broker-entry.js'
import { mqttBrokersEntryKind, type MqttBrokerBody } from './broker-record-kinds.js'

function rowToEntry(id: string, data: MqttBrokerBody): MqttExternalBrokerEntry | null {
  const parsed = MqttExternalBrokerEntrySchema.safeParse({
    id,
    name: data.name,
    url: data.url,
    username: data.username,
    password: data.password,
    clientIdPrefix: data.clientIdPrefix,
    onboard: data.onboard,
  })
  return parsed.success ? parsed.data : null
}

export class MqttBrokerStore {
  private readonly kind: RecordKindHandle<MqttBrokerBody>

  constructor(kind: RecordKindHandle<MqttBrokerBody>) {
    this.kind = kind
  }

  static of(records: Pick<RecordsAccess, 'kind'>): MqttBrokerStore {
    return new MqttBrokerStore(records.kind(mqttBrokersEntryKind))
  }

  async listResolved(): Promise<MqttExternalBrokerEntry[]> {
    const page = await this.kind.query({ limit: 1000 })
    const out: MqttExternalBrokerEntry[] = []
    for (const record of page.records) {
      let data = record.data
      try {
        const resolved = await this.kind.getResolved(record.id)
        if (resolved !== null) data = resolved.data
      } catch (err: unknown) {
        if (!(err instanceof RecordSecretUnavailableError)) throw err
      }
      const entry = rowToEntry(record.id, data)
      if (entry !== null) out.push(entry)
    }
    return out
  }

  async replaceAll(entries: readonly MqttExternalBrokerEntry[]): Promise<void> {
    const page = await this.kind.query({ limit: 1000 })
    const nextIds = new Set(entries.map((e) => e.id))
    for (const row of page.records) {
      if (!nextIds.has(row.id)) await this.kind.delete(row.id)
    }
    for (const entry of entries) {
      const { id, name, url, username, password, clientIdPrefix, onboard } = entry
      const body = {
        name,
        url,
        ...(username === undefined ? {} : { username }),
        ...(password === undefined ? {} : { password }),
        ...(clientIdPrefix === undefined ? {} : { clientIdPrefix }),
        ...(onboard === undefined ? {} : { onboard }),
      }
      const parsed = mqttBrokersEntryKind.schema.safeParse(body)
      if (!parsed.success) throw new Error(`invalid MQTT broker '${id}': ${parsed.error.message}`)
      await this.kind.put({ id, data: parsed.data })
    }
  }
}
