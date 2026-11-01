import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'

type LibLogger = (...args: unknown[]) => void
const lib: {
  logger: LibLogger | null
  calls: string[][]
  failChunkWith: string | null
  poisonedId: string | null
} = { logger: null, calls: [], failChunkWith: null, poisonedId: null }

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
      ids: string[],
      _type: string,
      _timeout: number,
      callback: (err?: Error, body?: unknown) => void,
    ): void {
      lib.calls.push(ids)
      if (lib.poisonedId !== null && ids.includes(lib.poisonedId)) {
        lib.logger?.(`Alexa-Remote: Response: No body (code=${lib.failChunkWith ?? '400'})`)
        callback(new Error('no body'))
        return
      }
      callback(undefined, {
        deviceStates: ids.map((id) => ({
          entity: { entityId: id },
          capabilityStates: [
            JSON.stringify({
              namespace: 'Alexa.PowerController',
              name: 'powerState',
              value: 'ON',
            }),
          ],
        })),
      })
    }
    stop(): void {}
  }
  return { default: FakeAlexaRemote }
})

import { AlexaRemoteClient, POLL_CHUNK_SIZE } from '../alexa-remote-client.js'

function makeLogger(): { logger: IScopedLogger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn()
  const logger: IScopedLogger = {
    warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, warn }
}

async function connected(logger: IScopedLogger): Promise<AlexaRemoteClient> {
  const client = new AlexaRemoteClient({
    brokerId: 'alexa_001',
    credentials: { cookie: 'session-cookie', amazonDomain: 'amazon.it' },
    logger,
  })
  await client.connect()
  return client
}

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `id-${i}`)

describe('AlexaRemoteClient.pollStates chunking', () => {
  it('never sends more than POLL_CHUNK_SIZE ids in one query', async () => {
    lib.calls = []
    lib.poisonedId = null
    const { logger } = makeLogger()
    const client = await connected(logger)
    const values = await client.pollStates(ids(236))
    expect(lib.calls.length).toBe(Math.ceil(236 / POLL_CHUNK_SIZE))
    expect(Math.max(...lib.calls.map((c) => c.length))).toBeLessThanOrEqual(POLL_CHUNK_SIZE)
    expect(new Set(values.map((v) => v.applianceId)).size).toBe(236)
  })

  it('a failed chunk is logged and the other chunks still apply', async () => {
    lib.calls = []
    lib.poisonedId = 'id-0'
    lib.failChunkWith = '400'
    const { logger, warn } = makeLogger()
    const client = await connected(logger)
    const values = await client.pollStates(ids(236))
    expect(values.length).toBe(236 - POLL_CHUNK_SIZE)
    const call = warn.mock.calls.find((c) => String(c[0]).includes('chunk failed'))
    expect(call?.[1]).toMatchObject({
      meta: { chunkSize: POLL_CHUNK_SIZE, firstId: 'id-0' },
    })
  })

  it('every chunk failing still rejects, so the manager sees the failure', async () => {
    lib.calls = []
    lib.poisonedId = 'id-0'
    const { logger } = makeLogger()
    const client = await connected(logger)
    await expect(client.pollStates(['id-0'])).rejects.toThrow(/no body/i)
  })
})
