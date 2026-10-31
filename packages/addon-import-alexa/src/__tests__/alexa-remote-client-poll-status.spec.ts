import { describe, expect, it, vi } from 'vitest'

type LibLogger = (...args: unknown[]) => void
const lib: { logger: LibLogger | null; nextLine: string } = { logger: null, nextLine: '' }

vi.mock('alexa-remote2', () => {
  class FakeAlexaRemote {
    cookieData: unknown = undefined
    on(): this {
      return this
    }
    init(options: { logger?: LibLogger }, callback: (err?: Error) => void): void {
      lib.logger = options.logger ?? null
      callback()
    }
    querySmarthomeDevices(
      _ids: string[],
      _type: string,
      _timeout: number,
      callback: (err?: Error, body?: unknown) => void,
    ): void {
      lib.logger?.(lib.nextLine)
      callback(new Error('no body'))
    }
    stop(): void {}
  }
  return { default: FakeAlexaRemote }
})

import { AlexaAuthError } from '../alexa-client.js'
import { AlexaHttpError, AlexaRemoteClient } from '../alexa-remote-client.js'

async function connected(): Promise<AlexaRemoteClient> {
  const client = new AlexaRemoteClient({
    brokerId: 'alexa_001',
    credentials: { cookie: 'session-cookie', amazonDomain: 'amazon.it' },
  })
  await client.connect()
  return client
}

describe('AlexaRemoteClient.pollStates failure classification', () => {
  it('a body-less 403 means the session is dead: AlexaAuthError', async () => {
    const client = await connected()
    lib.nextLine = 'Alexa-Remote: Response: No body (code=403)'
    await expect(client.pollStates(['a1'])).rejects.toBeInstanceOf(AlexaAuthError)
  })

  it('a body-less 502 keeps the HTTP status on the error', async () => {
    const client = await connected()
    lib.nextLine = 'Alexa-Remote: Response: No body (code=502)'
    const err = await client.pollStates(['a1']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AlexaHttpError)
    expect(err instanceof AlexaHttpError ? err.statusCode : null).toBe(502)
  })
})
