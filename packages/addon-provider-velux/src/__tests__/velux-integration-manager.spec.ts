import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type VeluxDisconnect,
  type VeluxGatewayClient,
  type VeluxGatewayClientFactory,
  VeluxLoginRefusedError,
  type VeluxNode,
} from '../velux-client-contract.js'
import {
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  reconnectDelayMs,
  VeluxIntegrationManager,
} from '../velux-integration-manager.js'
import { RecordingLogger } from './recording-logger.js'

const NODE: VeluxNode = {
  nodeId: 3,
  serial: 'aabbccddeeff0011',
  name: 'Roof window',
  position: 40,
  targetPosition: 40,
  moving: false,
  coverClass: 'window',
  online: true,
  rainSensor: true,
  raining: false,
}

/** A scripted client whose connect outcome and pushed events the test drives. */
class ScriptedClient implements VeluxGatewayClient {
  nodes: VeluxNode[] = [NODE]
  connectError: Error | null = null
  disconnected = 0
  firmware = '0.2.0.0.71.0'
  versionError: Error | null = null
  rebooted = 0
  readonly nodeListeners = new Set<(n: VeluxNode) => void>()
  readonly dropListeners = new Set<(e: VeluxDisconnect) => void>()
  async connect(): Promise<void> {
    if (this.connectError !== null) throw this.connectError
  }
  async disconnect(): Promise<void> {
    this.disconnected += 1
  }
  listNodes(): readonly VeluxNode[] {
    return this.nodes
  }
  async readVersion(): Promise<string> {
    if (this.versionError !== null) throw this.versionError
    return this.firmware
  }
  async reboot(): Promise<void> {
    this.rebooted += 1
  }
  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async stop(): Promise<void> {}
  async setPosition(): Promise<void> {}
  onNodeChanged(l: (n: VeluxNode) => void): () => void {
    this.nodeListeners.add(l)
    return () => this.nodeListeners.delete(l)
  }
  onDisconnected(l: (e: VeluxDisconnect) => void): () => void {
    this.dropListeners.add(l)
    return () => this.dropListeners.delete(l)
  }
  push(node: VeluxNode): void {
    for (const l of this.nodeListeners) l(node)
  }
  drop(reason: string): void {
    for (const l of this.dropListeners) l({ reason })
  }
}

interface Rig {
  readonly manager: VeluxIntegrationManager
  readonly clients: ScriptedClient[]
  readonly logger: RecordingLogger
  readonly events: string[]
  readonly makeClient: ReturnType<typeof vi.fn<VeluxGatewayClientFactory>>
}

function rig(script: (client: ScriptedClient, index: number) => void = () => undefined): Rig {
  const clients: ScriptedClient[] = []
  const logger = new RecordingLogger()
  const events: string[] = []
  const makeClient = vi.fn<VeluxGatewayClientFactory>(() => {
    const client = new ScriptedClient()
    script(client, clients.length)
    clients.push(client)
    return client
  })
  const manager = new VeluxIntegrationManager({
    id: 'int-7f3a',
    name: 'KLF',
    connection: { host: '192.168.20.65', password: 'pw' },
    logger,
    onConnected: () => events.push('connected'),
    onDisconnected: () => events.push('disconnected'),
    onNodesChanged: () => events.push('nodes'),
    makeClient,
  })
  return { manager, clients, logger, events, makeClient }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('reconnect delay', () => {
  it('doubles from the base and never exceeds the cap', () => {
    expect(reconnectDelayMs(0, false)).toBe(RECONNECT_BASE_MS)
    expect(reconnectDelayMs(1, false)).toBe(RECONNECT_BASE_MS * 2)
    expect(reconnectDelayMs(2, false)).toBe(RECONNECT_BASE_MS * 4)
    expect(reconnectDelayMs(50, false)).toBe(RECONNECT_MAX_MS)
  })

  it('waits the full cap after the gateway refused the password', () => {
    expect(reconnectDelayMs(0, true)).toBe(RECONNECT_MAX_MS)
  })
})

describe('VeluxIntegrationManager', () => {
  it('connects, indexes the nodes and reports connected, with no polling', async () => {
    const r = rig()
    await r.manager.start()
    expect(r.manager.status).toBe('connected')
    expect(r.manager.getNode(3)?.name).toBe('Roof window')
    expect(r.events).toEqual(['connected', 'nodes', 'nodes'])
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(r.makeClient).toHaveBeenCalledTimes(1)
    expect(r.clients[0]?.nodes).toHaveLength(1)
  })

  it('reads the firmware after connecting and tells the devices', async () => {
    const r = rig()
    expect(r.manager.firmware).toBeNull()
    await r.manager.start()
    expect(r.manager.firmware).toBe('0.2.0.0.71.0')
    expect(r.events).toEqual(['connected', 'nodes', 'nodes'])
  })

  it('stays connected, and says why, when the gateway will not report a version', async () => {
    const r = rig((client) => {
      client.versionError = new Error('no answer to GW_GET_VERSION_REQ')
    })
    await r.manager.start()
    expect(r.manager.status).toBe('connected')
    expect(r.manager.firmware).toBeNull()
    const line = r.logger.lines.find((l) => l.message.includes('firmware version read failed'))
    expect(line?.level).toBe('warn')
    expect(line?.tags['integrationId']).toBe('int-7f3a')
  })

  it('applies a pushed node change and fans it out', async () => {
    const r = rig()
    await r.manager.start()
    r.events.length = 0
    r.clients[0]?.push({ ...NODE, position: 90 })
    expect(r.manager.getNode(3)?.position).toBe(90)
    expect(r.events).toEqual(['nodes'])
  })

  it('on a dropped session marks every node offline, logs the reason and reconnects with a fresh client', async () => {
    const r = rig()
    await r.manager.start()
    r.events.length = 0
    r.clients[0]?.drop('the gateway closed the socket (idle timeout)')
    expect(r.manager.status).toBe('disconnected')
    expect(r.manager.getNode(3)?.online).toBe(false)
    expect(r.manager.client).toBeNull()
    expect(r.events).toEqual(['nodes', 'disconnected'])
    const line = r.logger.lines.find((l) => l.message.includes('session ended'))
    expect(line?.level).toBe('warn')
    expect(JSON.stringify(line?.extras)).toContain('idle timeout')
    expect(line?.tags['integrationId']).toBe('int-7f3a')

    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS)
    expect(r.makeClient).toHaveBeenCalledTimes(2)
    expect(r.manager.status).toBe('connected')
    expect(r.manager.getNode(3)?.online).toBe(true)
    expect(r.events.at(-3)).toBe('connected')
  })

  it('keeps retrying a failing connect with growing delays, then recovers', async () => {
    const r = rig((client, index) => {
      if (index < 3) client.connectError = new Error('ECONNREFUSED')
    })
    await r.manager.start()
    expect(r.manager.status).toBe('error')
    expect(r.makeClient).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS - 1)
    expect(r.makeClient).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(r.makeClient).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS * 2)
    expect(r.makeClient).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS * 4)
    expect(r.makeClient).toHaveBeenCalledTimes(4)
    expect(r.manager.status).toBe('connected')
    const failures = r.logger.lines.filter((l) => l.message.includes('connect failed'))
    expect(failures).toHaveLength(3)
    expect(failures.every((l) => l.tags['integrationId'] === 'int-7f3a')).toBe(true)
  })

  it('backs off at the cap after a refused password and surfaces the error', async () => {
    const r = rig((client) => {
      client.connectError = new VeluxLoginRefusedError()
    })
    await r.manager.start()
    expect(r.manager.status).toBe('error')
    expect(r.manager.lastError).toContain('refused the password')
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS - 1)
    expect(r.makeClient).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(r.makeClient).toHaveBeenCalledTimes(2)
  })

  it('stop cancels a pending reconnect and closes the client without a reconnect', async () => {
    const r = rig()
    await r.manager.start()
    r.clients[0]?.drop('reset')
    await r.manager.stop()
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 2)
    expect(r.makeClient).toHaveBeenCalledTimes(1)
    expect(r.manager.status).toBe('disconnected')
  })

  it('stop closes the live client', async () => {
    const r = rig()
    await r.manager.start()
    await r.manager.stop()
    expect(r.clients[0]?.disconnected).toBe(1)
    expect(r.manager.getNodes()).toEqual([])
  })

  it('applyConnection reconnects with the new credentials', async () => {
    const r = rig()
    await r.manager.start()
    await r.manager.applyConnection({
      host: '192.168.20.66',
      password: 'other',
    })
    expect(r.makeClient).toHaveBeenCalledTimes(2)
    expect(r.makeClient.mock.calls[1]?.[0]).toMatchObject({
      host: '192.168.20.66',
      password: 'other',
    })
    expect(r.clients[0]?.disconnected).toBe(1)
  })

  it('never logs the password', async () => {
    const r = rig((client) => {
      client.connectError = new Error('boom')
    })
    await r.manager.start()
    expect(JSON.stringify(r.logger.lines)).not.toContain('"pw"')
  })
})
