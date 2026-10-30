import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { BrokerEcho } from '../speak/broker-echo.js'
import type { AlexaWorker } from '../speak/worker-client.js'

const REFRESH = 'refresh-token-value'

function setup(seed: { refreshToken: string; deviceAppName: string } | null) {
  const infos: Array<{ message: string; arg: unknown }> = []
  const logger = {
    info: (message: string, arg: unknown) => infos.push({ message, arg }),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as IScopedLogger
  const worker: AlexaWorker = {
    request: vi.fn(async () => ({ status: 'ok' })),
    noteSecrets: vi.fn(),
    stop: vi.fn(),
    failed: false,
  } as unknown as AlexaWorker
  const echo = new BrokerEcho({
    brokerId: 'alexa_001',
    brokerName: 'Home',
    domain: 'amazon.it',
    worker,
    readSeed: async () => seed,
    sessions: { get: async () => '', put: async () => {}, delete: async () => {} },
    logger,
  })
  return { echo, infos }
}

describe('BrokerEcho.signIn log', () => {
  it('says which sign-in fields were found, as booleans, never their values', async () => {
    const { echo, infos } = setup({ refreshToken: REFRESH, deviceAppName: 'App' })
    await echo.signIn()
    const line = infos.find((i) => i.message === 'alexa speak: broker sign-in material')
    expect(line?.arg).toEqual({
      tags: { brokerId: 'alexa_001' },
      meta: {
        seedFound: true,
        hasRefreshToken: true,
        hasDeviceAppName: true,
        hasStoredSession: false,
      },
    })
    expect(JSON.stringify(infos)).not.toContain(REFRESH)
  })

  it('reports a missing seed', async () => {
    const { echo, infos } = setup(null)
    await echo.signIn()
    const line = infos.find((i) => i.message === 'alexa speak: broker sign-in material')
    expect(line?.arg).toMatchObject({ meta: { seedFound: false, hasRefreshToken: false } })
  })
})
