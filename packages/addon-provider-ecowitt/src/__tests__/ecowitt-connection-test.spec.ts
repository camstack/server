/**
 * The Ecowitt connection test (planning#581): the integration declares a test that reads the
 * gateway's local API once with the connection as the form holds it (a saved password stands in
 * for its redacted view) and names the reason when the gateway refuses, is something else, or
 * does not answer. The reasons are the ones nodewitt's error messages tell apart.
 */
import { makeInMemoryRecords, REDACTED_SECRET } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import type { EcowittLocalConfig } from '../config.js'
import type { EcowittProbeClient, EcowittProbeFactory } from '../ecowitt-connection-test.js'
import {
  buildEcowittInstances,
  ecowittConnectionsEntryKind,
  ecowittRecordKinds,
} from '../ecowitt-instances.js'

/** What the fake gateway does once started: one reading, one error, or nothing at all. */
type FakeGateway =
  | { readonly kind: 'reading'; readonly sensors: number }
  | { readonly kind: 'error'; readonly err: Error }
  | { readonly kind: 'silent' }

function fakeProbe(
  gateway: FakeGateway,
  seen: EcowittLocalConfig[],
  stopped: { count: number } = { count: 0 },
): EcowittProbeFactory {
  return (connection) => {
    seen.push(connection)
    let onError: ((err: Error) => void) | null = null
    let onSnapshot: ((n: number) => void) | null = null
    const client: EcowittProbeClient = {
      onError: (l) => {
        onError = l
      },
      onSnapshot: (l) => {
        onSnapshot = l
      },
      start: async () => {
        // nodewitt reports through events and resolves start() anyway.
        if (gateway.kind === 'reading') onSnapshot?.(gateway.sensors)
        if (gateway.kind === 'error') onError?.(gateway.err)
      },
      stop: async () => {
        stopped.count += 1
      },
    }
    return client
  }
}

async function world(gateway: FakeGateway, seen: EcowittLocalConfig[] = []) {
  const mem = makeInMemoryRecords('provider-ecowitt')
  await mem.records.declare(ecowittRecordKinds)
  const instances = buildEcowittInstances(mem.records, {
    onChanged: async () => undefined,
    makeProbe: fakeProbe(gateway, seen),
  })
  return { mem, instances }
}

const DRAFT = { transport: 'local', host: 'gw.example', port: 80 } as const

describe('the Ecowitt integration declares and runs a connection test', () => {
  it('offers a Test', async () => {
    const { instances } = await world({ kind: 'silent' })
    expect((await instances.describe()).canTest).toBe(true)
  })

  it('validates a gateway that answers a reading, with the typed password', async () => {
    const seen: EcowittLocalConfig[] = []
    const { instances } = await world({ kind: 'reading', sensors: 7 }, seen)
    const result = await instances.testInstance({
      id: null,
      values: { ...DRAFT, password: 'typed-pass' },
    })
    expect(result).toMatchObject({ success: true, status: 'validated' })
    expect(result.detail).toContain('7')
    expect(seen[0]).toMatchObject({ host: 'gw.example', port: 80, password: 'typed-pass' })
  })

  it('a saved password stands in for its redacted view', async () => {
    const seen: EcowittLocalConfig[] = []
    const { mem, instances } = await world({ kind: 'reading', sensors: 1 }, seen)
    await mem.records.kind(ecowittConnectionsEntryKind).put({
      id: 'int_1',
      data: { name: 'Garden', transport: 'local', host: 'gw.example', password: 'stored-pass' },
    })
    await instances.testInstance({
      id: 'int_1',
      values: { ...DRAFT, password: REDACTED_SECRET },
    })
    expect(seen[0]?.password).toBe('stored-pass')
  })

  it('a refused password is rejected with the reason', async () => {
    const { instances } = await world({
      kind: 'error',
      err: new Error('Ecowitt local auth failed: invalid password'),
    })
    const result = await instances.testInstance({ id: null, values: { ...DRAFT, password: 'x' } })
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(result.error).toContain('refused the password')
  })

  it('a gateway that wants a password, none typed, is rejected and says so', async () => {
    const { instances } = await world({
      kind: 'error',
      err: new Error('Ecowitt local auth expired: HTTP 401'),
    })
    const result = await instances.testInstance({ id: null, values: DRAFT })
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(result.error).toContain('asks for a password')
  })

  it('something that is not an Ecowitt gateway is rejected as the wrong device', async () => {
    const { instances } = await world({
      kind: 'error',
      err: new Error('Ecowitt local request failed: HTTP 404 for /get_units_info'),
    })
    const result = await instances.testInstance({ id: null, values: DRAFT })
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(result.error).toContain('not the Ecowitt local API')
  })

  it('an unreachable gateway is inconclusive, never a refusal', async () => {
    const { instances } = await world({ kind: 'error', err: new TypeError('fetch failed') })
    const result = await instances.testInstance({ id: null, values: DRAFT })
    expect(result).toMatchObject({ success: false, status: 'inconclusive' })
    expect(result.error).toContain('did not answer')
  })

  it('a silent gateway is inconclusive at the deadline, and the client is stopped', async () => {
    const { testEcowittConnection } = await import('../ecowitt-connection-test.js')
    const stopped = { count: 0 }
    const result = await testEcowittConnection(
      {
        transport: 'local',
        host: 'gw.example',
        port: 80,
        password: '',
        pollIntervalMs: 60_000,
        mappingIntervalMs: 600_000,
        stationId: '',
      },
      fakeProbe({ kind: 'silent' }, [], stopped),
      20,
    )
    expect(result).toMatchObject({ success: false, status: 'inconclusive' })
    expect(stopped.count).toBe(1)
  })

  it('a push (listener) gateway has nothing to dial: inconclusive, no client built', async () => {
    const seen: EcowittLocalConfig[] = []
    const { instances } = await world({ kind: 'reading', sensors: 1 }, seen)
    const result = await instances.testInstance({
      id: null,
      values: { transport: 'listener', listenPort: 4199 },
    })
    expect(result).toMatchObject({ success: false, status: 'inconclusive' })
    expect(seen).toHaveLength(0)
  })

  it('without a host the test is refused before any client is built', async () => {
    const seen: EcowittLocalConfig[] = []
    const { instances } = await world({ kind: 'reading', sensors: 1 }, seen)
    const result = await instances.testInstance({ id: null, values: { transport: 'local' } })
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(seen).toHaveLength(0)
  })
})
