import { afterEach, describe, expect, it, vi } from 'vitest'
import { RademacherClientRegistry } from '../rademacher-client-registry.js'
import {
  type RademacherClient,
  RademacherIntegrationManager,
} from '../rademacher-integration-manager.js'
import { rademacherSessions } from '../rademacher-session-resolver.js'
import { FakeHubClient, FakeHubGateway, makeCover } from './fake-hub.js'
import { RecordingLogger } from './recording-logger.js'

const CONNECTION = { host: '192.168.10.50', password: '', basePath: '', pollIntervalMs: 30_000 }

interface Rig {
  readonly manager: RademacherIntegrationManager
  readonly client: FakeHubClient
  readonly gateway: FakeHubGateway
  readonly logger: RecordingLogger
  readonly events: string[]
}

function rig(reconnectBaseMs = 10): Rig {
  const gateway = new FakeHubGateway()
  const client = new FakeHubClient([makeCover(gateway, '7', 'Salotto')])
  const logger = new RecordingLogger()
  const events: string[] = []
  const manager = new RademacherIntegrationManager({
    id: 'int-1',
    name: 'Casa',
    connection: CONNECTION,
    logger,
    onConnected: () => events.push('connected'),
    onDisconnected: () => events.push('disconnected'),
    onPolled: () => events.push('polled'),
    makeClient: () => client,
    reconnectBaseMs,
  })
  return { manager, client, gateway, logger, events }
}

const running: RademacherIntegrationManager[] = []

afterEach(async () => {
  for (const m of running.splice(0)) await m.stop()
  rademacherSessions.clear()
})

describe('RademacherIntegrationManager', () => {
  it('connects, materialises the covers and reads the hub identity', async () => {
    const r = rig()
    running.push(r.manager)
    await r.manager.start()
    expect(r.manager.status).toBe('connected')
    expect(r.manager.getCovers().map((c) => c.did)).toEqual(['7'])
    expect(r.manager.getCover('7')?.name).toBe('Salotto')
    expect(r.manager.identity?.firmware).toBe('5.5.1')
    expect(r.events).toEqual(['connected', 'polled'])
  })

  it('never throws on a failed connect: it logs, and retries until the hub is back', async () => {
    const r = rig(5)
    running.push(r.manager)
    r.client.connectError = new Error('ECONNREFUSED')
    await expect(r.manager.start()).resolves.toBeUndefined()
    expect(r.manager.status).toBe('error')
    expect(r.manager.lastError).toContain('ECONNREFUSED')
    const refusal = r.logger.lines.find((l) => l.message.includes('connect failed'))
    expect(refusal?.level).toBe('warn')
    expect(refusal?.tags['integrationId']).toBe('int-1')
    // the hub comes back: the retry connects without anyone restarting the addon
    r.client.connectError = null
    await vi.waitFor(() => expect(r.manager.status).toBe('connected'), { timeout: 2000 })
    expect(r.manager.getCovers()).toHaveLength(1)
    expect(r.events).toContain('connected')
  })

  it('stop() cancels a pending retry', async () => {
    const r = rig(20)
    r.client.connectError = new Error('down')
    await r.manager.start()
    const attempts = r.client.connects
    await r.manager.stop()
    r.client.connectError = null
    await new Promise((res) => setTimeout(res, 80))
    expect(r.client.connects).toBe(attempts)
    expect(r.manager.status).toBe('disconnected')
  })

  it('marks the session down when every device refresh fails, and up again on the first success', async () => {
    const r = rig()
    running.push(r.manager)
    await r.manager.start()
    r.events.length = 0
    r.gateway.failing = true
    await r.manager.poll()
    expect(r.manager.status).toBe('error')
    expect(r.events).toEqual(['disconnected', 'polled'])
    const warn = r.logger.lines.find((l) => l.message.includes('stopped answering'))
    expect(warn?.level).toBe('warn')
    // a second failing cycle does not repeat the transition
    await r.manager.poll()
    expect(r.events.filter((e) => e === 'disconnected')).toHaveLength(1)
    r.gateway.failing = false
    await r.manager.poll()
    expect(r.manager.status).toBe('connected')
    expect(r.events.filter((e) => e === 'connected')).toHaveLength(1)
  })

  it('applyConnection rebuilds the client from the new connection', async () => {
    const seen: string[] = []
    const gateway = new FakeHubGateway()
    const manager = new RademacherIntegrationManager({
      id: 'int-1',
      name: 'Casa',
      connection: CONNECTION,
      logger: new RecordingLogger(),
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: () => undefined,
      makeClient: (connection): RademacherClient => {
        seen.push(connection.host)
        return new FakeHubClient([makeCover(gateway, '7', 'Salotto')])
      },
    })
    running.push(manager)
    await manager.start()
    await manager.applyConnection({ ...CONNECTION, host: '10.0.0.9' }, 'Nuova')
    expect(seen).toEqual(['192.168.10.50', '10.0.0.9'])
    expect(manager.name).toBe('Nuova')
    expect(manager.status).toBe('connected')
  })
})

describe('RademacherClientRegistry', () => {
  function registry() {
    const gateway = new FakeHubGateway()
    const built: string[] = []
    const reg = new RademacherClientRegistry(new RecordingLogger(), {
      makeClient: (connection) => {
        built.push(connection.host)
        return new FakeHubClient([makeCover(gateway, '7', 'Salotto')])
      },
    })
    return { reg, built }
  }

  it('opens one session per integration and publishes it to the devices', async () => {
    const { reg, built } = registry()
    await reg.upsert('a', 'Casa', CONNECTION)
    await reg.upsert('b', 'Garage', { ...CONNECTION, host: '10.0.0.7' })
    expect(built).toEqual(['192.168.10.50', '10.0.0.7'])
    expect(rademacherSessions.getCover('a', '7')?.name).toBe('Salotto')
    expect(rademacherSessions.getCover('c', '7')).toBeNull()
    expect(reg.getName('a')).toBe('Casa')
    await reg.shutdown()
    expect(rademacherSessions.getManager('a')).toBeNull()
  })

  it('reconnects only when the connection changed', async () => {
    const { reg, built } = registry()
    await reg.upsert('a', 'Casa', CONNECTION)
    await reg.upsert('a', 'Casa bis', CONNECTION)
    expect(built).toHaveLength(1)
    expect(reg.getName('a')).toBe('Casa bis')
    await reg.upsert('a', 'Casa bis', { ...CONNECTION, password: 'new' })
    expect(built).toHaveLength(2)
    await reg.shutdown()
  })

  it('retain drops a session whose integration went away', async () => {
    const { reg } = registry()
    await reg.upsert('a', 'Casa', CONNECTION)
    await reg.upsert('b', 'Garage', CONNECTION)
    await reg.retain(new Set(['b']))
    expect(reg.list()).toEqual(['b'])
    expect(rademacherSessions.getManager('a')).toBeNull()
    await reg.shutdown()
  })
})
