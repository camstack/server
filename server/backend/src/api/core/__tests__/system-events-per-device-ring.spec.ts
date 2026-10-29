/**
 * `systemEvents.getRecent` with a device scope is answered from THAT DEVICE'S
 * ring, not by filtering the global one.
 *
 * The measured symptom this covers, end to end through the router the admin
 * UI's Events panel calls: at 16 events/s fleet-wide the global ring is a
 * 10-minute window of FLEET traffic, so a camera that spoke an hour ago has
 * been evicted by its 31 siblings and a per-device filter over that ring
 * returns nothing. `EventStream` sends `{ deviceId }` unchanged; the answer
 * now comes from the per-device ring.
 *
 * Neutralisation: drop the `filter.deviceId` branch in
 * `getBrokerEventBus().getRecent` (or `recordDeviceEvent` in `deliverShared`)
 * and the first expectation below returns 0 events.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { SystemEvent } from '@camstack/types'
import * as yaml from 'js-yaml'
import { ServiceBroker } from 'moleculer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigService } from '../../../core/config/config.service.js'
import { EventBusService } from '../../../core/events/event-bus.service.js'
import { makeCtx } from '../../../__tests__/cap-routers/harness.js'
import { createSystemEventsRouter } from '../system-events.router.js'

let seq = 0

const deviceEvent = (deviceId: number, category: string): SystemEvent => {
  seq += 1
  return {
    id: `e-${seq}`,
    timestamp: new Date(1_800_000_000_000 + seq),
    source: { type: 'device', id: deviceId, deviceId },
    category,
    data: { seq },
  }
}

/** A category with no device attribution (the old Home Assistant mirror shape). */
const unattributedEvent = (): SystemEvent => {
  seq += 1
  return {
    id: `e-${seq}`,
    timestamp: new Date(1_800_000_000_000 + seq),
    source: { type: 'addon', id: 'homeassistant' },
    category: 'broker.unattributed-sample',
    data: { brokerId: 'ha-1', subscriptionId: 's-1', key: 'sensor.x' },
  }
}

describe('systemEvents.getRecent — per-device ring', () => {
  let tmpDir = ''
  const brokers: ServiceBroker[] = []

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-devring-'))
  })

  afterEach(async () => {
    for (const b of brokers.splice(0)) await b.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const createBus = async (): Promise<EventBusService> => {
    const configPath = path.join(tmpDir, 'config.yaml')
    fs.writeFileSync(
      configPath,
      yaml.dump({ server: { port: 4443 }, auth: { adminPassword: 'secret123' } }),
      'utf-8',
    )
    const service = new EventBusService(new ConfigService(configPath))
    const broker = new ServiceBroker({
      nodeID: `devring-test-${brokers.length}`,
      transporter: 'Fake',
      logger: false,
    })
    await broker.start()
    brokers.push(broker)
    service.attachBroker(broker)
    return service
  }

  it('serves a quiet camera its history after the fleet displaced it globally', async () => {
    const eb = await createBus()
    const router = createSystemEventsRouter(eb)
    const caller = router.createCaller(makeCtx('admin'))

    for (let i = 0; i < 4; i++) eb.emit(deviceEvent(102, 'provider.detection'))
    // The rest of the fleet, enough to roll the global ring over.
    for (let i = 0; i < 1500; i++) eb.emit(deviceEvent(900 + (i % 31), 'provider.detection'))

    const scoped = await caller.getRecent({ deviceId: 102 })
    expect(scoped.length).toBe(4)
    expect(scoped.every((e) => e.source.deviceId === 102)).toBe(true)

    // The unscoped read is unchanged: still the global ring, where 102 is gone.
    const global = await caller.getRecent({})
    expect(global.filter((e) => e.source.deviceId === 102).length).toBe(0)
  })

  it('collapses the mirror categories to their latest value per camera', async () => {
    const eb = await createBus()
    const caller = createSystemEventsRouter(eb).createCaller(makeCtx('admin'))

    for (let i = 0; i < 200; i++) {
      eb.emit(deviceEvent(102, 'device.state-changed'))
      eb.emit(deviceEvent(102, 'camera-streams.onCamStreamsChanged'))
    }
    eb.emit(deviceEvent(102, 'provider.detection'))

    const scoped = await caller.getRecent({ deviceId: 102 })
    // 400 mirror emissions + 1 real event ⇒ 2 mirror slots + 1 event.
    expect(scoped.length).toBe(3)
    expect(scoped.filter((e) => e.category === 'device.state-changed').length).toBe(1)
  })

  it('never surfaces an unattributed event under a device scope', async () => {
    const eb = await createBus()
    const caller = createSystemEventsRouter(eb).createCaller(makeCtx('admin'))

    for (let i = 0; i < 5; i++) eb.emit(unattributedEvent())

    expect((await caller.getRecent({ deviceId: 102 })).length).toBe(0)
    // …and it is still there, in the global ring, for the unscoped panel.
    expect((await caller.getRecent({ category: 'broker.unattributed-sample' })).length).toBe(5)
  })
})
