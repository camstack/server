/**
 * The core decides when VeSync is read (D1062); the manager only knows how. A command sends the
 * command and nothing else; the hub's scheduler then asks for a read of THAT device, which pushes
 * the real state (no value is invented). A scheduled read re-lists the account; a poll that
 * started before the command never overwrites the fresher read. The manager owns no timer.
 */
import type { IScopedLogger, LogExtras } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { vesyncConnectionSchema } from '../config.js'
import type {
  VeSyncClient,
  VeSyncDeviceSnapshot,
  VeSyncPurifierSnapshot,
} from '../vesync-client-contract.js'
import { VeSyncIntegrationManager } from '../vesync-integration-manager.js'
import type { VeSyncSessionStore } from '../vesync-session-store.js'

interface LoggedLine {
  readonly level: string
  readonly message: string
  readonly meta: LogExtras | undefined
}

function capturingLogger(lines: LoggedLine[]): IScopedLogger {
  const at =
    (level: string) =>
    (message: string, meta?: LogExtras): void => {
      lines.push({ level, message, meta })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const noSessions: VeSyncSessionStore = {
  load: async () => null,
  save: async () => undefined,
  clear: async () => undefined,
  prune: async () => undefined,
}

function purifierState(over: Partial<VeSyncPurifierSnapshot> = {}): VeSyncPurifierSnapshot {
  return {
    kind: 'purifier',
    nativeId: 'cid-1',
    name: 'Purifier',
    power: false,
    speedPercent: null,
    preset: '',
    availablePresets: ['auto', 'sleep'],
    childLock: false,
    display: true,
    filterLifePercent: 90,
    online: true,
    ...over,
  }
}

function world() {
  const calls: string[] = []
  /** What the cloud reports for the device right now. */
  let cloud: VeSyncPurifierSnapshot = purifierState()
  /** When set, the next listDevices waits here and answers the state it read on entry. */
  let pollGate: Promise<void> | null = null
  let polled = 0
  const lines: LoggedLine[] = []
  const client: VeSyncClient = {
    login: async () => undefined,
    restoreSession: () => undefined,
    logout: async () => undefined,
    listDevices: async (): Promise<readonly VeSyncDeviceSnapshot[]> => {
      calls.push('listDevices')
      const read = cloud
      if (pollGate !== null) await pollGate
      return [read]
    },
    refreshDevice: async (nativeId) => {
      calls.push(`refreshDevice:${nativeId}`)
      return nativeId === cloud.nativeId ? cloud : null
    },
    getDevice: () => cloud,
    setPower: async (_id, on) => {
      calls.push(`setPower:${String(on)}`)
      cloud = { ...cloud, power: on }
    },
    setFanSpeed: async () => undefined,
    setMode: async () => undefined,
    setChildLock: async () => undefined,
    setDisplay: async () => undefined,
    setTargetHumidity: async () => undefined,
  }
  const manager = new VeSyncIntegrationManager({
    id: 'int_1',
    name: 'Home',
    connection: vesyncConnectionSchema.parse({
      email: 'me@example.com',
      password: 'pw',
      pollIntervalMs: 3_600_000,
    }),
    logger: capturingLogger(lines),
    sessions: noSessions,
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    onPolled: () => {
      polled += 1
    },
    makeClient: () => client,
  })
  return {
    manager,
    calls,
    lines,
    polledCount: (): number => polled,
    setPollGate: (gate: Promise<void> | null): void => {
      pollGate = gate
    },
  }
}

const TARGET = { nativeId: 'cid-1', deviceId: 5851 }

describe('VeSyncIntegrationManager — the core reads, the manager only knows how (D1062)', () => {
  it('owns no timer: after start, nothing is scheduled', async () => {
    vi.useFakeTimers()
    try {
      const w = world()
      await w.manager.start()
      w.calls.length = 0
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(7_200_000)
      expect(w.calls).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("a command sends only the command; the read is the core's", async () => {
    const w = world()
    await w.manager.start()
    w.calls.length = 0
    await w.manager.runCommand({
      ...TARGET,
      name: 'setPower(on)',
      run: (c) => c.setPower('cid-1', true),
    })
    expect(w.calls).toEqual(['setPower:true'])
  })

  it('a command read re-reads THAT device and pushes its real state', async () => {
    const w = world()
    await w.manager.start()
    const pushesBefore = w.polledCount()
    w.calls.length = 0
    await w.manager.runCommand({
      ...TARGET,
      name: 'setPower(on)',
      run: (c) => c.setPower('cid-1', true),
    })
    await w.manager.refresh('command', [TARGET])
    expect(w.calls).toEqual(['setPower:true', 'refreshDevice:cid-1'])
    expect(w.manager.getDevice('cid-1')).toMatchObject({ power: true })
    expect(w.polledCount()).toBe(pushesBefore + 1)
  })

  it('a scheduled read re-lists the account', async () => {
    const w = world()
    await w.manager.start()
    w.calls.length = 0
    await w.manager.refresh('schedule', [TARGET, { nativeId: 'cid-1', deviceId: 5852 }])
    expect(w.calls).toEqual(['listDevices'])
  })

  it('a burst naming one cid twice reads it once', async () => {
    const w = world()
    await w.manager.start()
    w.calls.length = 0
    await w.manager.refresh('burst', [TARGET, { nativeId: 'cid-1', deviceId: 5852 }])
    expect(w.calls).toEqual(['refreshDevice:cid-1'])
  })

  it('logs the command (commandMs) and the read (refreshMs, totalMs), tagged with the deviceId', async () => {
    const w = world()
    await w.manager.start()
    w.lines.length = 0
    await w.manager.runCommand({
      ...TARGET,
      name: 'setPower(on)',
      run: (c) => c.setPower('cid-1', true),
    })
    await w.manager.refresh('command', [TARGET])
    const ack = w.lines.find((l) => /command .*acknowledged/.test(l.message))
    const refresh = w.lines.find((l) => /refreshed/.test(l.message))
    expect(ack?.meta?.tags).toEqual({ deviceId: 5851 })
    expect(typeof ack?.meta?.meta?.['commandMs']).toBe('number')
    expect(refresh?.meta?.tags).toEqual({ deviceId: 5851 })
    expect(refresh?.message).toContain('after setPower(on)')
    expect(typeof refresh?.meta?.meta?.['refreshMs']).toBe('number')
    expect(typeof refresh?.meta?.meta?.['totalMs']).toBe('number')
  })

  it("a refused command is logged and rethrown, and the core's read shows what landed", async () => {
    const w = world()
    await w.manager.start()
    w.calls.length = 0
    w.lines.length = 0
    // setPower acknowledged, then setMode refused: the device IS on now.
    await expect(
      w.manager.runCommand({
        ...TARGET,
        name: 'setSpeed(50)',
        run: async (client) => {
          await client.setPower('cid-1', true)
          throw new Error('vesync: setMode refused')
        },
      }),
    ).rejects.toThrow(/setMode refused/)
    const failed = w.lines.find((l) => l.level === 'warn')
    expect(failed?.meta?.tags).toEqual({ deviceId: 5851 })
    await w.manager.refresh('command', [TARGET])
    expect(w.calls).toEqual(['setPower:true', 'refreshDevice:cid-1'])
    expect(w.manager.getDevice('cid-1')).toMatchObject({ power: true })
  })

  it('a poll that started before the command does not overwrite the refreshed state', async () => {
    const w = world()
    await w.manager.start()
    let release: () => void = () => undefined
    w.setPollGate(
      new Promise<void>((r) => {
        release = r
      }),
    )
    const poll = w.manager.poll()
    await w.manager.runCommand({
      ...TARGET,
      name: 'setPower(on)',
      run: (c) => c.setPower('cid-1', true),
    })
    await w.manager.refresh('command', [TARGET])
    release()
    await poll
    expect(w.manager.getDevice('cid-1')).toMatchObject({ power: true })
  })
})

describe('VeSyncIntegrationManager — one poll at a time', () => {
  it('a tick that lands while a poll runs is skipped and logged, never a second device list', async () => {
    const w = world()
    await w.manager.start()
    let release: () => void = () => undefined
    w.setPollGate(
      new Promise<void>((r) => {
        release = r
      }),
    )
    w.calls.length = 0
    w.lines.length = 0
    const first = w.manager.poll()
    const second = w.manager.poll()
    // The skipped tick answers at once; release the first before asserting.
    const secondOutcome = await Promise.race([
      second.then((): 'done' => 'done'),
      new Promise<'pending'>((r) => setTimeout(() => r('pending'), 20)),
    ])
    release()
    await first
    await second
    expect(secondOutcome).toBe('done')
    expect(w.calls.filter((c) => c === 'listDevices')).toEqual(['listDevices'])
    const skipped = w.lines.find((l) => /poll .*skipped/.test(l.message))
    expect(skipped?.level).toBe('debug')
    expect(skipped?.meta?.tags).toEqual({ accountId: 'int_1' })

    // Once the first poll is done, the next tick lists again.
    w.setPollGate(null)
    await w.manager.poll()
    expect(w.calls.filter((c) => c === 'listDevices')).toHaveLength(2)
  })
})
