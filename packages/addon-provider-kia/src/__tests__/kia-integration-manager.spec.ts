import type { IntegrationSessionSink, IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { connectionFromSettings, type KiaConfig } from '../config.js'
import { KiaBridgeError } from '../kia-bridge.js'
import { KiaCallBudget } from '../kia-budget.js'
import type { KiaConnectionSurface } from '../kia-gateway.js'
import { KiaBudgetExhaustedError, KiaIntegrationManager } from '../kia-integration-manager.js'
import { classifyKiaSessionError } from '../kia-session.js'
import { FakeBridge } from './fake-bridge.js'
import { sportageState } from './kia-fixtures.js'

const START = Date.UTC(2026, 10, 22, 8, 0, 0)

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

function config(): KiaConfig {
  const parsed = connectionFromSettings({ username: 'u@example.com', password: 'p', pin: '1234' })
  if (parsed === null) throw new Error('fixture connection is incomplete')
  return parsed
}

function setup(options: { limit?: number; reserve?: number } = {}) {
  const bridges: FakeBridge[] = []
  const prepare: Array<(bridge: FakeBridge) => void> = []
  const surfaces: Array<KiaConnectionSurface | null> = []
  const calls: string[] = []
  const clock = { now: START }
  const session: IntegrationSessionSink = {
    register: (id) => void calls.push(`register:${id}`),
    failure: (id, err) => void calls.push(`failure:${id}:${classifyKiaSessionError(err)}`),
    ok: async (id) => void calls.push(`ok:${id}`),
  }
  const manager = new KiaIntegrationManager({
    id: 'k1',
    name: 'Car',
    connection: config(),
    logger: quietLogger(),
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    surfaceSink: { set: (_id, surface) => void surfaces.push(surface) },
    makeBridge: () => {
      const bridge = new FakeBridge()
      for (const step of prepare) step(bridge)
      bridges.push(bridge)
      return bridge
    },
    session,
    budget: new KiaCallBudget({ now: () => clock.now, ...options }),
    now: () => clock.now,
  })
  const surface = (): KiaConnectionSurface => {
    const last = surfaces[surfaces.length - 1]
    if (last === undefined || last === null) throw new Error('no surface published')
    return last
  }
  return { manager, bridges, prepare, surfaces, surface, calls, clock }
}

/** The worker process is gone: the next call on it fails as the real bridge does. */
async function workerDies(
  surface: () => KiaConnectionSurface,
  bridge: FakeBridge | undefined,
): Promise<void> {
  if (bridge === undefined) throw new Error('no bridge')
  bridge.readError = new KiaBridgeError('exited', 'worker gone')
  await expect(surface().refresh('schedule')).rejects.toThrow('worker gone')
}

describe('KiaIntegrationManager', () => {
  it('signs in once and publishes a handle per vehicle with the state the cloud reported', async () => {
    const { manager, surface, bridges } = setup()
    await manager.start()
    expect(bridges).toHaveLength(1)
    expect(bridges[0]?.logins).toHaveLength(1)
    expect(surface().infos.map((i) => i.vehicleId)).toEqual(['veh-1'])
    expect(surface().handles.get('veh-1')?.state.odometerM).toBe(18_432_700)
    expect(manager.getInfo().status).toBe('connected')
  })

  it('reads the cached state of the account on the schedule and folds it into the handles', async () => {
    const { manager, surface, bridges, prepare } = setup()
    prepare.push((bridge) => {
      bridge.readStates = { 'veh-1': sportageState({ odometerM: 18_500_000 }) }
    })
    await manager.start()
    await surface().refresh('schedule')
    expect(bridges[0]?.reads).toBe(1)
    expect(surface().handles.get('veh-1')?.state.odometerM).toBe(18_500_000)
  })

  it('answers a command follow-up or a burst from what it holds, without a cloud call', async () => {
    const { manager, surface, bridges } = setup()
    await manager.start()
    await surface().refresh('command')
    await surface().refresh('burst')
    expect(bridges[0]?.reads).toBe(0)
  })

  it('keeps the last state when a read fails (D49) and reports the error', async () => {
    const { manager, surface, bridges } = setup()
    await manager.start()
    const bridge = bridges[0]
    if (bridge === undefined) throw new Error('no bridge')
    bridge.readError = new KiaBridgeError('unreachable', 'cloud down')
    await expect(surface().refresh('schedule')).rejects.toThrow('cloud down')
    expect(surface().handles.get('veh-1')?.state.odometerM).toBe(18_432_700)
    expect(manager.getInfo().status).toBe('error')
  })

  it('does not re-login in a loop after a refused sign-in: one attempt, then it waits', async () => {
    const { manager, bridges, prepare, surface } = setup()
    await manager.start()
    // The worker dies, then the account refuses the next sign-in.
    await workerDies(surface, bridges[0])
    prepare.push((bridge) => {
      bridge.loginError = new KiaBridgeError('auth', 'refused')
    })
    await expect(surface().refresh('schedule')).rejects.toThrow('refused')
    const loginsAfterFirstFailure = bridges.length
    await expect(surface().refresh('schedule')).rejects.toThrow()
    await expect(surface().refresh('schedule')).rejects.toThrow()
    expect(bridges).toHaveLength(loginsAfterFirstFailure)
    expect(manager.getInfo().status).toBe('error')
  })

  it('signs in again only once the credentials change', async () => {
    const { manager, bridges, prepare, surface } = setup()
    await manager.start()
    await workerDies(surface, bridges[0])
    prepare.push((bridge) => {
      bridge.loginError = new KiaBridgeError('auth', 'refused')
    })
    await expect(surface().refresh('schedule')).rejects.toThrow()
    prepare.length = 0
    await manager.applyConnection({ ...config(), password: 'new' })
    expect(bridges[bridges.length - 1]?.logins[0]?.password).toBe('new')
    expect(manager.getInfo().status).toBe('connected')
  })

  it('reports a refused sign-in to the session health as a lost session', async () => {
    const { manager, prepare, calls } = setup()
    prepare.push((bridge) => {
      bridge.loginError = new KiaBridgeError('auth', 'refused')
    })
    await expect(manager.start()).rejects.toThrow('refused')
    expect(calls).toContain('failure:k1:auth-rejected')
  })

  describe('requestRefresh', () => {
    it('wakes the car, folds the answer in and reports when the car last spoke', async () => {
      const { manager, surface, bridges } = setup()
      await manager.start()
      const result = await surface().handles.get('veh-1')?.requestRefresh()
      expect(result).toEqual({ ok: true, reportedAt: 1_795_339_000_000 })
      expect(bridges[0]?.refreshes).toEqual(['veh-1'])
      expect(surface().handles.get('veh-1')?.state.reportedAtMs).toBe(1_795_339_000_000)
    })

    it('refuses with a typed answer, and never calls the cloud, once the day is spent', async () => {
      const { manager, surface, bridges, clock } = setup({ limit: 10, reserve: 8 })
      await manager.start()
      clock.now += 3_600_000
      const result = await surface().handles.get('veh-1')?.requestRefresh()
      expect(result).toEqual({
        ok: false,
        reason: 'budget-exhausted',
        retryAt: Date.UTC(2026, 10, 23),
      })
      expect(bridges[0]?.refreshes).toEqual([])
    })

    it('refuses a second wake-up within the minimum gap', async () => {
      const { manager, surface, clock } = setup()
      await manager.start()
      await surface().handles.get('veh-1')?.requestRefresh()
      clock.now += 60_000
      const again = await surface().handles.get('veh-1')?.requestRefresh()
      expect(again).toMatchObject({ ok: false, reason: 'too-soon' })
    })

    it('answers in-progress to a second request while one runs', async () => {
      const { manager, surface } = setup()
      await manager.start()
      const handle = surface().handles.get('veh-1')
      const first = handle?.requestRefresh()
      const second = await handle?.requestRefresh()
      expect(second).toMatchObject({ ok: false, reason: 'in-progress' })
      await first
    })

    it('says the car did not answer when the cloud says so', async () => {
      const { manager, surface, bridges } = setup()
      await manager.start()
      const bridge = bridges[0]
      if (bridge === undefined) throw new Error('no bridge')
      bridge.refreshError = new KiaBridgeError('vehicle-unreachable', 'asleep')
      const result = await surface().handles.get('veh-1')?.requestRefresh()
      expect(result).toMatchObject({ ok: false, reason: 'vehicle-unreachable' })
    })

    it('blames the account, and stops signing in, when the session was refused', async () => {
      const { manager, surface, bridges } = setup()
      await manager.start()
      const bridge = bridges[0]
      if (bridge === undefined) throw new Error('no bridge')
      bridge.refreshError = new KiaBridgeError('auth', 'expired')
      const result = await surface().handles.get('veh-1')?.requestRefresh()
      expect(result).toMatchObject({ ok: false, reason: 'account-error' })
    })

    it('treats the cloud refusing for rate as the day being spent', async () => {
      const { manager, surface, bridges, clock } = setup()
      await manager.start()
      const bridge = bridges[0]
      if (bridge === undefined) throw new Error('no bridge')
      bridge.refreshError = new KiaBridgeError('rate-limited', 'too many')
      clock.now += 3_600_000
      const result = await surface().handles.get('veh-1')?.requestRefresh()
      expect(result).toMatchObject({ ok: false, reason: 'budget-exhausted' })
      clock.now += 3_600_000
      const next = await surface().handles.get('veh-1')?.requestRefresh()
      expect(next).toMatchObject({ ok: false, reason: 'budget-exhausted' })
      expect(bridge.refreshes).toHaveLength(1)
    })
  })

  describe('command', () => {
    it('sends it, folds in the read-back and counts it against the budget', async () => {
      const { manager, surface, bridges } = setup()
      await manager.start()
      const bridge = bridges[0]
      if (bridge === undefined) throw new Error('no bridge')
      bridge.commandState = sportageState({ locked: false })
      const handle = surface().handles.get('veh-1')
      const result = await handle?.command({ command: 'unlock' })
      expect(result?.outcome).toBe('success')
      expect(handle?.state.locked).toBe(false)
      expect(bridge.commands).toEqual([{ vehicleId: 'veh-1', command: { command: 'unlock' } }])
      expect(manager.budgetUsed()).toBeGreaterThan(1)
    })

    it('refuses with a typed error, and sends nothing, once the allowance is spent', async () => {
      const { manager, surface, bridges } = setup({ limit: 10, reserve: 8 })
      await manager.start()
      await expect(
        surface().handles.get('veh-1')?.command({ command: 'lock' }),
      ).rejects.toBeInstanceOf(KiaBudgetExhaustedError)
      expect(bridges[0]?.commands).toEqual([])
    })
  })

  it('closes a worker whose sign-in was still in flight when the account was stopped', async () => {
    const { manager, bridges, prepare } = setup()
    let release: () => void = () => undefined
    prepare.push((bridge) => {
      const login = bridge.login.bind(bridge)
      bridge.login = async (config) => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return login(config)
      }
    })
    const starting = manager.start().catch(() => undefined)
    await Promise.resolve()
    await manager.stop()
    release()
    await starting
    expect(bridges[0]?.closed).toBe(true)
    expect(manager.getInfo().status).toBe('disconnected')
  })

  describe('the day being spent is not a lost connection', () => {
    it('keeps the account connected, raises no session failure and names when it resumes', async () => {
      const { manager, surface, calls, clock } = setup({ limit: 2 })
      await manager.start()
      await surface().refresh('schedule')
      clock.now += 60_000
      await expect(surface().refresh('schedule')).rejects.toBeInstanceOf(KiaBudgetExhaustedError)
      expect(manager.getInfo().status).toBe('connected')
      expect(manager.getInfo().error).toBeNull()
      expect(manager.getInfo().info['budgetRetryAt']).toBe(Date.UTC(2026, 10, 23))
      expect(calls.filter((c) => c.startsWith('failure:'))).toEqual([])
    })
  })

  it('stop closes the worker and removes the surface', async () => {
    const { manager, surfaces, bridges } = setup()
    await manager.start()
    await manager.stop()
    expect(bridges[0]?.closed).toBe(true)
    expect(surfaces[surfaces.length - 1]).toBeNull()
  })

  it('does not drop a vehicle the cloud did not list on a later sign-in answer of nothing (D49)', async () => {
    const { manager, surface, prepare, bridges } = setup()
    await manager.start()
    await workerDies(surface, bridges[0])
    prepare.push((bridge) => {
      bridge.vehicles = []
    })
    await surface().refresh('schedule')
    expect(surface().handles.get('veh-1')).toBeDefined()
    expect(surface().infos.map((i) => i.vehicleId)).toEqual(['veh-1'])
  })
})
