import type { PowerSourceActionResult } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VeluxDisconnect, VeluxGatewayClient } from '../velux-client-contract.js'
import { VeluxIntegrationManager } from '../velux-integration-manager.js'
import {
  GATEWAY_BOOT_MS,
  type GatewayDeviceLookup,
  type PowerCycleStore,
  type PowerSourcePort,
  RECOVERY_COOLDOWN_MS,
  RECOVERY_UNREACHABLE_MS,
} from '../velux-power-recovery.js'
import { RecordingLogger } from './recording-logger.js'

const GATEWAY_DEVICE = 41

class DeadClient implements VeluxGatewayClient {
  static failWith: Error | null = new Error('connect ECONNREFUSED 192.168.20.65:51200')
  dropListeners = new Set<(e: VeluxDisconnect) => void>()
  async connect(): Promise<void> {
    if (DeadClient.failWith !== null) throw DeadClient.failWith
  }
  async disconnect(): Promise<void> {}
  listNodes() {
    return []
  }
  async readVersion(): Promise<string> {
    return '0.2.0.0.71.0'
  }
  async reboot(): Promise<void> {}
  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async stop(): Promise<void> {}
  async setPosition(): Promise<void> {}
  onNodeChanged(): () => void {
    return () => undefined
  }
  onDisconnected(l: (e: VeluxDisconnect) => void): () => void {
    this.dropListeners.add(l)
    return () => this.dropListeners.delete(l)
  }
}

class FakePowerSource implements PowerSourcePort {
  linked = true
  statusError: Error | null = null
  restartError: Error | null = null
  restartResult: PowerSourceActionResult = { accepted: true }
  gatewayId: number | null = GATEWAY_DEVICE
  statusCalls = 0
  restarts: number[] = []
  lookupError: string | null = null
  lookups = 0
  async gatewayDevice(): Promise<GatewayDeviceLookup> {
    this.lookups += 1
    if (this.lookupError !== null) return { kind: 'unknown', error: this.lookupError }
    return this.gatewayId === null
      ? { kind: 'missing' }
      : { kind: 'found', deviceId: this.gatewayId }
  }
  /** When set, the answer is this value verbatim (a wrong-shaped provider answer). */
  rawStatus: unknown = undefined
  async getStatus(): Promise<unknown> {
    this.statusCalls += 1
    if (this.statusError !== null) throw this.statusError
    if (this.rawStatus !== undefined) return this.rawStatus
    return {
      linked: this.linked,
      switchDeviceId: this.linked ? 7 : null,
      switchName: this.linked ? 'Plug' : null,
      switchOn: this.linked ? true : null,
      switchOnline: this.linked ? true : null,
      restartInProgress: false,
      offSeconds: 10,
    }
  }
  async forceRestart(deviceId: number): Promise<PowerSourceActionResult> {
    this.restarts.push(deviceId)
    if (this.restartError !== null) throw this.restartError
    return this.restartResult
  }
}

class MemoryStore implements PowerCycleStore {
  at: number | null = null
  async read(): Promise<number | null> {
    return this.at
  }
  async write(_id: string, at: number): Promise<void> {
    this.at = at
  }
}

function build(source: FakePowerSource | undefined, store: MemoryStore) {
  const logger = new RecordingLogger()
  const manager = new VeluxIntegrationManager({
    id: 'int-7f3a',
    name: 'KLF',
    connection: { host: '192.168.20.65', password: 'pw' },
    logger,
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    onNodesChanged: () => undefined,
    makeClient: () => new DeadClient(),
    ...(source === undefined ? {} : { powerSource: source }),
    powerCycleStore: store,
  })
  return { manager, logger }
}

beforeEach(() => {
  vi.useFakeTimers()
  DeadClient.failWith = new Error('connect ECONNREFUSED 192.168.20.65:51200')
})
afterEach(() => {
  vi.useRealTimers()
})

describe('gateway recovery through the power-source link', () => {
  it('restarts only after the gateway was unreachable for the threshold, then reconnects', async () => {
    const source = new FakePowerSource()
    const { manager, logger } = build(source, new MemoryStore())
    await manager.start()
    await vi.advanceTimersByTimeAsync(RECOVERY_UNREACHABLE_MS - 60_000)
    expect(source.restarts).toEqual([])
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(source.restarts).toEqual([GATEWAY_DEVICE])
    expect(manager.lastRecovery?.outcome === undefined).toBe(false)
    DeadClient.failWith = null
    await vi.advanceTimersByTimeAsync(GATEWAY_BOOT_MS)
    expect(manager.status).toBe('connected')
    expect(manager.lastRecovery?.outcome).toBe('restarted')
    const line = logger.lines.find((l) => l.message.includes('restarting its power source'))
    expect(line?.tags).toMatchObject({ integrationId: 'int-7f3a', deviceId: GATEWAY_DEVICE })
    await manager.stop()
  })

  it('keeps the cooldown across a respawn', async () => {
    const store = new MemoryStore()
    const first = new FakePowerSource()
    const a = build(first, store)
    await a.manager.start()
    await vi.advanceTimersByTimeAsync(RECOVERY_UNREACHABLE_MS + 5 * 60_000)
    expect(first.restarts).toHaveLength(1)
    await a.manager.stop()
    // A respawned addon: a new manager and a new recovery, the same persisted store.
    const second = new FakePowerSource()
    const b = build(second, store)
    await b.manager.start()
    await vi.advanceTimersByTimeAsync(RECOVERY_UNREACHABLE_MS + 5 * 60_000)
    expect(second.restarts).toEqual([])
    expect(b.logger.lines.some((l) => l.message.includes('power restart skipped'))).toBe(true)
    await vi.advanceTimersByTimeAsync(RECOVERY_COOLDOWN_MS)
    expect(second.restarts).toHaveLength(1)
    await b.manager.stop()
  })

  it('never restarts while a session is live', async () => {
    const source = new FakePowerSource()
    DeadClient.failWith = null
    const { manager } = build(source, new MemoryStore())
    await manager.start()
    await vi.advanceTimersByTimeAsync(RECOVERY_UNREACHABLE_MS * 3)
    expect(manager.status).toBe('connected')
    expect(source.restarts).toEqual([])
    expect(source.statusCalls).toBe(0)
    await manager.stop()
  })

  it('does not count a wrong password as unreachable', async () => {
    const { VeluxLoginRefusedError } = await import('../velux-client-contract.js')
    DeadClient.failWith = new VeluxLoginRefusedError()
    const source = new FakePowerSource()
    const { manager } = build(source, new MemoryStore())
    await manager.start()
    await vi.advanceTimersByTimeAsync(RECOVERY_UNREACHABLE_MS * 2)
    expect(source.restarts).toEqual([])
    await manager.stop()
  })

  it('skips with one log line per window when no power source is linked or the status fails', async () => {
    const source = new FakePowerSource()
    source.linked = false
    const { manager, logger } = build(source, new MemoryStore())
    await manager.start()
    await vi.advanceTimersByTimeAsync(RECOVERY_UNREACHABLE_MS + 20 * 60_000)
    expect(source.restarts).toEqual([])
    expect(
      logger.lines.filter((l) => l.message.includes('has no power source link stored')),
    ).toHaveLength(1)
    await manager.stop()

    const broken = new FakePowerSource()
    broken.statusError = new Error('capability unavailable')
    const b = build(broken, new MemoryStore())
    await b.manager.start()
    await vi.advanceTimersByTimeAsync(RECOVERY_UNREACHABLE_MS + 20 * 60_000)
    expect(broken.restarts).toEqual([])
    expect(b.logger.lines.filter((l) => l.message.includes('capability unavailable'))).toHaveLength(
      1,
    )
    await b.manager.stop()
  })

  it('without any power-source port it only logs', async () => {
    const { manager, logger } = build(undefined, new MemoryStore())
    await manager.start()
    await vi.advanceTimersByTimeAsync(RECOVERY_UNREACHABLE_MS + 5 * 60_000)
    expect(
      logger.lines.some((l) => l.message.includes('power-source capability is unavailable')),
    ).toBe(true)
    await manager.stop()
  })

  it('a status that is not a PowerSourceInfo is skipped as status-unparseable, naming the shape, never as unlinked', async () => {
    const source = new FakePowerSource()
    // The composer-slice shape a graft once answered with.
    source.rawStatus = { switchOn: true, offSeconds: 10, lastFetchedAt: 1 }
    const { manager, logger } = build(source, new MemoryStore())
    await manager.start()
    await vi.advanceTimersByTimeAsync(RECOVERY_UNREACHABLE_MS + 20 * 60_000)
    expect(source.restarts).toEqual([])
    const lines = logger.lines.filter((l) => l.message.includes('not a PowerSourceInfo'))
    expect(lines).toHaveLength(1)
    expect(lines[0]?.message).toContain('switchOn,offSeconds,lastFetchedAt')
    expect(logger.lines.some((l) => l.message.includes('no power source link stored'))).toBe(false)
    await manager.stop()
  })

  it('logs a refusal with its reason and counts it for the cooldown', async () => {
    const source = new FakePowerSource()
    source.restartResult = {
      accepted: false,
      reason: 'switch-offline',
      message: 'Presa Velux is offline',
    }
    const { manager, logger } = build(source, new MemoryStore())
    await manager.start()
    await vi.advanceTimersByTimeAsync(RECOVERY_UNREACHABLE_MS + 5 * 60_000)
    expect(source.restarts).toHaveLength(1)
    const line = logger.lines.find((l) => l.message.includes('power restart refused'))
    expect(line?.extras?.meta).toMatchObject({ reason: 'switch-offline' })
    expect(manager.lastRecovery?.outcome).toBe('refused')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(source.restarts).toHaveLength(1)
    await manager.stop()
  })

  it('logs a thrown restart and does not retry inside the cooldown', async () => {
    const source = new FakePowerSource()
    source.restartError = new Error('hub unreachable')
    const { manager, logger } = build(source, new MemoryStore())
    await manager.start()
    await vi.advanceTimersByTimeAsync(RECOVERY_UNREACHABLE_MS + 5 * 60_000)
    expect(logger.lines.some((l) => l.message.includes('power restart failed'))).toBe(true)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(source.restarts).toHaveLength(1)
    await manager.stop()
  })

  it('says the lookup failed, not that the gateway is not adopted, and tries again later', async () => {
    const source = new FakePowerSource()
    source.lookupError = 'loadConfig timed out'
    const { manager, logger } = build(source, new MemoryStore())
    await manager.start()
    await vi.advanceTimersByTimeAsync(RECOVERY_UNREACHABLE_MS + 5 * 60_000)
    expect(source.restarts).toEqual([])
    expect(
      logger.lines.some((l) =>
        l.message.includes('gateway device lookup failed: loadConfig timed out'),
      ),
    ).toBe(true)
    expect(logger.lines.some((l) => l.message.includes('not adopted'))).toBe(false)
    source.lookupError = null
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(source.restarts).toEqual([GATEWAY_DEVICE])
    await manager.stop()
  })

  it('answers the cooldown before any call, and caches the gateway device id', async () => {
    const store = new MemoryStore()
    store.at = Date.now()
    const source = new FakePowerSource()
    const { manager } = build(source, store)
    await manager.start()
    await vi.advanceTimersByTimeAsync(RECOVERY_UNREACHABLE_MS + 5 * 60_000)
    expect(source.lookups).toBe(0)
    expect(source.statusCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(RECOVERY_COOLDOWN_MS)
    expect(source.restarts).toHaveLength(1)
    expect(source.lookups).toBe(1)
    await manager.stop()
  })

  it('cuts the boot wait short on stop, and recovers again after the cooldown', async () => {
    const source = new FakePowerSource()
    const { manager } = build(source, new MemoryStore())
    await manager.start()
    // The restart fires at the failure at 810 s; the boot wait ends 90 s later.
    await vi.advanceTimersByTimeAsync(815_000)
    expect(source.restarts).toHaveLength(1)
    // Inside the 90 s boot wait.
    await vi.advanceTimersByTimeAsync(10_000)
    await manager.stop()
    expect(vi.getTimerCount()).toBe(0)
    await manager.start()
    await vi.advanceTimersByTimeAsync(RECOVERY_COOLDOWN_MS + RECOVERY_UNREACHABLE_MS + 5 * 60_000)
    expect(source.restarts).toHaveLength(2)
    await manager.stop()
  })
})
