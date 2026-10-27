import { PetkitAuthError } from '@apocaliss92/nodepetkit'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { PetkitConfig } from '../config.js'
import { type PetkitFacadeLike, PetkitIntegrationManager } from '../petkit-integration-manager.js'
import type { PetkitSessionSink } from '../petkit-session.js'

function quietLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const CONNECTION: PetkitConfig = {
  email: 'u@example.com',
  password: 'p',
  region: 'de',
  timezone: 'UTC',
  pollIntervalMs: 30_000,
}

function recorder() {
  const calls: string[] = []
  const session: PetkitSessionSink = {
    register: (id, name) => void calls.push(`register:${id}:${name}`),
    failure: (id, err) => void calls.push(`failure:${id}:${err instanceof Error ? err.name : '?'}`),
    ok: async (id) => void calls.push(`ok:${id}`),
  }
  return { calls, session }
}

function manager(facade: PetkitFacadeLike, session: PetkitSessionSink) {
  return new PetkitIntegrationManager({
    id: 'int-1',
    name: 'Home',
    connection: CONNECTION,
    logger: quietLogger(),
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    surfaceSink: { set: () => undefined },
    makeFacade: () => facade,
    session,
  })
}

describe('PetkitIntegrationManager session reporting', () => {
  it('reports a rejected login to the session sink', async () => {
    const { calls, session } = recorder()
    const m = manager(
      {
        login: async () => {
          throw new PetkitAuthError('bad credentials')
        },
        discoverDevices: async () => [],
        createDevice: async () => {
          throw new Error('unused')
        },
      },
      session,
    )
    await expect(m.start()).rejects.toThrow()
    expect(calls).toEqual(['register:int-1:Home', 'failure:int-1:PetkitAuthError'])
  })

  it('reports a good login as a restored session', async () => {
    const { calls, session } = recorder()
    const m = manager(
      {
        login: async () => undefined,
        discoverDevices: async () => [],
        createDevice: async () => {
          throw new Error('unused')
        },
      },
      session,
    )
    await m.start()
    expect(calls).toEqual(['register:int-1:Home', 'ok:int-1'])
  })
})
