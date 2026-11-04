import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import type { AlexaAppliance, AlexaClient } from '../alexa-client.js'
import { alexaConnectionSchema } from '../config.js'
import { AlexaIntegrationManager } from '../alexa-integration-manager.js'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: Error) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function build(listAppliances: () => Promise<readonly AlexaAppliance[]>) {
  const warn = vi.fn()
  const logger: IScopedLogger = {
    warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  const pollStates = vi.fn(async () => [])
  const client: AlexaClient = {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    listAppliances,
    pollStates,
    sendCommand: async () => {},
  }
  const manager = new AlexaIntegrationManager({
    id: 'alexa_bg',
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
  return { manager, warn, pollStates }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('AlexaIntegrationManager background first sync (#418)', () => {
  it('start() resolves after connect while the first refresh is still pending', async () => {
    const refresh = deferred<readonly AlexaAppliance[]>()
    const { manager, pollStates } = build(() => refresh.promise)
    await manager.start()
    expect(manager.getInfo().status).toBe('connected')
    expect(pollStates).not.toHaveBeenCalled()
    refresh.resolve([])
    await flush()
    expect(pollStates).toHaveBeenCalledTimes(1)
    await manager.stop()
  })

  it('a failing background refresh is logged and does not reject start()', async () => {
    const { manager, warn } = build(async () => {
      throw new Error('boom')
    })
    await expect(manager.start()).resolves.toBeUndefined()
    await flush()
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('first appliance refresh failed')),
    ).toBe(true)
    expect(manager.getInfo().status).toBe('connected')
    await manager.stop()
  })

  it('stop() while the first refresh is in flight schedules no poll and no timer', async () => {
    vi.useFakeTimers()
    try {
      const refresh = deferred<readonly AlexaAppliance[]>()
      const { manager, pollStates } = build(() => refresh.promise)
      await manager.start()
      await manager.stop()
      refresh.resolve([])
      await flush()
      expect(pollStates).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
