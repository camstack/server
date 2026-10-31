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
    connection: alexaConnectionSchema.parse({ cookie: 'c', amazonDomain: 'amazon.it' }),
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
  it('moves to error after N consecutive failures, logs the transition once, recovers on success', async () => {
    let fail = true
    const { manager, info } = await build(async () => {
      if (fail) throw new AlexaHttpError('no body', 502)
      return []
    })
    await manager.start() // start() polls once: failure 1
    expect(manager.getInfo().status).toBe('connected')
    for (let i = 1; i < POLL_FAILURES_BEFORE_ERROR - 1; i++) await manager.poll()
    expect(manager.getInfo().status).toBe('connected')
    await manager.poll()
    expect(manager.getInfo().status).toBe('error')
    expect(manager.getInfo().error).toContain('no body')
    await manager.poll()
    await manager.poll()
    const transitions = info.mock.calls.filter((c) => String(c[0]).includes('status changed'))
    expect(transitions).toHaveLength(1)

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
    const call = warn.mock.calls.find((c) => String(c[0]).includes('poll failed'))
    expect(call?.[1]).toMatchObject({ meta: { httpStatus: 502 } })
    await manager.stop()
  })
})
