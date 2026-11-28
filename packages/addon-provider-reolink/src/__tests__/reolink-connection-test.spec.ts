/**
 * The Reolink NVR / Home Hub connection test (planning#581): the integration declares a test that
 * logs in over Baichuan with the connection as the form holds it (a saved password stands in for
 * its redacted view) and names the reason when the hub refuses the login or does not answer.
 */
import { makeInMemoryRecords, REDACTED_SECRET } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import type { ReolinkHubConnection } from '../hub-connection.js'
import type { ReolinkHubProbeFactory } from '../reolink-connection-test.js'
import { testReolinkHubConnection } from '../reolink-connection-test.js'
import {
  buildReolinkInstances,
  reolinkConnectionsEntryKind,
  reolinkRecordKinds,
} from '../reolink-instances.js'

interface ProbeLog {
  readonly seen: ReolinkHubConnection[]
  closed: number
}

function fakeProbe(
  login: () => Promise<void>,
  log: ProbeLog,
  channels: number | null = 4,
): ReolinkHubProbeFactory {
  return (connection) => {
    log.seen.push(connection)
    return {
      login,
      channelCount: async () => channels,
      close: async () => {
        log.closed += 1
      },
    }
  }
}

const ok = async (): Promise<void> => undefined
const failWith = (message: string, code?: string) => async (): Promise<void> => {
  throw Object.assign(new Error(message), code === undefined ? {} : { code })
}

async function world(login: () => Promise<void>, log: ProbeLog = { seen: [], closed: 0 }) {
  const mem = makeInMemoryRecords('provider-reolink')
  await mem.records.declare(reolinkRecordKinds)
  const instances = buildReolinkInstances(mem.records, {
    onChanged: async () => undefined,
    registryEvidenceOf: async () => null,
    makeHubProbe: fakeProbe(login, log),
  })
  return { mem, instances, log }
}

const DRAFT = { host: 'nvr.example', username: 'admin' } as const

describe('the Reolink integration declares and runs a hub connection test', () => {
  it('offers a Test', async () => {
    const { instances } = await world(ok)
    expect((await instances.describe()).canTest).toBe(true)
  })

  it('validates a hub that accepts the login, with the typed password, and closes the session', async () => {
    const { instances, log } = await world(ok)
    const result = await instances.testInstance({
      id: null,
      values: { ...DRAFT, password: 'typed-pass' },
    })
    expect(result).toMatchObject({ success: true, status: 'validated', detail: '4 channels' })
    expect(log.seen[0]).toMatchObject({ host: 'nvr.example', port: 9000, password: 'typed-pass' })
    expect(log.closed).toBe(1)
  })

  it('a saved password stands in for its redacted view', async () => {
    const { mem, instances, log } = await world(ok)
    await mem.records.kind(reolinkConnectionsEntryKind).put({
      id: 'int_1',
      data: { name: 'NVR', host: 'nvr.example', password: 'stored-pass' },
    })
    await instances.testInstance({
      id: 'int_1',
      values: { ...DRAFT, password: REDACTED_SECRET },
    })
    expect(log.seen[0]?.password).toBe('stored-pass')
  })

  it('a refused login is rejected with the reason', async () => {
    const { instances } = await world(
      failWith(
        'Baichuan login failed: empty reply (camera may be sleeping/waking, session may be stale, or username/password may be invalid)',
      ),
    )
    const result = await instances.testInstance({ id: null, values: { ...DRAFT, password: 'x' } })
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(result.error).toContain('refused the username or password')
  })

  it('an unreachable hub is inconclusive, never a refusal', async () => {
    const { instances } = await world(
      failWith('connect ECONNREFUSED 10.0.0.9:9000', 'ECONNREFUSED'),
    )
    const result = await instances.testInstance({ id: null, values: { ...DRAFT, password: 'x' } })
    expect(result).toMatchObject({ success: false, status: 'inconclusive' })
    expect(result.error).toContain('did not answer')
  })

  it('a hub that never completes the login is inconclusive at the deadline, and closed', async () => {
    const log: ProbeLog = { seen: [], closed: 0 }
    const result = await testReolinkHubConnection(
      {
        host: 'nvr.example',
        port: 9000,
        rtspPort: 554,
        username: 'admin',
        password: 'x',
        transport: 'tcp',
        debugGeneral: false,
        debugSocketLogs: [],
      },
      fakeProbe(() => new Promise<void>(() => undefined), log),
      20,
    )
    expect(result).toMatchObject({ success: false, status: 'inconclusive' })
    expect(log.closed).toBe(1)
  })

  it('without a password the test is refused before any session is dialled', async () => {
    const { instances, log } = await world(ok)
    const result = await instances.testInstance({ id: null, values: DRAFT })
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(log.seen).toHaveLength(0)
  })

  it('the standalone-cameras integration (no host) has no hub to dial: inconclusive', async () => {
    const { instances, log } = await world(ok)
    const result = await instances.testInstance({ id: null, values: {} })
    expect(result).toMatchObject({ success: false, status: 'inconclusive' })
    expect(log.seen).toHaveLength(0)
  })
})
