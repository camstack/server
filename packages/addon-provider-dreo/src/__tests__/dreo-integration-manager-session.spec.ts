import type { IntegrationSessionSink, IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { settingsToDreoConfig } from '../config.js'
import { DreoBridgeError } from '../dreo-bridge.js'
import type { DreoConnectionSurface } from '../dreo-gateway.js'
import { DreoIntegrationManager } from '../dreo-integration-manager.js'
import { classifyDreoSessionError } from '../dreo-session.js'
import { fanDevice, FakeBridge, IDLE_STATE } from './fake-bridge.js'

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
    failure: (id, err) => void calls.push(`failure:${id}:${classifyDreoSessionError(err)}`),
    ok: async (id) => void calls.push(`ok:${id}`),
  }
  return { calls, session }
}

function setup(prepare: (bridge: FakeBridge, index: number) => void = () => undefined) {
  const bridges: FakeBridge[] = []
  const surfaces: Array<DreoConnectionSurface | null> = []
  const { calls, session } = recorder()
  const manager = new DreoIntegrationManager({
    id: 'b1',
    name: 'Home',
    connection: settingsToDreoConfig({ email: 'u@example.com', password: 'p' }),
    logger: quietLogger(),
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    surfaceSink: { set: (_id, surface) => void surfaces.push(surface) },
    makeBridge: () => {
      const bridge = new FakeBridge()
      prepare(bridge, bridges.length)
      bridges.push(bridge)
      return bridge
    },
    session,
    respawnDelaysMs: [0, 0],
  })
  return { manager, bridges, surfaces, calls }
}

async function settle(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i += 1) await new Promise((r) => setTimeout(r, 5))
  expect(condition()).toBe(true)
}

const lastSurface = (surfaces: Array<DreoConnectionSurface | null>) => surfaces.at(-1) ?? null

describe('DreoIntegrationManager session reporting', () => {
  it('reports a refused sign-in as a lost session and publishes no surface', async () => {
    const h = setup((b) => {
      b.loginError = new DreoBridgeError('auth', 'refused')
    })
    await expect(h.manager.start()).rejects.toMatchObject({ code: 'auth' })
    expect(h.calls).toEqual(['register:b1:Home', 'failure:b1:auth-rejected'])
    expect(h.manager.getInfo().status).toBe('error')
    expect(h.manager.getInfo().error).toMatch(/authentication failed/)
    expect(lastSurface(h.surfaces)).toBeNull()
    expect(h.bridges[0]?.closed).toBe(true)
  })

  it('does not call an unreachable cloud a lost session', async () => {
    const h = setup((b) => {
      b.loginError = new DreoBridgeError('unreachable', 'no route')
    })
    await expect(h.manager.start()).rejects.toThrow()
    expect(h.calls).toEqual(['register:b1:Home', 'failure:b1:null'])
  })

  it('reports a good sign-in as a restored session and publishes a handle per device', async () => {
    const h = setup()
    await h.manager.start()
    expect(h.calls).toEqual(['register:b1:Home', 'ok:b1'])
    const surface = lastSurface(h.surfaces)
    expect(surface?.infos).toEqual([{ deviceId: 'dev-1', model: 'DR-HAF001S', name: 'Fan' }])
    expect(surface?.handles.get('dev-1')?.state.on).toBe(false)
  })
})

describe('DreoIntegrationManager live state', () => {
  it('folds a pushed device state into its handle', async () => {
    const h = setup()
    await h.manager.start()
    const handle = lastSurface(h.surfaces)?.handles.get('dev-1')
    h.bridges[0]?.push({ push: 'state', deviceId: 'dev-1', state: { ...IDLE_STATE, on: true } })
    expect(handle?.state.on).toBe(true)
  })

  it('sends a command through the worker and does not echo it into the state (D1061)', async () => {
    const h = setup()
    await h.manager.start()
    const handle = lastSurface(h.surfaces)?.handles.get('dev-1')
    await handle?.setPower(true)
    expect(h.bridges[0]?.commands).toEqual([
      { deviceId: 'dev-1', command: { command: 'power', value: true } },
    ])
    expect(handle?.state.on).toBe(false)
  })

  it('notifies a reconnect when the push channel comes back, not on the first connect', async () => {
    const h = setup()
    await h.manager.start()
    const handle = lastSurface(h.surfaces)?.handles.get('dev-1')
    let reconnects = 0
    handle?.onReconnect(() => void (reconnects += 1))
    h.bridges[0]?.push({ push: 'channel', state: 'up' })
    expect(reconnects).toBe(0)
    h.bridges[0]?.push({ push: 'channel', state: 'down' })
    expect(reconnects).toBe(0)
    h.bridges[0]?.push({ push: 'channel', state: 'up' })
    expect(reconnects).toBe(1)
  })

  it('refreshes the whole account from the worker, one read for concurrent callers', async () => {
    const h = setup()
    await h.manager.start()
    const surface = lastSurface(h.surfaces)
    if (h.bridges[0] !== undefined)
      h.bridges[0].refreshed = { 'dev-1': { ...IDLE_STATE, on: true } }
    await Promise.all([surface?.refresh(), surface?.refresh()])
    expect(h.bridges[0]?.refreshCalls).toBe(1)
    expect(surface?.handles.get('dev-1')?.state.on).toBe(true)
  })
})

describe('DreoIntegrationManager worker crash', () => {
  it('respawns the worker, keeps the handles and notifies a reconnect', async () => {
    const h = setup((b, index) => {
      if (index === 1) b.devices = [fanDevice('dev-1', { on: true })]
    })
    await h.manager.start()
    const handle = lastSurface(h.surfaces)?.handles.get('dev-1')
    let reconnects = 0
    handle?.onReconnect(() => void (reconnects += 1))
    h.bridges[0]?.push({ push: 'exited', code: 1 })
    expect(lastSurface(h.surfaces)).toBeNull()
    await expect(handle?.setPower(true)).rejects.toMatchObject({ code: 'exited' })
    await settle(() => h.bridges.length === 2 && reconnects === 1)
    const after = lastSurface(h.surfaces)?.handles.get('dev-1')
    expect(after).toBe(handle)
    expect(handle?.state.on).toBe(true)
    expect(h.manager.getInfo().status).toBe('connected')
  })

  it('gives up after the bounded number of respawns', async () => {
    const h = setup((b, index) => {
      if (index > 0) b.loginError = new DreoBridgeError('unreachable', 'down')
    })
    await h.manager.start()
    h.bridges[0]?.push({ push: 'exited', code: 1 })
    await settle(() => h.bridges.length === 3)
    await new Promise((r) => setTimeout(r, 30))
    expect(h.bridges).toHaveLength(3)
    expect(h.manager.getInfo().status).toBe('error')
  })

  it('ignores the exit of a worker that stop() already replaced', async () => {
    const h = setup()
    await h.manager.start()
    await h.manager.stop()
    h.bridges[0]?.push({ push: 'exited', code: 0 })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.bridges).toHaveLength(1)
    expect(h.bridges[0]?.closed).toBe(true)
  })
})
