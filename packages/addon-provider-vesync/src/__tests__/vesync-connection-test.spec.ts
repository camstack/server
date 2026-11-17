/**
 * The VeSync connection test (planning#581 pattern): the integration form signs in once with the
 * credentials it holds (a saved password stands in for its redacted view) and names the reason
 * when VeSync refuses: the password, the region, an unreachable cloud, else the library's words.
 */
import { makeInMemoryRecords, REDACTED_SECRET } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { VeSyncClientFactory } from '../vesync-client-contract.js'
import {
  buildVeSyncInstances,
  vesyncConnectionsEntryKind,
  vesyncRecordKinds,
} from '../vesync-instances.js'
import { createTsVeSyncClientFactory, type TsVeSyncLogSink } from '../vesync-tsvesync-client.js'

interface Seen {
  readonly email: string
  readonly password: string
  readonly region: string
  logins: number
}

/** The real adapter over a fake library whose login says what `script` makes it say. */
function factoryOver(
  script: (log: TsVeSyncLogSink) => Promise<boolean>,
  seen: Seen[],
): VeSyncClientFactory {
  return createTsVeSyncClientFactory((input) => {
    const entry: Seen = {
      email: input.email,
      password: input.password,
      region: input.region,
      logins: 0,
    }
    seen.push(entry)
    return {
      login: async () => {
        entry.logins += 1
        return script(input.logger)
      },
      getDevices: async () => true,
      fans: [],
    }
  })
}

async function world(script: (log: TsVeSyncLogSink) => Promise<boolean>, seen: Seen[] = []) {
  const mem = makeInMemoryRecords('provider-vesync')
  await mem.records.declare(vesyncRecordKinds)
  const instances = buildVeSyncInstances(mem.records, {
    onChanged: async () => undefined,
    makeClient: factoryOver(script, seen),
  })
  return { mem, instances }
}

const DRAFT = { email: 'me@example.com', password: 'typed-pw', region: 'EU' }

describe('the VeSync integration declares and runs a connection test', () => {
  it('offers a Test', async () => {
    const { instances } = await world(async () => true)
    expect((await instances.describe()).canTest).toBe(true)
  })

  it('validates a draft with the typed credentials, one login', async () => {
    const seen: Seen[] = []
    const { instances } = await world(async () => true, seen)
    const result = await instances.testInstance({ id: null, values: DRAFT })
    expect(result).toMatchObject({ success: true, status: 'validated' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      email: 'me@example.com',
      password: 'typed-pw',
      region: 'EU',
      logins: 1,
    })
  })

  it('a saved password stands in for its redacted view', async () => {
    const seen: Seen[] = []
    const { mem, instances } = await world(async () => true, seen)
    await mem.records.kind(vesyncConnectionsEntryKind).put({
      id: 'int_1',
      data: { name: 'Home', email: 'me@example.com', password: 'stored-pw', region: 'US' },
    })
    await instances.testInstance({
      id: 'int_1',
      values: { email: 'me@example.com', password: REDACTED_SECRET },
    })
    expect(seen[0]).toMatchObject({ password: 'stored-pw', region: 'US' })
  })

  it('a refused password is rejected and named as the credentials', async () => {
    const { instances } = await world(async (log) => {
      log.error('Step 1 error code:', -11201022, 'message:', 'password error')
      log.error('Credential error detected - invalid username or password')
      log.error('Authentication failed due to invalid credentials')
      return false
    })
    const result = await instances.testInstance({ id: null, values: DRAFT })
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(result.error).toContain('email or password')
    expect(result.error).not.toContain('typed-pw')
  })

  it('an account neither region accepts is rejected naming the region', async () => {
    const { instances } = await world(async (log) => {
      log.error('Authentication failed: Account rejected by both US and EU regions')
      return false
    })
    const result = await instances.testInstance({ id: null, values: DRAFT })
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(result.error).toContain('region')
  })

  it('an unreachable cloud is inconclusive', async () => {
    const { instances } = await world(async (log) => {
      log.error('API call failed:', {
        code: 'ENOTFOUND',
        message: 'getaddrinfo ENOTFOUND smartapi.vesync.eu',
        url: 'https://smartapi.vesync.eu/x',
      })
      log.error('Step 1 failed:', null)
      return false
    })
    const result = await instances.testInstance({ id: null, values: DRAFT })
    expect(result).toMatchObject({ success: false, status: 'inconclusive' })
    expect(result.error).toContain('could not reach')
    expect(result.error).toContain('ENOTFOUND')
  })

  it('anything else is inconclusive with the library words', async () => {
    const { instances } = await world(async (log) => {
      log.error('Step 2 error code:', 4031, 'message:', 'app version too old')
      return false
    })
    const result = await instances.testInstance({ id: null, values: DRAFT })
    expect(result).toMatchObject({ success: false, status: 'inconclusive' })
    expect(result.error).toContain('app version too old')
  })

  it('without an email or a password the test is refused before any client is built', async () => {
    const seen: Seen[] = []
    const { instances } = await world(async () => true, seen)
    const result = await instances.testInstance({ id: null, values: { email: 'me@example.com' } })
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(seen).toHaveLength(0)
  })
})
