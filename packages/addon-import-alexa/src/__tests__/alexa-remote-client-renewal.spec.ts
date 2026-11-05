import { afterEach, describe, expect, it, vi } from 'vitest'

interface Handlers {
  cookie: Array<() => void>
}
interface FakeAdapter {
  refreshAlexaCookie(
    options: { formerRegistrationData: unknown },
    callback: (err: Error | null, result: unknown) => void,
  ): void
}
interface Registration {
  tokenDate?: number
}

const lib: {
  initOptions: Record<string, unknown> | null
  query: (callback: (err?: Error, body?: unknown) => void) => void
  stopped: number
} = { initOptions: null, query: (cb) => cb(undefined, {}), stopped: 0 }

// The library calls its `alexaCookie` adapter when a stored registration is older than 24 h,
// exactly as alexa-remote2 8.1.1 does; `alexa-cookie2` itself must never load.
vi.mock('alexa-cookie2', () => {
  throw new Error('alexa-cookie2 must never be loaded')
})

vi.mock('alexa-remote2', () => {
  class FakeAlexaRemote {
    cookieData: unknown = undefined
    alexaCookie: FakeAdapter | undefined
    readonly #handlers: Handlers = { cookie: [] }
    on(event: string, cb: () => void): this {
      if (event === 'cookie') this.#handlers.cookie.push(cb)
      return this
    }
    setCookie(registration: unknown): void {
      this.cookieData = registration
      for (const cb of this.#handlers.cookie) cb()
    }
    init(options: Record<string, unknown>, callback: (err?: Error) => void): void {
      lib.initOptions = options
      const stored = options['cookie'] as Registration
      const stale =
        typeof stored === 'object' && Date.now() - (stored.tokenDate ?? 0) > 24 * 3600 * 1000
      if (stale && this.alexaCookie !== undefined) {
        this.alexaCookie.refreshAlexaCookie({ formerRegistrationData: stored }, (err, result) => {
          if (err) return callback(err)
          this.setCookie(result)
          callback()
        })
        return
      }
      this.cookieData = stored
      callback()
    }
    querySmarthomeDevices(
      _ids: string[],
      _type: string,
      _timeout: number,
      callback: (err?: Error, body?: unknown) => void,
    ): void {
      lib.query(callback)
    }
    stop(): void {
      lib.stopped += 1
    }
  }
  return { default: FakeAlexaRemote }
})

import { AlexaAuthError } from '../alexa-client.js'
import { AlexaRemoteClient } from '../alexa-remote-client.js'
import { REGISTRATION_DATA_VERSION, type AlexaRegistration } from '../amazon-auth/registration.js'
import { fakeAmazon, refreshRoutes, type AmazonRoutes } from './helpers/amazon-fake.js'

const NOW = 1_800_000_000_000
const HOUR = 3600 * 1000

function blob(tokenDate: number): AlexaRegistration {
  return {
    refreshToken: 'FIXTURE-REFRESH-TOKEN',
    loginCookie: 'frc=F; map-md=M; session-id=OLD',
    deviceSerial: 'SERIAL',
    amazonPage: 'amazon.it',
    deviceAppName: 'CamStack',
    localCookie: 'session-id=OLD; csrf=OLD',
    csrf: 'OLD',
    tokenDate,
    dataVersion: REGISTRATION_DATA_VERSION,
  }
}

function make(opts: { tokenDate: number; routes?: AmazonRoutes; refreshIntervalMs?: number }) {
  const amazon = fakeAmazon(opts.routes ?? refreshRoutes())
  const persisted: AlexaRegistration[] = []
  const client = new AlexaRemoteClient({
    brokerId: 'alexa_001',
    credentials: { cookie: JSON.stringify(blob(opts.tokenDate)), amazonDomain: 'amazon.it' },
    http: amazon.http,
    persistRegistration: async (registration) => {
      persisted.push(registration)
    },
    ...(opts.refreshIntervalMs === undefined ? {} : { refreshIntervalMs: opts.refreshIntervalMs }),
  })
  return { client, amazon, persisted }
}

afterEach(() => {
  vi.useRealTimers()
  lib.query = (cb) => cb(undefined, {})
  lib.initOptions = null
  lib.stopped = 0
})

describe('registration renewal in the remote client', () => {
  it('disables the library timer and names the API user agent', async () => {
    vi.useFakeTimers({ now: NOW })
    const { client } = make({ tokenDate: NOW })
    await client.connect()
    expect(lib.initOptions).toMatchObject({ cookieRefreshInterval: 0, proxyOnly: false })
    expect(lib.initOptions?.['apiUserAgentPostfix']).toMatch(/^AlexaRemote\/\d/)
    await client.disconnect()
  })

  it('does not call Amazon when the registration is fresh', async () => {
    vi.useFakeTimers({ now: NOW })
    const { client, amazon, persisted } = make({ tokenDate: NOW - HOUR })
    await client.connect()
    expect(amazon.calls).toHaveLength(0)
    expect(persisted).toHaveLength(0)
    await client.disconnect()
  })

  it('renews before init when the token is older than a day, and keeps the result', async () => {
    vi.useFakeTimers({ now: NOW })
    const { client, amazon, persisted } = make({ tokenDate: NOW - 25 * HOUR })
    await client.connect()
    expect(amazon.callsTo('POST api.amazon.it/auth/token')).toHaveLength(1)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({ csrf: 'FIXTURE-CSRF', tokenDate: NOW, dataVersion: 2 })
    expect(client.isConnected()).toBe(true)
    await client.disconnect()
  })

  it('an Amazon refusal while renewing before init is an AlexaAuthError', async () => {
    vi.useFakeTimers({ now: NOW })
    const { client } = make({
      tokenDate: NOW - 25 * HOUR,
      routes: { 'POST api.amazon.it/auth/token': { status: 401, json: {} } },
    })
    await expect(client.connect()).rejects.toBeInstanceOf(AlexaAuthError)
  })

  it('a transient failure while renewing is NOT reported as a sign-in problem', async () => {
    vi.useFakeTimers({ now: NOW })
    const { client } = make({
      tokenDate: NOW - 25 * HOUR,
      // the exchange's own message mentions the cookie, which the sign-in check would misread
      routes: {
        ...refreshRoutes(),
        'POST www.amazon.it/ap/exchangetoken/cookies': { status: 503, json: {} },
      },
    })
    const err = await client.connect().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(AlexaAuthError)
  })

  it('renews once and retries when a call finds the session dead', async () => {
    vi.useFakeTimers({ now: NOW })
    const { client, amazon, persisted } = make({ tokenDate: NOW - HOUR })
    await client.connect()
    let calls = 0
    lib.query = (cb) => {
      calls += 1
      if (calls === 1) cb(new Error('Unauthorized'))
      else cb(undefined, {})
    }
    vi.setSystemTime(NOW + HOUR)
    await client.pollStates(['a1'])
    expect(calls).toBe(2)
    expect(amazon.callsTo('POST api.amazon.it/auth/token')).toHaveLength(1)
    expect(persisted).toHaveLength(1)
    await client.disconnect()
  })

  it('turns a dead session whose renewal Amazon refuses into an AlexaAuthError', async () => {
    vi.useFakeTimers({ now: NOW })
    const { client } = make({
      tokenDate: NOW - HOUR,
      routes: { 'POST api.amazon.it/auth/token': { status: 401, json: {} } },
    })
    await client.connect()
    lib.query = (cb) => cb(new Error('Unauthorized'))
    await expect(client.pollStates(['a1'])).rejects.toBeInstanceOf(AlexaAuthError)
    await client.disconnect()
  })

  it('renews on its own timer, and stops after disconnect', async () => {
    vi.useFakeTimers({ now: NOW })
    const { client, amazon, persisted } = make({ tokenDate: NOW, refreshIntervalMs: 4 * 24 * HOUR })
    await client.connect()
    await vi.advanceTimersByTimeAsync(4 * 24 * HOUR + 1000)
    expect(amazon.callsTo('POST api.amazon.it/auth/token')).toHaveLength(1)
    expect(persisted).toHaveLength(1)
    await client.disconnect()
    await vi.advanceTimersByTimeAsync(10 * 24 * HOUR)
    expect(amazon.callsTo('POST api.amazon.it/auth/token')).toHaveLength(1)
  })
})
