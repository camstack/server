import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { AlexaAuthError, type AlexaClient, type AlexaStateValue } from '../alexa-client.js'
import { alexaConnectionSchema } from '../config.js'
import { AlexaHttpError } from '../alexa-remote-client.js'
import {
  AlexaIntegrationManager,
  POLL_FAILURES_BEFORE_ERROR,
} from '../alexa-integration-manager.js'

function makeLogger(): {
  logger: IScopedLogger
  warn: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
} {
  const warn = vi.fn()
  const info = vi.fn()
  const logger: IScopedLogger = {
    warn,
    info,
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, warn, info }
}

async function build(pollImpl: () => Promise<readonly AlexaStateValue[]>) {
  const { logger, warn, info } = makeLogger()
  const client: AlexaClient = {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    listAppliances: async () => [],
    pollStates: pollImpl,
    sendCommand: async () => {},
  }
  const manager = new AlexaIntegrationManager({
    id: 'alexa_001',
    name: 'Alexa',
    connection: alexaConnectionSchema.parse({
      cookie: 'c',
      amazonDomain: 'amazon.it',
    }),
    logger,
    onConnected: () => {},
    onDisconnected: () => {},
    onAuthFailed: () => {},
    onAppliancesChanged: () => {},
    onStatesPolled: () => {},
    makeClient: () => client,
  })
  return { manager, warn, info }
}

describe('AlexaIntegrationManager poll failure status', () => {
  it('a non-auth poll failure keeps the signed-in broker connected and surfaces the reason', async () => {
    let fail = true
    const { manager, info } = await build(async () => {
      if (fail) throw new AlexaHttpError('no body', 400)
      return []
    })
    await manager.start()
    for (let i = 0; i < POLL_FAILURES_BEFORE_ERROR + 2; i++) await manager.poll()
    expect(manager.getInfo().status).toBe('connected')
    expect(manager.getInfo().error).toContain('no body')
    expect(info.mock.calls.filter((c) => String(c[0]).includes('status changed'))).toHaveLength(0)

    fail = false
    await manager.poll()
    expect(manager.getInfo().status).toBe('connected')
    expect(manager.getInfo().error).toBeNull()
    await manager.stop()
  })

  it('an AlexaAuthError poll failure becomes auth-failed after N failures and logs the status code', async () => {
    const { manager, warn } = await build(async () => {
      throw new AlexaAuthError('no body (HTTP 403)')
    })
    await manager.start()
    for (let i = 1; i < POLL_FAILURES_BEFORE_ERROR; i++) await manager.poll()
    expect(manager.getInfo().status).toBe('auth-failed')
    await manager.stop()
    expect(warn).toHaveBeenCalled()
  })

  it('logs the HTTP status code of a failed poll', async () => {
    const { manager, warn } = await build(async () => {
      throw new AlexaHttpError('no body', 502)
    })
    await manager.start()
    // The first poll runs in the background after start() resolves.
    await vi.waitFor(() =>
      expect(warn.mock.calls.some((c) => String(c[0]).includes('poll failed'))).toBe(true),
    )
    const call = warn.mock.calls.find((c) => String(c[0]).includes('poll failed'))
    expect(call?.[1]).toMatchObject({ meta: { httpStatus: 502 } })
    await manager.stop()
  })
})

describe('AlexaIntegrationManager registration persistence', () => {
  it('forgets the new cookie when the record did not accept it', async () => {
    const { logger } = makeLogger()
    let persist: ((registration: never) => Promise<void>) | undefined
    const manager = new AlexaIntegrationManager({
      id: 'alexa_001',
      name: 'Alexa',
      connection: alexaConnectionSchema.parse({ cookie: 'old', amazonDomain: 'amazon.it' }),
      logger,
      onConnected: () => {},
      onDisconnected: () => {},
      onAuthFailed: () => {},
      onAppliancesChanged: () => {},
      onStatesPolled: () => {},
      persistRegistration: async () => {
        throw new Error('store unavailable')
      },
      makeClient: (options) => {
        persist = options.persistRegistration
        return {
          connect: async () => {},
          disconnect: async () => {},
          isConnected: () => true,
          listAppliances: async () => [],
          pollStates: async () => [],
          sendCommand: async () => {},
        }
      },
    })
    await manager.start()
    await expect(
      persist?.({
        refreshToken: 'r',
        loginCookie: 'l',
        deviceSerial: 's',
        amazonPage: 'amazon.it',
        localCookie: 'c',
        csrf: 'x',
      } as never),
    ).rejects.toThrow()
    expect(manager.getConnection().cookie).toBe('old')
    await manager.stop()
  })
})
