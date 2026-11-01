import { UnraidApiError, UnraidAuthError, UnraidTransportError } from 'node-unraid'
import { buildEntityDescriptors } from '../unraid-mapping.js'
import { settingsToConnection } from '../config.js'
import { describe, expect, it, vi } from 'vitest'
import {
  createLiveUnraidClient,
  UnraidClientError,
  type UnraidApiSource,
} from '../unraid-client-live.js'

type ArrayGet = Awaited<ReturnType<UnraidApiSource['array']['get']>>
type Disk = ArrayGet['disks'][number]

function disk(over: Partial<Disk> & { id: string }): Disk {
  return {
    idx: 1,
    name: 'disk1',
    device: 'sdb',
    size: null,
    status: 'DISK_OK',
    rotational: true,
    temp: 30,
    numReads: null,
    numWrites: null,
    numErrors: null,
    fsSize: '1000',
    fsFree: '400',
    fsUsed: '600',
    exportable: null,
    type: 'DATA',
    warning: 45,
    critical: 55,
    fsType: null,
    comment: null,
    format: null,
    transport: null,
    color: null,
    isSpinning: true,
    ...over,
  }
}

async function* once<T>(...values: T[]): AsyncGenerator<T> {
  for (const v of values) yield v
}

function arrayInfo(): ArrayGet {
  return {
    id: 'array',
    state: 'STARTED',
    capacity: {
      kilobytes: { total: '1000', used: '600', free: '400' },
      disks: { total: '0', used: '0', free: '0' },
    },
    parityCheckStatus: {
      date: null,
      duration: null,
      speed: null,
      status: 'RUNNING',
      errors: null,
      progress: 42,
      correcting: false,
      paused: false,
      running: true,
    },
    boot: null,
    parities: [disk({ id: 'p', idx: 0, name: 'parity', type: 'PARITY' })],
    disks: [disk({ id: 'd1' }), disk({ id: 'd2', idx: 2, name: 'disk2', temp: 50 })],
    caches: [],
  }
}

function fakeApi(over: Partial<UnraidApiSource> = {}): UnraidApiSource {
  return {
    array: {
      get: async () => arrayInfo(),
      setState: vi.fn(async () => ({})),
      parity: { start: vi.fn(async () => ({})), cancel: vi.fn(async () => ({})) },
    },
    docker: {
      list: async () => [
        {
          id: 'c1',
          names: ['/plex'],
          state: 'RUNNING',
        },
        { id: 'c2', names: ['/sonarr'], state: 'EXITED' },
      ],
      start: vi.fn(async () => ({})),
      stop: vi.fn(async () => ({})),
      stats$: () =>
        once({ id: 'c1', cpuPercent: 12, memUsage: '1', memPercent: 7, netIO: '', blockIO: '' }),
    },
    system: {
      versions: async () => ({}),
      cpu$: () => once({ id: 'cpu', percentTotal: 33 }),
    },
    notifications: {
      warningsAndAlerts: async () => [
        {
          id: 'n1',
          title: 'old',
          subject: 's',
          description: 'd',
          importance: 'WARNING',
          link: null,
          type: 'UNREAD',
          timestamp: '2026-01-01T00:00:00Z',
          formattedTimestamp: null,
        },
        {
          id: 'n2',
          title: 'new',
          subject: 's2',
          description: 'd2',
          importance: 'ALERT',
          link: null,
          type: 'UNREAD',
          timestamp: '2026-02-01T00:00:00Z',
          formattedTimestamp: null,
        },
      ],
    },
    close: vi.fn(async () => undefined),
    ...over,
  }
}

describe('createLiveUnraidClient', () => {
  it('maps the array into the contract shape', async () => {
    const info = await createLiveUnraidClient(fakeApi()).array.get()
    expect(info.state).toBe('STARTED')
    expect(info.capacityKb).toEqual({ total: 1000, used: 600, free: 400 })
    expect(info.parityCheck).toEqual({ running: true, progress: 42 })
    expect(info.disks.map((d) => d.name)).toEqual(['parity', 'disk1', 'disk2'])
    expect(info.disks[1]).toMatchObject({ fsSizeBytes: 1024000, tempC: 30, healthy: true })
    expect(info.disks[2]?.healthy).toBe(false)
  })

  it('maps docker with stats, stripping the leading slash', async () => {
    const list = await createLiveUnraidClient(fakeApi()).docker.list()
    expect(list).toEqual([
      { id: 'c1', name: 'plex', running: true, cpuPercent: 12, memPercent: 7 },
      { id: 'c2', name: 'sonarr', running: false, cpuPercent: null, memPercent: null },
    ])
  })

  it('lists containers even when the stats subscription fails', async () => {
    const api = fakeApi()
    const client = createLiveUnraidClient({
      ...api,
      docker: {
        ...api.docker,
        stats$: () => {
          throw new Error('ws down')
        },
      },
    })
    expect(await client.docker.list()).toHaveLength(2)
  })

  it('maps cpu and notifications (latest by timestamp)', async () => {
    const client = createLiveUnraidClient(fakeApi())
    expect(await client.system.cpu()).toEqual({ percent: 33, tempC: null, powerW: null })
    const n = await client.notifications.active()
    expect(n.activeCount).toBe(2)
    expect(n.latest?.id).toBe('n2')
  })

  it('drives the actuators', async () => {
    const api = fakeApi()
    const client = createLiveUnraidClient(api)
    await client.array.setState('STOP')
    await client.array.parity.start(true)
    await client.docker.start('c1')
    await client.docker.stop('c1')
    expect(api.array.setState).toHaveBeenCalledWith({ desiredState: 'STOP' })
    expect(api.array.parity.start).toHaveBeenCalledWith(true)
    expect(api.docker.start).toHaveBeenCalledWith('c1')
    expect(api.docker.stop).toHaveBeenCalledWith('c1')
  })

  it.each([
    ['auth', new UnraidAuthError('bad key', { status: 401 })],
    ['api', new UnraidApiError('boom', { errors: [{ message: 'boom' }] })],
    ['transport', new UnraidTransportError('ECONNREFUSED')],
    ['unknown', new Error('x')],
  ])('turns a %s failure into a typed UnraidClientError', async (kind, err) => {
    const client = createLiveUnraidClient(
      fakeApi({
        system: {
          versions: async () => {
            throw err
          },
          cpu$: () => once({ id: 'cpu', percentTotal: 1 }),
        },
      }),
    )
    const failure = await client.connect().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(UnraidClientError)
    expect(failure).toMatchObject({ kind })
  })

  it('reports a failed cpu sample as null, never 0', async () => {
    const api = fakeApi()
    const client = createLiveUnraidClient({
      ...api,
      system: {
        ...api.system,
        cpu$: () => {
          throw new Error('ws down')
        },
      },
    })
    expect((await client.system.cpu()).percent).toBeNull()
  })

  it('publishes null readings as an unknown numeric value, not 0', async () => {
    const api = fakeApi()
    const client = createLiveUnraidClient({
      ...api,
      system: { ...api.system, cpu$: () => once() },
      docker: { ...api.docker, stats$: () => once() },
    })
    const array = await client.array.get()
    const descriptors = buildEntityDescriptors({
      array,
      cpu: await client.system.cpu(),
      disks: array.disks,
      dockers: await client.docker.list(),
      notifications: await client.notifications.active(),
    })
    const values = descriptors
      .filter((d) => d.key === 'cpu_usage' || d.key.endsWith('_cpu') || d.key.endsWith('_memory'))
      .map((d) => d.numeric?.value)
    expect(values.length).toBe(5)
    expect(values.every((v) => v === null)).toBe(true)
  })
})

describe('allowSelfSigned', () => {
  it('defaults to false and can be enabled', () => {
    expect(settingsToConnection({ host: 'h' }).allowSelfSigned).toBe(false)
    expect(settingsToConnection({ host: 'h', allowSelfSigned: true }).allowSelfSigned).toBe(true)
  })
})
