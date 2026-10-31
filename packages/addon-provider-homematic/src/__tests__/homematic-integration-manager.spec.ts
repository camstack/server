import { it, expect, vi } from 'vitest'
import { HmIntegrationManager } from '../homematic-integration-manager.js'

function fakeFacade() {
  const handlers: Record<string, (arg: unknown) => void> = {}
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    devices: vi.fn().mockReturnValue([{ address: 'ABC123', name: 'Lampada' }]),
    on: (evt: string, cb: (arg: unknown) => void) => {
      handlers[evt] = cb
      return () => {
        delete handlers[evt]
      }
    },
    emit: (evt: string, arg: unknown) => handlers[evt]?.(arg),
  }
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
  withTags: vi.fn(),
}
const CONN = {
  host: 'h',
  enableHmipRf: true,
  enableBidcosRf: false,
  enableGroups: true,
  enableBidcosWired: false,
  username: '',
  password: '',
  callbackHost: '',
  callbackPort: 2128,
  tls: false,
}

it('starts the facade and reports connected, fires onConnected', async () => {
  const facade = fakeFacade()
  const onConnected = vi.fn()
  const mgr = new HmIntegrationManager({
    id: 'hm_001',
    name: 'Casa',
    connection: CONN,
    logger,
    makeFacade: () => facade,
    onConnected,
    onDisconnected: vi.fn(),
  })
  await mgr.start()
  // The real nodehomematic library emits state: 'CONNECTED' (uppercase).
  facade.emit('connection', { interfaceId: 'HmIP-RF', state: 'CONNECTED' })
  expect(facade.start).toHaveBeenCalled()
  expect(mgr.getInfo().status).toBe('connected')
  expect(onConnected).toHaveBeenCalledWith('hm_001')
  expect(mgr.facade).toBe(facade)
})

/**
 * The live broker `hm_001` sat on `connecting` for 18 minutes after a clean
 * start with 47 devices enumerated (2026-09-05). `nodehomematic` publishes
 * CONNECTED on its INTERNAL bus inside `Central.start()`, BEFORE `#subscribe()`
 * mounts the bridge to the public `connection` event, and exposes no getter
 * for the current state — so the event this manager waited for never came.
 * The test above emitted it by hand, which is exactly the fake supplying what
 * production forgets to fetch. A start that RESOLVED is the proof: the
 * library rejects `start()` when any interface fails to init.
 */
it('reports connected after a successful start even if the facade never emits `connection`', async () => {
  const facade = fakeFacade()
  const onConnected = vi.fn()
  const mgr = new HmIntegrationManager({
    id: 'hm_001',
    name: 'Casa',
    connection: CONN,
    logger,
    makeFacade: () => facade,
    onConnected,
    onDisconnected: vi.fn(),
  })
  await mgr.start()
  expect(mgr.getInfo().status).toBe('connected')
  expect(onConnected).toHaveBeenCalledWith('hm_001')
})

it('stop() disposes the facade and nulls it', async () => {
  const facade = fakeFacade()
  const mgr = new HmIntegrationManager({
    id: 'hm_001',
    name: 'Casa',
    connection: CONN,
    logger,
    makeFacade: () => facade,
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
  })
  await mgr.start()
  await mgr.stop()
  expect(facade.stop).toHaveBeenCalled()
  expect(mgr.facade).toBeNull()
})

it('getInfo reports kind homematic and the host in info', async () => {
  const facade = fakeFacade()
  const mgr = new HmIntegrationManager({
    id: 'hm_002',
    name: 'Studio',
    connection: CONN,
    logger,
    makeFacade: () => facade,
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
  })
  await mgr.start()
  const info = mgr.getInfo()
  expect(info.kind).toBe('homematic')
  expect(info.id).toBe('hm_002')
  expect((info.info as { host?: string }).host).toBe('h')
})

it('tells the devices that mirror the session about every state change', async () => {
  const facade = fakeFacade()
  const onStateChanged = vi.fn()
  const mgr = new HmIntegrationManager({
    id: 'int-1',
    name: 'Casa',
    connection: CONN,
    logger,
    makeFacade: () => facade,
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    onStateChanged,
  })
  await mgr.start()
  expect(onStateChanged).toHaveBeenCalledTimes(1)
  facade.emit('connection', { interfaceId: 'HmIP-RF', state: 'DISCONNECTED' })
  expect(mgr.getInfo().status).toBe('disconnected')
  expect(onStateChanged).toHaveBeenCalledTimes(2)
  facade.emit('error', new Error('ECONNRESET'))
  expect(mgr.getInfo().status).toBe('error')
  expect(mgr.getInfo().error).toBe('ECONNRESET')
  expect(onStateChanged).toHaveBeenCalledTimes(3)
  await mgr.stop()
  expect(onStateChanged).toHaveBeenCalledTimes(4)
})

it('applyConnection rebuilds the facade from the NEW connection', async () => {
  const seen: string[] = []
  const mgr = new HmIntegrationManager({
    id: 'int-1',
    name: 'Casa',
    connection: CONN,
    logger,
    makeFacade: (config) => {
      seen.push(config.host)
      return fakeFacade()
    },
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
  })
  await mgr.start()
  await mgr.applyConnection({ ...CONN, host: 'other-host' })
  expect(seen).toEqual(['h', 'other-host'])
  expect(mgr.getConnection().host).toBe('other-host')
})

it('warns once, tagged with the integration, when the CCU returned no device names', async () => {
  const facade = fakeFacade()
  facade.devices.mockReturnValue([{ address: 'ABC123' }, { address: 'DEF456' }])
  const warn = vi.fn()
  const mgr = new HmIntegrationManager({
    id: 'hm_names',
    name: 'Casa',
    connection: { ...CONN, username: 'Admin' },
    logger: { ...logger, warn },
    makeFacade: () => facade,
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
  })
  await mgr.start()
  const call = warn.mock.calls.find((c) => String(c[0]).includes('names unavailable'))
  expect(call?.[1]).toMatchObject({ tags: { integrationId: 'hm_names' } })
  expect(call?.[1]?.meta).toMatchObject({ credentialsSet: true, devices: 2 })
  expect(mgr.getInfo().info).toMatchObject({ namesAvailable: false })
})

it('does not warn when the devices carry names', async () => {
  const facade = fakeFacade()
  const warn = vi.fn()
  const mgr = new HmIntegrationManager({
    id: 'hm_named',
    name: 'Casa',
    connection: CONN,
    logger: { ...logger, warn },
    makeFacade: () => facade,
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
  })
  await mgr.start()
  expect(warn.mock.calls.some((c) => String(c[0]).includes('names unavailable'))).toBe(false)
  expect(mgr.getInfo().info).toMatchObject({ namesAvailable: true })
})
