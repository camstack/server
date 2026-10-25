import { DeviceType, EventCategory, type EventEmitterStatus } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { HomeConnectEventDevice } from '../devices/home-connect-event-device.js'
import { homeConnectConnections } from '../home-connect-gateway.js'
import { makeDeviceCtx } from './device-ctx.js'
import { dishwasherCompactJson, HA_ID } from './dishwasher-iddf-fixture.js'
import { makeFakeClient, type FakeHomeConnectClient } from './fake-client.js'

const BROKER = 'broker-1'
const APPLIANCE = { haId: HA_ID, name: 'Kitchen DW', type: 'Dishwasher', availablePrograms: [] }
const FINISHED = 'BSH.Common.Event.ProgramFinished'
const SALT = 'Dishcare.Dishwasher.Event.SaltNearlyEmpty'

async function activate(client: FakeHomeConnectClient) {
  homeConnectConnections.set(BROKER, { appliances: [APPLIANCE], client })
  const t = makeDeviceCtx({
    id: 70,
    stableId: `home-connect:${BROKER}:${HA_ID}:events`,
    type: DeviceType.EventEmitter,
    parentDeviceId: 42,
    config: { haId: HA_ID, brokerId: BROKER, system: 'home-connect' },
  })
  const device = new HomeConnectEventDevice(t.ctx)
  await device.onActivate()
  const slice = () => t.runtimeState().getCapState<EventEmitterStatus>('event-emitter')
  return { t, device, slice }
}

function client(features: Record<string, unknown> = {}) {
  return makeFakeClient({
    appliances: [APPLIANCE],
    description: dishwasherCompactJson(),
    features: { [HA_ID]: features },
    link: 'connected',
  })
}

afterEach(() => {
  homeConnectConnections.clear()
})

describe('HomeConnectEventDevice', () => {
  it('advertises the event vocabulary of the description, verbatim', async () => {
    const { slice } = await activate(client())
    expect(slice()?.eventTypes.sort()).toEqual(
      [
        'BSH.Common.Event.ProgramAborted',
        'BSH.Common.Event.ProgramFinished',
        'Dishcare.Dishwasher.Event.RinseAidLack',
        'Dishcare.Dishwasher.Event.RinseAidNearlyEmpty',
        'Dishcare.Dishwasher.Event.SaltLack',
        'Dishcare.Dishwasher.Event.SaltNearlyEmpty',
      ].sort(),
    )
  })

  it('fires when an event is raised, with its level and handling, and counts it', async () => {
    const c = client()
    const { slice, t } = await activate(c)
    c.emitFeature(HA_ID, FINISHED, 'Present')
    expect(slice()?.lastEvent).toMatchObject({
      eventType: FINISHED,
      deviceId: 70,
      data: { value: 'Present', level: 'info', handling: 'acknowledge' },
    })
    expect(slice()?.eventCountSinceStart).toBe(1)
    const fired = t.emitted.filter(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        'category' in e &&
        e.category === EventCategory.EventEmitted,
    )
    expect(fired).toHaveLength(1)
  })

  it('Present -> Confirmed is the same occurrence, not a second event', async () => {
    const c = client()
    const { slice } = await activate(c)
    c.emitFeature(HA_ID, SALT, 'Present')
    c.emitFeature(HA_ID, SALT, 'Confirmed')
    expect(slice()?.eventCountSinceStart).toBe(1)
    c.emitFeature(HA_ID, SALT, 'Off')
    c.emitFeature(HA_ID, SALT, 'Present')
    expect(slice()?.eventCountSinceStart).toBe(2)
  })

  it('an event already raised when the link comes up is the baseline, not news — and stays quiet after a reconnect', async () => {
    const c = makeFakeClient({
      appliances: [APPLIANCE],
      description: dishwasherCompactJson(),
      link: 'connecting',
    })
    const { slice } = await activate(c)
    // handshake delivers the standing condition while the link is still connecting
    c.emitFeature(HA_ID, SALT, 'Present')
    c.emitLink(HA_ID, 'connected')
    expect(slice()?.eventCountSinceStart).toBe(0)
    // the link drops and returns; the condition is delivered again during the handshake
    c.emitLink(HA_ID, 'disconnected')
    c.emitLink(HA_ID, 'connecting')
    c.emitFeature(HA_ID, SALT, 'Present')
    c.emitLink(HA_ID, 'connected')
    expect(slice()?.eventCountSinceStart).toBe(0)
  })

  it('goes offline with the link', async () => {
    const c = client()
    const { device } = await activate(c)
    c.emitLink(HA_ID, 'disconnected')
    expect(device.online).toBe(false)
  })
})
