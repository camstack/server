import {
  defineAddonMigrations,
  type IntegrationRowsApi,
  makeInMemoryRecords,
  type MigrationOwnerResult,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  buildMqttHaInstances,
  MQTT_HA_LINK_REQUIRED_ID,
  MQTT_HA_MIGRATIONS,
  MQTT_HA_ROWS_TO_RECORD_ID,
  mqttHaBrokerIdOf,
  mqttHaConnectionsEntryKind,
  mqttHaRecordKinds,
  mqttHaRowsPorts,
} from '../mqtt-ha-instances.js'

const NEW_SPELLING = { id: 'int_0001', addonId: 'provider-mqtt-ha', name: 'Zigbee' }
const OLD_SPELLING = { id: 'int_0002', addonId: 'provider-mqtt-ha', name: 'Shelly' }

/** Both spellings of the link, plus a key nothing reads. */
const ROWS = new Map<string, Record<string, unknown>>([
  [NEW_SPELLING.id, { mqttBrokerId: 'int_0900', stale: 'x' }],
  [OLD_SPELLING.id, { brokerId: 'int_0901' }],
])

async function world() {
  const rows = new Map([...ROWS].map(([id, v]) => [id, { ...v }]))
  const warnings: string[] = []
  const mem = makeInMemoryRecords('provider-mqtt-ha')
  await mem.records.declare(mqttHaRecordKinds)
  const api: IntegrationRowsApi = {
    list: async () => [NEW_SPELLING, OLD_SPELLING],
    readLegacyIntegrationRows: async ({ integrationId: id }) => ({ ...rows.get(id) }),
    clearLegacyIntegrationRows: async ({ integrationId: id }) => {
      rows.set(id, {})
    },
  }
  const ports = mqttHaRowsPorts({ api, records: mem.records, warn: (m) => warnings.push(m) })
  const run = async (): Promise<readonly MigrationOwnerResult[]> =>
    Promise.all(defineAddonMigrations(MQTT_HA_MIGRATIONS, ports).map((m) => m.execute()))
  const instances = buildMqttHaInstances(mem.records, { onChanged: async () => undefined })
  return { rows, warnings, mem, run, instances }
}

describe('mqtt-ha integration rows move to a record', () => {
  it('the broker link lands as the broker id under both spellings; the rows are gone; a rerun is a no-op', async () => {
    const w = await world()
    expect(MQTT_HA_MIGRATIONS.map((m) => m.meta.id)).toEqual([
      MQTT_HA_ROWS_TO_RECORD_ID,
      MQTT_HA_LINK_REQUIRED_ID,
    ])
    await w.run()

    const handle = w.mem.records.kind(mqttHaRecordKinds.connections)
    expect((await handle.getResolved(NEW_SPELLING.id))?.data).toEqual({
      name: 'Zigbee',
      mqttBrokerId: 'int_0900',
    })
    expect((await handle.getResolved(OLD_SPELLING.id))?.data).toEqual({
      name: 'Shelly',
      mqttBrokerId: 'int_0901',
    })
    expect(w.rows.get(NEW_SPELLING.id)).toEqual({})
    expect(w.rows.get(OLD_SPELLING.id)).toEqual({})
    expect(w.warnings.join(' ')).toContain('stale')

    const again = await w.run()
    expect(JSON.stringify(again)).not.toContain('"done"')
  })

  it('the runtime reads the link from the record, never a copy of the broker', async () => {
    const w = await world()
    await w.run()
    expect(await mqttHaBrokerIdOf(w.instances, NEW_SPELLING.id)).toBe('int_0900')
    expect(await mqttHaBrokerIdOf(w.instances, OLD_SPELLING.id)).toBe('int_0901')
    expect(await mqttHaBrokerIdOf(w.instances, 'int_9999')).toBeUndefined()
  })
})

const UNLINKED = { id: 'int_0003', addonId: 'provider-mqtt-ha', name: 'Tasmota' }

describe('the broker link is a required instance link (D1013)', () => {
  it('describe() declares the link and the form draws an instance-select, no other picker', async () => {
    const w = await world()
    expect((await w.instances.describe()).links).toEqual([
      { kind: 'connections', field: 'mqttBrokerId', to: { cap: 'broker', kind: 'mqtt' } },
    ])
    const form = await w.instances.instanceFormSchema({ id: null })
    const fields = form.sections.flatMap((section) => section.fields)
    expect(fields.find((f) => f.key === 'mqttBrokerId')).toMatchObject({
      type: 'instance-select',
      functionCap: 'broker',
      kind: 'mqtt',
    })
  })

  it('backfills the key on a record that has none, keeps every other field, warns, never deletes', async () => {
    const w = await world()
    await w.run()
    const handle = w.mem.records.kind(mqttHaRecordKinds.connections)
    // A record written before the link was required: no `mqttBrokerId` key, plus a marked field.
    const legacy = w.mem.records.kind({
      name: mqttHaConnectionsEntryKind.name,
      declaration: mqttHaConnectionsEntryKind.declaration,
      schema: z.record(z.string(), z.unknown()),
    })
    await legacy.put(
      { id: UNLINKED.id, data: { name: 'Tasmota', marker: 'survives' } },
      { ifRev: 0 },
    )
    w.warnings.length = 0
    const ports = mqttHaRowsPorts({
      api: {
        list: async () => [NEW_SPELLING, OLD_SPELLING, UNLINKED],
        readLegacyIntegrationRows: async () => ({}),
        clearLegacyIntegrationRows: async () => undefined,
      },
      records: w.mem.records,
      warn: (m) => w.warnings.push(m),
    })
    const [, second] = defineAddonMigrations(MQTT_HA_MIGRATIONS, ports)
    const result = await second?.execute()
    expect(JSON.stringify(result)).toContain('"filled":1')
    expect((await handle.getResolved(UNLINKED.id))?.data).toMatchObject({
      name: 'Tasmota',
      mqttBrokerId: '',
      marker: 'survives',
    })
    expect(w.warnings.join(' ')).toContain('1 MQTT Discovery integration(s) link to no MQTT broker')
    expect((await handle.getResolved(NEW_SPELLING.id))?.data.mqttBrokerId).toBe('int_0900')
    expect((await w.instances.listInstances()).find((i) => i.id === UNLINKED.id)?.configured).toBe(
      false,
    )
    expect(await mqttHaBrokerIdOf(w.instances, UNLINKED.id)).toBeUndefined()
    const again = await second?.execute()
    expect(JSON.stringify(again)).not.toContain('"done"')
  })
})
