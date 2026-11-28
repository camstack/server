/**
 * The VeSync account's country code. The library signs in as `userCountryCode = countryCode ||
 * "US"`, so an EU account without one is refused at Step 2 ("login temporary auth code expired").
 * The operator's code must reach `new VeSync(..., { countryCode })` on both the runtime and the
 * Test path, and that refusal must read as a region problem that names the fix.
 */
import { makeInMemoryRecords } from '@dominevo/types'
import { fakeAddonContext } from '@dominevo/types/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { connectionFromBody, vesyncConnectionSchema } from '../config.js'
import type { VeSyncClient, VeSyncClientFactory } from '../vesync-client-contract.js'
import { buildVeSyncInstances, vesyncRecordKinds } from '../vesync-instances.js'
import { VeSyncIntegrationManager } from '../vesync-integration-manager.js'
import {
  classifyLoginFailure,
  tsVeSyncClientFactory,
  type LibraryLine,
} from '../vesync-tsvesync-client.js'

const constructed = vi.hoisted((): unknown[][] => [])

vi.mock('tsvesync', () => ({
  VeSync: class {
    readonly fans: readonly object[] = []
    constructor(...args: unknown[]) {
      constructed.push(args)
    }
    async login(): Promise<boolean> {
      return true
    }
    async getDevices(): Promise<boolean> {
      return true
    }
  },
}))

beforeEach(() => {
  constructed.length = 0
})

/** The options object the real factory handed to `new VeSync`. */
function libraryOptions(): unknown {
  return constructed[0]?.[3]
}

describe('the VeSync country code', () => {
  it('is optional, trimmed and upper-cased, and refuses anything but two letters', () => {
    const base = { email: 'me@example.com', password: 'pw' }
    expect(vesyncConnectionSchema.parse(base).countryCode).toBeUndefined()
    expect(vesyncConnectionSchema.parse({ ...base, countryCode: '' }).countryCode).toBeUndefined()
    expect(vesyncConnectionSchema.parse({ ...base, countryCode: ' it ' }).countryCode).toBe('IT')
    expect(vesyncConnectionSchema.safeParse({ ...base, countryCode: 'ITA' }).success).toBe(false)
    expect(vesyncConnectionSchema.safeParse({ ...base, countryCode: 'I1' }).success).toBe(false)
    expect(connectionFromBody({ ...base, countryCode: 'de' })?.countryCode).toBe('DE')
  })

  it('reaches the library when configured, alongside the region', async () => {
    tsVeSyncClientFactory({
      email: 'me@example.com',
      password: 'pw',
      region: 'EU',
      countryCode: 'IT',
    })
    expect(libraryOptions()).toMatchObject({ region: 'EU', countryCode: 'IT' })
  })

  it('is left out when not configured (the library default applies)', () => {
    tsVeSyncClientFactory({
      email: 'me@example.com',
      password: 'pw',
      region: 'EU',
    })
    expect(libraryOptions()).toMatchObject({ region: 'EU' })
    expect(libraryOptions()).not.toHaveProperty('countryCode')
  })

  it('the runtime manager signs in with the configured country code', async () => {
    const seen: Parameters<VeSyncClientFactory>[0][] = []
    const client: VeSyncClient = {
      login: async () => undefined,
      restoreSession: () => undefined,
      logout: async () => undefined,
      listDevices: async () => [],
      getDevice: () => null,
      setPower: async () => undefined,
      setFanSpeed: async () => undefined,
      setMode: async () => undefined,
      setChildLock: async () => undefined,
      setDisplay: async () => undefined,
      setTargetHumidity: async () => undefined,
      refreshDevice: async () => null,
    }
    const manager = new VeSyncIntegrationManager({
      id: 'int_1',
      name: 'Home',
      connection: vesyncConnectionSchema.parse({
        email: 'me@example.com',
        password: 'pw',
        region: 'EU',
        countryCode: 'IT',
      }),
      logger: fakeAddonContext().logger,
      sessions: {
        load: async () => null,
        save: async () => undefined,
        clear: async () => undefined,
        prune: async () => undefined,
      },
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: () => undefined,
      makeClient: (input) => {
        seen.push(input)
        return client
      },
    })
    await manager.start()
    await manager.stop()
    expect(seen[0]).toMatchObject({ region: 'EU', countryCode: 'IT' })
  })

  it('the connection Test signs in with the typed country code', async () => {
    const mem = makeInMemoryRecords('provider-vesync')
    await mem.records.declare(vesyncRecordKinds)
    const instances = buildVeSyncInstances(mem.records, {
      onChanged: async () => undefined,
      makeClient: tsVeSyncClientFactory,
    })
    const result = await instances.testInstance({
      id: null,
      values: {
        email: 'me@example.com',
        password: 'pw',
        region: 'EU',
        countryCode: 'it',
      },
    })
    expect(result).toMatchObject({ success: true })
    expect(libraryOptions()).toMatchObject({ region: 'EU', countryCode: 'IT' })
  })
})

describe('a sign-in refused for the country code', () => {
  /** The lines tsvesync 1.4.9 logged on the live hub for an EU account signed in as US. */
  const LIVE: readonly LibraryLine[] = [
    {
      level: 'error',
      message: 'Step 2 error code:',
      args: [-11265129, 'message:', 'login temporary auth code expired'],
    },
    {
      level: 'error',
      message: 'Legacy login error code:',
      args: [-11000022, 'message:', 'illegal argument'],
    },
    {
      level: 'error',
      message: 'Unable to authenticate with supplied credentials after all retry attempts',
      args: [],
    },
  ]

  it('is classified as region, and the message names the country code', () => {
    const err = classifyLoginFailure(LIVE)
    expect(err.kind).toBe('region')
    expect(err.message).toMatch(/country code/i)
  })

  it("the library's own countryCode hint is a region problem too", () => {
    const err = classifyLoginFailure([
      {
        level: 'error',
        message: 'AUTHENTICATION FAILED: COUNTRY CODE REQUIRED',
        args: [],
      },
      {
        level: 'error',
        message: '   Add: "countryCode": "YOUR_COUNTRY_CODE"',
        args: [],
      },
      {
        level: 'error',
        message: 'Unable to authenticate with supplied credentials after all retry attempts',
        args: [],
      },
    ])
    expect(err.kind).toBe('region')
  })

  it('a wrong password is still the credentials', () => {
    const err = classifyLoginFailure([
      {
        level: 'error',
        message: 'Step 1 error code:',
        args: [-11201022, 'message:', 'x'],
      },
      {
        level: 'error',
        message: 'Credential error detected - invalid username or password',
        args: [],
      },
      {
        level: 'error',
        message: 'Unable to authenticate with supplied credentials after all retry attempts',
        args: [],
      },
    ])
    expect(err.kind).toBe('credentials')
  })

  it('the connection Test tells the operator to set the country code', async () => {
    const mem = makeInMemoryRecords('provider-vesync')
    await mem.records.declare(vesyncRecordKinds)
    const instances = buildVeSyncInstances(mem.records, {
      onChanged: async () => undefined,
      makeClient: () => ({
        login: async () => {
          throw classifyLoginFailure(LIVE)
        },
        restoreSession: () => undefined,
        logout: async () => undefined,
        listDevices: async () => [],
        getDevice: () => null,
        setPower: async () => undefined,
        setFanSpeed: async () => undefined,
        setMode: async () => undefined,
        setChildLock: async () => undefined,
        setDisplay: async () => undefined,
        setTargetHumidity: async () => undefined,
        refreshDevice: async () => null,
      }),
    })
    const result = await instances.testInstance({
      id: null,
      values: { email: 'me@example.com', password: 'pw', region: 'EU' },
    })
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(result.error).toMatch(/country code/i)
  })
})

describe('a malformed country code', () => {
  async function instancesOver() {
    const mem = makeInMemoryRecords('provider-vesync')
    await mem.records.declare(vesyncRecordKinds)
    return buildVeSyncInstances(mem.records, {
      onChanged: async () => undefined,
      makeClient: tsVeSyncClientFactory,
    })
  }

  it('is refused at save, so a stored account always parses', async () => {
    const instances = await instancesOver()
    await expect(
      instances.createInstance({
        id: 'int_1',
        name: 'Home',
        values: { email: 'me@example.com', password: 'pw', countryCode: '1T' },
      }),
    ).rejects.toThrow()
    await instances.createInstance({ id: 'int_2', name: 'Home' })
    await expect(
      instances.updateInstance({ id: 'int_2', values: { countryCode: 'I' } }),
    ).rejects.toThrow()
  })

  it('a valid one is stored upper-cased', async () => {
    const instances = await instancesOver()
    await instances.createInstance({
      id: 'int_3',
      name: 'Home',
      values: { email: 'me@example.com', password: 'pw', countryCode: ' it ' },
    })
    expect((await instances.getResolved('int_3'))?.countryCode).toBe('IT')
  })

  it('the Test names the country code, not the email', async () => {
    const instances = await instancesOver()
    const result = await instances.testInstance({
      id: null,
      values: { email: 'me@example.com', password: 'pw', countryCode: 'I' },
    })
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(result.error).toMatch(/country/i)
    expect(result.error).not.toMatch(/email/i)
  })
})
