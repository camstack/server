import { BrokerInUseError, type InstanceChange, makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { mqttBrokersEntryKind } from '../broker-record-kinds.js'
import { buildMqttBrokerInstances, type MqttProbeResult } from '../mqtt-broker-instances.js'
import { listMqttHaInstancesOver, type MqttHaListApi } from '../mqtt-broker-users.js'

type Listed = Awaited<ReturnType<MqttHaListApi['integrationInstances']['listInstances']['query']>>

interface WorldOptions {
  /** The addons the registry says provide `integration-instances`; null = the registry says nothing. */
  readonly providers?: readonly string[] | null
  readonly rows?: Listed
  readonly listFails?: boolean
  readonly listening?: ReadonlySet<string>
}

async function setup(options: WorldOptions = {}) {
  const world = makeInMemoryRecords('mqtt-broker')
  await world.records.declare({ brokers: mqttBrokersEntryKind })
  const changes: Array<readonly [string, InstanceChange]> = []
  const probed: Array<{ url: string; username?: string; password?: string }> = []
  let nextPort = 41_883
  const api: MqttHaListApi = {
    capabilities: {
      getCapability: {
        query: async () =>
          options.providers === null
            ? null
            : { providers: options.providers ?? ['provider-mqtt-ha', 'mqtt-broker'] },
      },
    },
    integrationInstances: {
      listInstances: {
        query: async () => {
          if (options.listFails === true) throw new Error('registry read failed')
          return options.rows ?? []
        },
      },
    },
  }
  const provider = buildMqttBrokerInstances(world.records, {
    formSchema: () => ({ sections: [] }),
    listMqttHaInstances: () => listMqttHaInstancesOver(api),
    freePort: async () => nextPort++,
    probe: async (cfg): Promise<MqttProbeResult> => {
      probed.push(cfg)
      return { ok: true, latencyMs: 4 }
    },
    onboardListening: (id) => options.listening?.has(id) === true,
    onChanged: async (id, change) => {
      changes.push([id, change])
    },
  })
  const records = world.records.kind(mqttBrokersEntryKind)
  return { provider, changes, probed, records }
}

describe('creating an onboard MQTT broker', () => {
  it('allocates a port, records the onboard descriptor and tells the addon to spawn it', async () => {
    const { provider, changes, records } = await setup()
    const { id } = await provider.createInstance({
      name: 'Local',
      values: { onboard: true, allowAnonymous: true, username: 'cam', password: 'pw' },
    })
    const row = await records.get(id)
    expect(row?.data).toMatchObject({
      url: 'mqtt://127.0.0.1:41883',
      onboard: { port: 41_883, allowAnonymous: true },
      username: 'cam',
    })
    expect(changes).toEqual([[id, 'created']])
  })

  it('honours the port the operator typed', async () => {
    const { provider, records } = await setup()
    const { id } = await provider.createInstance({
      name: 'Local',
      values: { onboard: true, port: 1884 },
    })
    expect((await records.get(id))?.data).toMatchObject({
      url: 'mqtt://127.0.0.1:1884',
      onboard: { port: 1884, allowAnonymous: false },
    })
  })

  it('turns an empty broker into an onboard one when the editor sends the form after the create', async () => {
    const { provider, changes, records } = await setup()
    const { id } = await provider.createInstance({ id: 'E1', name: 'Local' })
    await provider.updateInstance({ id, values: { onboard: true, allowAnonymous: true } })
    expect((await records.get(id))?.data).toMatchObject({
      url: 'mqtt://127.0.0.1:41883',
      onboard: { port: 41_883, allowAnonymous: true },
    })
    expect(changes.at(-1)).toEqual([id, 'updated'])
  })

  it('an external broker keeps its URL and stores no onboard descriptor', async () => {
    const { provider, records } = await setup()
    const { id } = await provider.createInstance({
      id: 'X1',
      name: 'Ext',
      values: { onboard: false, url: 'mqtt://10.0.0.5:1883', port: 9 },
    })
    const data = (await records.get(id))?.data
    expect(data).toMatchObject({ url: 'mqtt://10.0.0.5:1883' })
    expect(data?.onboard).toBeUndefined()
  })

  it('deleting it tells the addon, which tears the server down', async () => {
    const { provider, changes, records } = await setup()
    const { id } = await provider.createInstance({ name: 'Local', values: { onboard: true } })
    await provider.deleteInstance({ id })
    expect(await records.get(id)).toBeNull()
    expect(changes.at(-1)).toEqual([id, 'deleted'])
  })
})

describe('deleting an MQTT broker (production wiring)', () => {
  const named = [{ id: 'int_1', name: 'Discovery', formValues: { mqttBrokerId: 'B' } }]

  it('is refused while an MQTT Discovery integration names it', async () => {
    const { provider, records } = await setup({ rows: named })
    await records.put({ id: 'B', data: { name: 'B', url: 'mqtt://x:1883' } }, { ifRev: 0 })
    await expect(provider.deleteInstance({ id: 'B' })).rejects.toBeInstanceOf(BrokerInUseError)
    expect(await records.get('B')).not.toBeNull()
  })

  it('goes through when MQTT Discovery is not a provider at all', async () => {
    const { provider, records } = await setup({ providers: ['mqtt-broker'], listFails: true })
    await records.put({ id: 'B', data: { name: 'B', url: 'mqtt://x:1883' } }, { ifRev: 0 })
    await provider.deleteInstance({ id: 'B' })
    expect(await records.get('B')).toBeNull()
  })

  it('is refused when the read fails, and the broker stays', async () => {
    const { provider, records } = await setup({ listFails: true })
    await records.put({ id: 'B', data: { name: 'B', url: 'mqtt://x:1883' } }, { ifRev: 0 })
    await expect(provider.deleteInstance({ id: 'B' })).rejects.toThrow('registry read failed')
    expect(await records.get('B')).not.toBeNull()
  })

  it('is refused when the registry does not answer and the read fails', async () => {
    const { provider, records } = await setup({ providers: null, listFails: true })
    await records.put({ id: 'B', data: { name: 'B', url: 'mqtt://x:1883' } }, { ifRev: 0 })
    await expect(provider.deleteInstance({ id: 'B' })).rejects.toThrow('registry read failed')
  })
})

describe('testing an MQTT broker', () => {
  it('before it is saved probes the typed URL', async () => {
    const { provider, probed } = await setup()
    const result = await provider.testInstance?.({
      id: null,
      values: { url: 'mqtt://10.0.0.5:1883', username: 'u', password: 'p' },
    })
    expect(result).toMatchObject({ success: true, status: 'validated' })
    expect(probed).toEqual([{ url: 'mqtt://10.0.0.5:1883', username: 'u', password: 'p' }])
  })

  it('a saved external broker is probed with its stored password when the form left it blank', async () => {
    const { provider, probed, records } = await setup()
    await records.put(
      { id: 'B', data: { name: 'B', url: 'mqtt://x:1883', username: 'u', password: 'stored' } },
      { ifRev: 0 },
    )
    await provider.testInstance?.({ id: 'B', values: { password: '' } })
    expect(probed[0]).toMatchObject({ url: 'mqtt://x:1883', username: 'u', password: 'stored' })
  })

  it('a saved onboard broker reports whether it is listening', async () => {
    const { provider } = await setup({ listening: new Set(['L']) })
    const up = await provider.createInstance({ id: 'L', name: 'L', values: { onboard: true } })
    const down = await provider.createInstance({ id: 'D', name: 'D', values: { onboard: true } })
    expect(await provider.testInstance?.({ id: up.id, values: {} })).toMatchObject({
      success: true,
    })
    expect(await provider.testInstance?.({ id: down.id, values: {} })).toMatchObject({
      success: false,
      status: 'rejected',
    })
  })
})
