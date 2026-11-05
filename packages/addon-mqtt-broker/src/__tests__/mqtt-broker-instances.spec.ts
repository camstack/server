import { BrokerInUseError, type InstanceChange, makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { mqttBrokersEntryKind } from '../broker-record-kinds.js'
import {
  buildMqttBrokerInstances,
  type MqttLiveState,
  type MqttProbeResult,
} from '../mqtt-broker-instances.js'
import {
  listMqttHaInstancesOver,
  MqttDiscoveryNotReadyError,
  type MqttHaListApi,
} from '../mqtt-broker-users.js'

type Listed = Awaited<ReturnType<MqttHaListApi['integrationInstances']['listInstances']['query']>>

interface WorldOptions {
  /** The addons the registry says provide `integration-instances`; null = the registry says nothing. */
  readonly providers?: readonly string[] | null
  readonly rows?: Listed
  readonly listFails?: boolean
  /** Whether the addon roster lists MQTT Discovery as installed. */
  readonly installed?: boolean
  readonly live?: Readonly<Record<string, MqttLiveState>>
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
    addons: {
      list: {
        query: async () =>
          options.installed === true ? [{ manifest: { id: 'provider-mqtt-ha' } }] : [],
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
    liveState: (id) => options.live?.[id] ?? { onboard: null },
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

  it('is refused, with a reason, while MQTT Discovery is installed but has not registered yet', async () => {
    const { provider, records } = await setup({ providers: ['mqtt-broker'], installed: true })
    await records.put({ id: 'B', data: { name: 'B', url: 'mqtt://x:1883' } }, { ifRev: 0 })
    const err = await provider.deleteInstance({ id: 'B' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MqttDiscoveryNotReadyError)
    expect(String(err)).toContain('not answering yet')
    expect(await records.get('B')).not.toBeNull()
  })

  it('is refused when the registry answers nothing at all', async () => {
    const { provider, records } = await setup({ providers: null })
    await records.put({ id: 'B', data: { name: 'B', url: 'mqtt://x:1883' } }, { ifRev: 0 })
    await expect(provider.deleteInstance({ id: 'B' })).rejects.toThrow('did not answer')
    expect(await records.get('B')).not.toBeNull()
  })

  it('is refused when the read fails, and the broker stays', async () => {
    const { provider, records } = await setup({ listFails: true })
    await records.put({ id: 'B', data: { name: 'B', url: 'mqtt://x:1883' } }, { ifRev: 0 })
    await expect(provider.deleteInstance({ id: 'B' })).rejects.toThrow('registry read failed')
    expect(await records.get('B')).not.toBeNull()
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

describe('the health of an MQTT broker instance', () => {
  const put = (records: Awaited<ReturnType<typeof setup>>['records'], id: string, data = {}) =>
    records.put({ id, data: { name: id, url: 'mqtt://x:1883', ...data } }, { ifRev: 0 })
  const statusOf = async (provider: Awaited<ReturnType<typeof setup>>['provider'], id: string) =>
    (await provider.listInstances()).find((i) => i.id === id)

  it('reports an unreachable broker as an error with the probe words, so it is not usable', async () => {
    const { provider, records } = await setup({
      live: {
        U: {
          onboard: null,
          probe: {
            status: 'unreachable',
            latencyMs: null,
            error: 'ECONNREFUSED',
            lastCheckedAt: 77,
          },
        },
      },
    })
    await put(records, 'U')
    const row = await statusOf(provider, 'U')
    expect(row?.status).toEqual({ state: 'error', label: 'Unreachable', detail: 'ECONNREFUSED' })
    expect(row?.lastCheckedAt).toBe(77)
  })

  it('reports connected with the latency, auth-failed and tls-error by name', async () => {
    const probe = (
      status: 'connected' | 'auth-failed' | 'tls-error',
      latencyMs: number | null,
    ) => ({
      onboard: null,
      probe: { status, latencyMs, lastCheckedAt: 5 },
    })
    const { provider, records } = await setup({
      live: {
        C: probe('connected', 12),
        A: probe('auth-failed', null),
        T: probe('tls-error', null),
      },
    })
    for (const id of ['C', 'A', 'T']) await put(records, id)
    expect((await statusOf(provider, 'C'))?.status).toEqual({
      state: 'ok',
      label: 'Connected',
      detail: '12 ms',
    })
    expect((await statusOf(provider, 'A'))?.status?.label).toBe('Authentication failed')
    expect((await statusOf(provider, 'T'))?.status?.label).toBe('TLS error')
  })

  it('says "not checked yet" before the first probe, an onboard server by its clients, a switched-off one as off', async () => {
    const { provider, records } = await setup({
      live: { O: { onboard: { connectedClients: 3 } } },
    })
    await put(records, 'N')
    await put(records, 'O', { onboard: { port: 1884, allowAnonymous: false } })
    await put(records, 'X', { enabled: false })
    expect((await statusOf(provider, 'N'))?.status).toEqual({
      state: 'unknown',
      label: 'Not checked yet',
    })
    expect((await statusOf(provider, 'O'))?.status).toEqual({
      state: 'ok',
      label: 'Listening',
      detail: '3 connected clients',
    })
    expect((await statusOf(provider, 'X'))?.status?.state).toBe('off')
  })
})
