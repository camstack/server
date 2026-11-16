/**
 * The local account (planning#583): a username + password reaches the classic Network API
 * through aiounifi in `python/unifi_worker.py`. These specs stand a fake worker behind the real
 * line channel (`startUnifiWorkerChannel` over a fake spawner) and pin what the TypeScript side
 * owns: the password reaches the worker only as a file path; PoE on/off names ONE port and leaves
 * the override list to the worker (which reads it fresh — `test_unifi_session.py`); a websocket
 * push updates a port's link without a poll; a refusal keeps its reason through the connection
 * test; with an API key too, the account lays its ports over the key's devices by MAC.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { settingsToConnection } from '../config.js'
import { UnifiAiounifiClient } from '../unifi-client-aiounifi.js'
import { UnifiDualClient } from '../unifi-client-dual.js'
import { makeUnifiClientFactory, unifiCredentialOf } from '../unifi-client-factory.js'
import { type UnifiFetch, UnifiLiveClient } from '../unifi-client-live.js'
import { testUnifiConnection } from '../unifi-connection-test.js'
import { UnifiAuthError } from '../unifi-errors.js'
import { UnifiIntegrationManager } from '../unifi-integration-manager.js'
import {
  startUnifiWorkerChannel,
  type UnifiWorkerChannel,
  type UnifiWorkerChild,
} from '../unifi-worker-channel.js'
import type { UnifiSecretFiles } from '../unifi-worker-files.js'
import type { UnifiWorkerDevice, UnifiWorkerPush } from '../unifi-worker-protocol.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

const PASSWORD = 'marker-secret'
const PASSWORD_FILE = '/owner-only/password'

type Failure = 'auth' | 'mfa' | 'unreachable'

interface FakeWorkerOptions {
  readonly failConnect?: Failure
}

interface FakeWorker {
  readonly openWorker: () => Promise<UnifiWorkerChannel>
  /** Every request line the worker received, parsed. */
  readonly seen: Record<string, unknown>[]
  /** Write a push line, as the websocket would. */
  push(line: UnifiWorkerPush): void
}

function switchDevice(port3LinkUp: boolean): UnifiWorkerDevice {
  const port = (idx: number, linkUp: boolean | null): UnifiWorkerDevice['ports'][number] => ({
    idx,
    poeCapable: true,
    poeOn: true,
    poeMode: 'auto',
    linkUp,
    speedMbps: linkUp === true ? 1000 : null,
    poePowerW: 3.2,
    poeVoltageV: 52,
    poeCurrentA: 0.06,
    clientMac: idx === 1 ? 'aa:bb:cc:dd:ee:01' : null,
    clientName: idx === 1 ? 'marker-camera' : null,
  })
  return {
    id: 'dev1',
    mac: 'aa:bb:cc:00:00:01',
    name: 'Office switch',
    model: 'USL8LP',
    type: 'usw',
    state: 1,
    uptimeSec: 100,
    cpuPercent: 5,
    cpuTempC: 40,
    clients: 1,
    ledOverride: 'default',
    ports: [port(1, true), port(3, port3LinkUp)],
  }
}

const FAILURES: Record<Failure, Record<string, unknown>> = {
  auth: {
    kind: 'auth',
    error: 'unifi: the controller refused the local account (HTTP 401)',
  },
  mfa: { kind: 'mfa', error: 'two-factor' },
  unreachable: {
    kind: 'unreachable',
    error: 'Cannot connect to host console.example:443',
  },
}

/** A fake `unifi_worker.py`: answers each stdin line on stdout, like the real one. */
function fakeWorker(options: FakeWorkerOptions = {}): FakeWorker {
  const seen: Record<string, unknown>[] = []
  let emit: (line: string) => void = () => undefined
  const answer = (request: Record<string, unknown>): Record<string, unknown> => {
    const id = request['id']
    switch (request['op']) {
      case 'connect':
        if (options.failConnect !== undefined) {
          return { id, ok: false, ...FAILURES[options.failConnect] }
        }
        return { id, ok: true, result: { site: 'default' } }
      case 'list':
        return {
          id,
          ok: true,
          result: {
            devices: [switchDevice(true)],
            clients: [
              {
                mac: 'aa:bb:cc:dd:ee:01',
                hostname: 'marker-camera',
                ip: '10.0.0.5',
              },
            ],
          },
        }
      default:
        return { id, ok: true, result: null }
    }
  }
  const child: UnifiWorkerChild = {
    stdin: {
      write(chunk) {
        for (const line of chunk.split('\n')) {
          if (line.trim() === '') continue
          const parsed: Record<string, unknown> = JSON.parse(line)
          seen.push(parsed)
          queueMicrotask(() => emit(JSON.stringify(answer(parsed)) + '\n'))
        }
      },
    },
    stdout: {
      on(_event, listener) {
        emit = (line) => listener(Buffer.from(line))
      },
    },
    stderr: { on: () => undefined },
    on: () => undefined,
    kill: () => undefined,
  }
  return {
    seen,
    openWorker: async () =>
      startUnifiWorkerChannel({
        pythonPath: 'python3',
        scriptPath: 'unifi_worker.py',
        logger: quiet,
        spawnChild: () => child,
      }),
    push: (line) => emit(JSON.stringify(line) + '\n'),
  }
}

/** Records the secret it was handed and gives the body a fixed path. */
function recordingSecretFiles(written: string[]): UnifiSecretFiles {
  return async (secret, body) => {
    written.push(secret)
    return body(PASSWORD_FILE)
  }
}

function accountClient(worker: FakeWorker, written: string[] = []): UnifiAiounifiClient {
  return new UnifiAiounifiClient({
    host: 'console.example',
    port: 443,
    username: 'camstack',
    password: PASSWORD,
    site: 'default',
    allowSelfSigned: false,
    openChannel: worker.openWorker,
    secretFiles: recordingSecretFiles(written),
  })
}

describe('a local account through the aiounifi worker', () => {
  it('the password reaches the worker only as an owner-only file path', async () => {
    const worker = fakeWorker()
    const written: string[] = []
    await accountClient(worker, written).connect()
    expect(written).toEqual([PASSWORD])
    const connect = worker.seen.find((r) => r['op'] === 'connect')
    expect(connect).toMatchObject({
      passwordFile: PASSWORD_FILE,
      username: 'camstack',
    })
    expect(JSON.stringify(worker.seen)).not.toContain(PASSWORD)
  })

  it('reads ports with PoE power, link, speed and the wired client', async () => {
    const client = accountClient(fakeWorker())
    await client.connect()
    const [sw] = await client.listInfraDevices()
    expect(sw).toMatchObject({
      id: 'dev1',
      kind: 'switch',
      online: true,
      poeSwitchable: true,
    })
    expect(sw?.ports[0]).toMatchObject({
      idx: 1,
      linkUp: true,
      speedMbps: 1000,
      poePowerW: 3.2,
      clientName: 'marker-camera',
    })
  })

  it('PoE on/off names ONE port: the worker keeps every other override (read fresh)', async () => {
    const worker = fakeWorker()
    const client = accountClient(worker)
    await client.connect()
    await client.setPortPoe('dev1', 3, false)
    const writes = worker.seen.filter((r) => r['op'] === 'set_poe')
    // No override list is built here from a stale poll: the worker reads the device and merges.
    expect(writes).toEqual([
      {
        id: expect.any(String),
        op: 'set_poe',
        deviceId: 'dev1',
        portIdx: 3,
        on: false,
      },
    ])
  })

  it('a websocket push updates the port link without a poll', async () => {
    const worker = fakeWorker()
    const polled: string[] = []
    const manager = new UnifiIntegrationManager({
      id: 'u1',
      name: 'UniFi',
      connection: settingsToConnection({
        host: 'console.example',
        username: 'camstack',
        password: PASSWORD,
      }),
      logger: quiet,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: (id) => polled.push(id),
      makeClient: () => accountClient(worker),
    })
    await manager.start()
    expect(manager.getInfra('dev1')?.ports[1]?.linkUp).toBe(true)
    const listsBefore = worker.seen.filter((r) => r['op'] === 'list').length
    const pollsBefore = polled.length

    worker.push({
      push: 'snapshot',
      devices: [switchDevice(false)],
      clients: [],
    })

    expect(manager.getInfra('dev1')?.ports[1]?.linkUp).toBe(false)
    expect(polled.length).toBe(pollsBefore + 1)
    expect(worker.seen.filter((r) => r['op'] === 'list').length).toBe(listsBefore)
    await manager.stop()
  })

  it('an event stream that is up slows the poll to a reconcile', async () => {
    const worker = fakeWorker()
    const manager = new UnifiIntegrationManager({
      id: 'u1',
      name: 'UniFi',
      connection: settingsToConnection({
        host: 'console.example',
        username: 'camstack',
        password: PASSWORD,
      }),
      logger: quiet,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: () => undefined,
      makeClient: () => accountClient(worker),
    })
    await manager.start()
    const configured = manager.pollDelayMs()
    worker.push({ push: 'channel', state: 'up' })
    expect(manager.pollDelayMs()).toBeGreaterThan(configured)
    worker.push({ push: 'channel', state: 'down', reason: 'closed' })
    expect(manager.pollDelayMs()).toBe(configured)
    await manager.stop()
  })
})

const INTEGRATION_ROUTES: Record<string, unknown> = {
  '/sites': {
    data: [{ id: 's1', name: 'Default', internalReference: 'default' }],
  },
  '/sites/s1/devices': {
    data: [
      {
        id: 'int-1',
        name: 'Office switch',
        model: 'USW-Lite-8-PoE',
        macAddress: 'AA:BB:CC:00:00:01',
        state: 'ONLINE',
        features: ['switching'],
      },
    ],
  },
  '/sites/s1/devices/int-1': {
    interfaces: {
      ports: [
        { idx: 1, poe: { state: 'UP' } },
        { idx: 3, poe: { state: 'UP' } },
      ],
    },
  },
  '/sites/s1/devices/int-1/statistics/latest': {
    uptimeSec: 100,
    cpuUtilizationPct: 5,
  },
  '/sites/s1/clients': { data: [] },
}

const integrationFetch: UnifiFetch = async (url) => {
  const path = url.split('/integration/v1')[1]?.split('?')[0] ?? ''
  const body = INTEGRATION_ROUTES[path]
  if (body === undefined) return { ok: false, status: 404, json: async () => ({}) }
  return { ok: true, status: 200, json: async () => body }
}

function dual(worker: FakeWorker): UnifiDualClient {
  return new UnifiDualClient({
    integration: new UnifiLiveClient({
      host: 'console.example',
      port: 443,
      apiKey: 'k',
      site: 'default',
      fetchImpl: integrationFetch,
    }),
    classic: accountClient(worker),
  })
}

describe('an API key AND a local account', () => {
  it('the key lists; the local account lays its ports over the same device (by MAC)', async () => {
    const client = dual(fakeWorker())
    await client.connect()
    const [sw] = await client.listInfraDevices()
    expect(sw).toMatchObject({ id: 'int-1', poeSwitchable: true })
    expect(sw?.ports[0]).toMatchObject({
      idx: 1,
      poePowerW: 3.2,
      clientName: 'marker-camera',
    })
    expect(client.degradedError()).toBeNull()
  })

  it('switches PoE through the local account, on the classic id of the same device', async () => {
    const worker = fakeWorker()
    const client = dual(worker)
    await client.connect()
    await client.listInfraDevices()
    await client.setPortPoe('int-1', 3, false)
    expect(worker.seen.find((r) => r['op'] === 'set_poe')).toMatchObject({
      deviceId: 'dev1',
      portIdx: 3,
      on: false,
    })
  })

  it('a refused local password degrades, the key still lists, and the poll never signs in again', async () => {
    const worker = fakeWorker({ failConnect: 'auth' })
    const client = dual(worker)
    await client.connect()
    expect(await client.listInfraDevices()).toHaveLength(1)
    expect(await client.listInfraDevices()).toHaveLength(1)
    expect(client.degradedError()).toBeInstanceOf(UnifiAuthError)
    expect(worker.seen.filter((r) => r['op'] === 'connect')).toHaveLength(1)
  })
})

describe('which credential signs in', () => {
  const base = {
    host: 'h',
    port: 443,
    site: 'default',
    allowSelfSigned: false,
  }
  const factory = makeUnifiClientFactory({
    fetchFor: () => integrationFetch,
    openWorker: fakeWorker().openWorker,
    secretFiles: recordingSecretFiles([]),
  })

  it.each<[string, string, string, string | null, unknown]>([
    ['k', '', '', 'api-key', UnifiLiveClient],
    ['', 'u', 'p', 'local-account', UnifiAiounifiClient],
    ['k', 'u', 'p', 'both', UnifiDualClient],
  ])('apiKey=%s user=%s → %s', (apiKey, username, password, kind, ctor) => {
    expect(unifiCredentialOf({ apiKey, username, password })).toBe(kind)
    expect(factory({ ...base, apiKey, username, password })).toBeInstanceOf(ctor)
  })

  it('an API key alone cannot switch PoE (no switch is offered)', async () => {
    const client = factory({
      ...base,
      apiKey: 'k',
      username: '',
      password: '',
    })
    await client.connect()
    const [sw] = await client.listInfraDevices()
    expect(sw?.poeSwitchable).toBe(false)
  })
})

describe('the connection test with a local account', () => {
  function factoryOver(options: FakeWorkerOptions) {
    return makeUnifiClientFactory({
      fetchFor: () => integrationFetch,
      openWorker: fakeWorker(options).openWorker,
      secretFiles: recordingSecretFiles([]),
    })
  }
  const account = {
    host: 'console.example',
    username: 'camstack',
    password: PASSWORD,
  }

  it('validates a local account that signs in', async () => {
    const result = await testUnifiConnection(settingsToConnection(account), factoryOver({}))
    expect(result).toMatchObject({ success: true })
  })

  it('a wrong password is rejected with the reason', async () => {
    const result = await testUnifiConnection(
      settingsToConnection(account),
      factoryOver({ failConnect: 'auth' }),
    )
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(result.error).toMatch(/refused/i)
  })

  it('a two-factor (cloud) account is rejected with a readable reason', async () => {
    const result = await testUnifiConnection(
      settingsToConnection(account),
      factoryOver({ failConnect: 'mfa' }),
    )
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(result.error).toMatch(/local account/i)
  })

  it('an unreachable console is inconclusive', async () => {
    const result = await testUnifiConnection(
      settingsToConnection(account),
      factoryOver({ failConnect: 'unreachable' }),
    )
    expect(result).toMatchObject({ success: false, status: 'inconclusive' })
  })

  it('with an API key, a refused local account still fails the test, naming which half', async () => {
    const result = await testUnifiConnection(
      settingsToConnection({ ...account, apiKey: 'k' }),
      factoryOver({ failConnect: 'auth' }),
    )
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(result.error).toContain('The API key works, but')
  })
})
