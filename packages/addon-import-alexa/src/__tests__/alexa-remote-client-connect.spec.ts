import { describe, expect, it, vi } from 'vitest'

// The real alexa-remote2 has no `getAuthenticationDetails` at runtime (it is only
// in the .d.ts); `init` itself verifies authentication through `checkAuthentication`.
vi.mock('alexa-remote2', () => {
  class FakeAlexaRemote {
    cookieData: unknown = undefined
    on(): this {
      return this
    }
    init(_options: unknown, callback: (err?: Error) => void): void {
      callback()
    }
    stop(): void {}
  }
  return { default: FakeAlexaRemote }
})

import { AlexaRemoteClient } from '../alexa-remote-client.js'

describe('AlexaRemoteClient.connect against the real library surface', () => {
  it('connects after init succeeds, without calling a method the library does not have', async () => {
    const client = new AlexaRemoteClient({
      brokerId: 'alexa_001',
      credentials: { cookie: 'session-cookie', amazonDomain: 'amazon.it' },
    })
    await client.connect()
    expect(client.isConnected()).toBe(true)
  })
})
