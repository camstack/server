import { DreoAuthError } from '@apocaliss92/nodedreo'
import type { IntegrationSessionSink, IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { settingsToDreoConfig } from '../config.js'
import { type DreoFacadeLike, DreoIntegrationManager } from '../dreo-integration-manager.js'

function quietLogger(): IScopedLogger {
  const log: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
    withTags: () => log,
  }
  return log
}

function recorder() {
  const calls: string[] = []
  const session: IntegrationSessionSink = {
    register: (id, name) => void calls.push(`register:${id}:${name}`),
    failure: (id, err) => void calls.push(`failure:${id}:${err instanceof Error ? err.name : '?'}`),
    ok: async (id) => void calls.push(`ok:${id}`),
  }
  return { calls, session }
}

function manager(facade: DreoFacadeLike, session: IntegrationSessionSink) {
  return new DreoIntegrationManager({
    id: 'b1',
    name: 'Home',
    connection: settingsToDreoConfig({ email: 'u@example.com', password: 'p' }),
    logger: quietLogger(),
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    surfaceSink: { set: () => undefined },
    makeFacade: () => facade,
    session,
  })
}

const OK_FACADE: DreoFacadeLike = {
  login: async () => undefined,
  discoverDevices: async () => [],
  connect: async () => undefined,
  createDevice: async () => {
    throw new Error('unused')
  },
  close: () => undefined,
}

describe('DreoIntegrationManager session reporting', () => {
  it('reports a rejected sign-in', async () => {
    const { calls, session } = recorder()
    const m = manager(
      {
        ...OK_FACADE,
        login: async () => {
          throw new DreoAuthError('bad credentials')
        },
      },
      session,
    )
    await expect(m.start()).rejects.toThrow()
    expect(calls).toEqual(['register:b1:Home', 'failure:b1:DreoAuthError'])
  })

  it('reports a good sign-in as a restored session', async () => {
    const { calls, session } = recorder()
    await manager(OK_FACADE, session).start()
    expect(calls).toEqual(['register:b1:Home', 'ok:b1'])
  })
})
