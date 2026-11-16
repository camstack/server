/**
 * The Unraid connection test (planning#581 audit): the integration declares a test that signs in
 * with the API key as the form holds it (a saved key stands in for its redacted view) and names
 * the reason when the server refuses or cannot be reached.
 */
import { makeInMemoryRecords, REDACTED_SECRET } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type {
  UnraidClientFactory,
  UnraidClientFactoryInput,
  UnraidClientLike,
} from '../unraid-client-contract.js'
import { UnraidClientError } from '../unraid-client-live.js'
import {
  buildUnraidInstances,
  unraidConnectionsEntryKind,
  unraidRecordKinds,
} from '../unraid-instances.js'

/** A client whose connect fails with `failure` (or succeeds); only connect/disconnect are used. */
function fakeFactory(failure: Error | null, seen: UnraidClientFactoryInput[]): UnraidClientFactory {
  const unused = (): never => {
    throw new Error('not used by the test')
  }
  return (input) => {
    seen.push(input)
    const client: UnraidClientLike = {
      connect: async () => {
        if (failure !== null) throw failure
      },
      disconnect: async () => undefined,
      array: {
        get: unused,
        setState: unused,
        parity: { start: unused, cancel: unused },
      },
      docker: { list: unused, start: unused, stop: unused },
      vms: {
        list: unused,
        start: unused,
        stop: unused,
        pause: unused,
        resume: unused,
        forceStop: unused,
        reboot: unused,
      },
      system: { cpu: unused },
      notifications: { active: unused },
    }
    return client
  }
}

async function world(failure: Error | null, seen: UnraidClientFactoryInput[] = []) {
  const mem = makeInMemoryRecords('provider-unraid')
  await mem.records.declare(unraidRecordKinds)
  const instances = buildUnraidInstances(mem.records, {
    onChanged: async () => undefined,
    makeClient: fakeFactory(failure, seen),
  })
  return { mem, instances }
}

describe('the Unraid integration declares and runs a connection test', () => {
  it('offers a Test', async () => {
    const { instances } = await world(null)
    expect((await instances.describe()).canTest).toBe(true)
  })

  it('validates a draft with the typed API key', async () => {
    const seen: UnraidClientFactoryInput[] = []
    const { instances } = await world(null, seen)
    const result = await instances.testInstance({
      id: null,
      values: { host: 'tower.example', apiKey: 'typed-key' },
    })
    expect(result).toMatchObject({ success: true, status: 'validated' })
    expect(seen[0]?.apiKey).toBe('typed-key')
  })

  it('a saved API key stands in for its redacted view', async () => {
    const seen: UnraidClientFactoryInput[] = []
    const { mem, instances } = await world(null, seen)
    await mem.records.kind(unraidConnectionsEntryKind).put({
      id: 'int_1',
      data: { name: 'Tower', host: 'tower.example', apiKey: 'stored-key' },
    })
    await instances.testInstance({
      id: 'int_1',
      values: { host: 'tower.example', apiKey: REDACTED_SECRET },
    })
    expect(seen[0]?.apiKey).toBe('stored-key')
  })

  it('a refused key is rejected with the reason; an unreachable server is inconclusive', async () => {
    const refused = await (
      await world(new UnraidClientError('auth', 'invalid API key'))
    ).instances.testInstance({
      id: null,
      values: { host: 'tower.example', apiKey: 'k' },
    })
    expect(refused).toMatchObject({ success: false, status: 'rejected' })
    expect(refused.error).toContain('API key')

    const down = await (
      await world(new UnraidClientError('transport', 'ECONNREFUSED'))
    ).instances.testInstance({
      id: null,
      values: { host: 'tower.example', apiKey: 'k' },
    })
    expect(down).toMatchObject({ success: false, status: 'inconclusive' })
    expect(down.error).toContain('host')
  })

  it('without an API key the test is refused before any client is built', async () => {
    const seen: UnraidClientFactoryInput[] = []
    const { instances } = await world(null, seen)
    const result = await instances.testInstance({
      id: null,
      values: { host: 'tower.example' },
    })
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(seen).toHaveLength(0)
  })
})
