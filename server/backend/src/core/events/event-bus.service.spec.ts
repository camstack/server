import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as yaml from 'js-yaml'
import { ServiceBroker } from 'moleculer'
import { EventBusService } from './event-bus.service'
import { ConfigService } from '../config/config.service'
import type { ISettingsStore } from '@camstack/system'
import type { SystemEvent } from '@camstack/types'

/** Flush pending queueMicrotask callbacks */
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

const makeEvent = (category: string, overrides: Partial<SystemEvent> = {}): SystemEvent => ({
  id: `evt-${Math.random().toString(36).slice(2, 8)}`,
  timestamp: new Date(),
  source: { type: 'device', id: 'cam-1' },
  category,
  data: {},
  ...overrides,
})

/**
 * In-memory settings store used by the test to drive `ConfigService.get`
 * for the `eventBus.ringBufferSize` key. The bootstrap YAML schema does not
 * declare `eventBus`, so writing it to the YAML file would be discarded by
 * `bootstrapSchema.parse`. Wiring an ISettingsStore is the clean path to
 * feed runtime values into `ConfigService` without casts.
 */
class InMemorySettingsStore implements ISettingsStore {
  private readonly system: Record<string, unknown>

  constructor(seed: Record<string, unknown>) {
    this.system = { ...seed }
  }

  getSystem(key: string): unknown {
    return this.system[key]
  }
  setSystem(key: string, value: unknown): void {
    this.system[key] = value
  }
  getAllSystem(): Record<string, unknown> {
    return { ...this.system }
  }

  getAllAddon(_addonId: string): Record<string, unknown> {
    return {}
  }
  setAllAddon(_addonId: string, _config: Record<string, unknown>): void {
    /* no-op */
  }
  getDeviceRuntimeState(_deviceId: string): Record<string, unknown> {
    return {}
  }
  setDeviceRuntimeState(_deviceId: string, _blob: Record<string, unknown>): void {
    /* no-op */
  }
  clearDeviceRuntimeState(_deviceId: string): void {
    /* no-op */
  }
}

describe('EventBusService', () => {
  let tmpDir: string
  // Brokers spawned by `createService` — torn down in `afterEach` so
  // every test runs in isolation. The bus is a thin delegate over the
  // shared broker bus (`getBrokerEventBus(broker)`); attaching is the
  // entrypoint that wires `subscribe` / `emit` to a real implementation.
  const brokers: ServiceBroker[] = []

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-eventbus-'))
  })

  afterEach(async () => {
    for (const b of brokers.splice(0)) {
      await b.stop()
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const createService = async (bufferSize = 100): Promise<EventBusService> => {
    const configPath = path.join(tmpDir, 'config.yaml')
    fs.writeFileSync(
      configPath,
      yaml.dump({
        server: { port: 4443 },
        auth: { adminPassword: 'secret123' },
      }),
      'utf-8',
    )
    const configService = new ConfigService(configPath)
    configService.setSettingsStore(
      new InMemorySettingsStore({
        'eventBus.ringBufferSize': bufferSize,
      }),
    )
    const service = new EventBusService(configService)
    // EventBusService is a delegate that needs a broker to dispatch
    // through. Use a unique nodeID per call so each test gets its own
    // shared bus instance (`getBrokerEventBus(broker)` keys by broker).
    const broker = new ServiceBroker({
      nodeID: `eventbus-test-${brokers.length}`,
      transporter: 'Fake',
      logger: false,
    })
    await broker.start()
    brokers.push(broker)
    service.attachBroker(broker)
    return service
  }

  it('emits events to subscribers', async () => {
    const service = await createService()
    const received: SystemEvent[] = []

    service.subscribe({}, (event) => received.push(event))

    const event = makeEvent('device.online')
    service.emit(event)
    await flush()

    // The shared broker bus enriches every emit with `sourceNodeId`,
    // so the delivered object is a copy — assert key fields instead of
    // strict identity. See `addon-context-factory.ts::createSharedBus`.
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ id: event.id, category: event.category })
  })

  it('filters by category wildcard (device.* matches device.online)', async () => {
    const service = await createService()
    const received: SystemEvent[] = []

    service.subscribe({ category: 'device.*' }, (event) => received.push(event))

    service.emit(makeEvent('device.online'))
    service.emit(makeEvent('device.offline'))
    service.emit(makeEvent('addon.started'))
    await flush()

    expect(received).toHaveLength(2)

    expect(received[0]!.category).toBe('device.online')

    expect(received[1]!.category).toBe('device.offline')
  })

  it('filters by exact category', async () => {
    const service = await createService()
    const received: SystemEvent[] = []

    service.subscribe({ category: 'device.online' }, (event) => received.push(event))

    service.emit(makeEvent('device.online'))
    service.emit(makeEvent('device.offline'))
    await flush()

    expect(received).toHaveLength(1)

    expect(received[0]!.category).toBe('device.online')
  })

  it('filters by source', async () => {
    const service = await createService()
    const received: SystemEvent[] = []

    service.subscribe({ source: { type: 'addon', id: 'onvif' } }, (event) => received.push(event))

    service.emit(makeEvent('addon.started', { source: { type: 'addon', id: 'onvif' } }))
    service.emit(makeEvent('addon.started', { source: { type: 'addon', id: 'hikvision' } }))
    await flush()

    expect(received).toHaveLength(1)
  })

  it('maintains a chronological recent-events buffer', async () => {
    // Buffer size is now hub-fixed at 10000 (see `createSharedBusState`),
    // so the legacy `bufferSize=3` argument no longer caps it. The
    // contract under test today is: every emit is appended in order and
    // surfaces via `getRecent()`, oldest first.
    const service = await createService()

    service.emit(makeEvent('a'))
    service.emit(makeEvent('b'))
    service.emit(makeEvent('c'))
    service.emit(makeEvent('d'))

    const recent = service.getRecent()
    expect(recent).toHaveLength(4)
    expect(recent[0]!.category).toBe('a')
    expect(recent[3]!.category).toBe('d')
  })

  it('unsubscribe stops delivery', async () => {
    const service = await createService()
    const received: SystemEvent[] = []

    const unsubscribe = service.subscribe({}, (event) => received.push(event))

    service.emit(makeEvent('first'))
    await flush()
    unsubscribe()
    service.emit(makeEvent('second'))
    await flush()

    expect(received).toHaveLength(1)

    expect(received[0]!.category).toBe('first')
  })

  it('getRecent supports filter', async () => {
    const service = await createService()

    service.emit(makeEvent('device.online'))
    service.emit(makeEvent('addon.started'))
    service.emit(makeEvent('device.offline'))

    const recent = service.getRecent({ category: 'device.*' })
    expect(recent).toHaveLength(2)
  })
})
