import { describe, expect, it } from 'vitest'
import { buildProviderZigbeeZ2mConnectionForm } from '../provider-zigbee-z2m-instances.js'
import { Z2mManagement, parsePermitJoinSeconds, parseRename } from '../z2m-actions.js'
import { Z2mHub } from '../z2m-hub.js'
import { bridgeDevicesPayload } from './fixtures/z2m-fixtures.js'
import { FakeNet, type LogLine, ManualTimers, recordingLogger } from './fakes.js'

const DOOR = '0x00158d0001a2b3c4'

function harness(ids: readonly string[] = ['z2m-1']) {
  const hub = new Z2mHub()
  const nets = new Map<string, FakeNet>()
  for (const id of ids) {
    const net = new FakeNet()
    nets.set(id, net)
    hub.connect(id, { host: `${id}.lan`, port: 8080, tls: false, token: null }, recordingLogger(), {
      factory: net.factory,
      timers: new ManualTimers(),
    })
    net.last.open()
  }
  const lines: LogLine[] = []
  // The accept window never elapses by itself: a test lets it elapse when the update is going ahead.
  let elapse: () => void = () => {}
  const delay = (): Promise<void> => new Promise((resolve) => (elapse = resolve))
  for (const id of ids) {
    nets.get(id)?.last.push('bridge/devices', bridgeDevicesPayload)
    hub.bindDevice(id, DOOR, 7)
  }
  const management = new Z2mManagement(hub, recordingLogger(lines), delay)
  /** The server answers the last request on `topic` with `status`. */
  const answer = (id: string, topic: string, status: 'ok' | 'error', error?: string): void => {
    const net = nets.get(id)
    const sent =
      net?.last.sentEnvelopes().filter((e) => e.topic === `bridge/request/${topic}`) ?? []
    net?.last.push(`bridge/response/${topic}`, {
      data: {},
      status,
      ...(error === undefined ? {} : { error }),
      transaction: sent[sent.length - 1]?.payload['transaction'],
    })
  }
  const sentOn = (id: string, topic: string) =>
    nets
      .get(id)
      ?.last.sentEnvelopes()
      .filter((e) => e.topic === `bridge/request/${topic}`) ?? []
  return { management, answer, sentOn, lines, nets, hub, elapse: () => elapse() }
}

describe('Zigbee2MQTT management actions', () => {
  it('permit join sends a timed window and reports it; the default is a minute, 0 closes', async () => {
    const h = harness()
    const open = h.management.permitJoin({ seconds: '90' })
    expect(h.sentOn('z2m-1', 'permit_join')[0]?.payload['time']).toBe(90)
    h.answer('z2m-1', 'permit_join', 'ok')
    await expect(open).resolves.toMatchObject({ seconds: 90 })
    const dflt = h.management.permitJoin({})
    expect(h.sentOn('z2m-1', 'permit_join')[1]?.payload['time']).toBe(60)
    h.answer('z2m-1', 'permit_join', 'ok')
    await dflt
    expect(() => parsePermitJoinSeconds(255)).toThrow(/0 to 254/)
    expect(() => parsePermitJoinSeconds('soon')).toThrow(/whole number/)
    expect(parsePermitJoinSeconds('0')).toBe(0)
  })

  it('rename reads `from -> to` and sends the server rename without touching homeassistant names', async () => {
    const h = harness()
    const done = h.management.renameDevice({ rename: 'door_front -> front door' })
    expect(h.sentOn('z2m-1', 'device/rename')[0]?.payload).toMatchObject({
      from: 'door_front',
      to: 'front door',
      homeassistant_rename: false,
    })
    h.answer('z2m-1', 'device/rename', 'ok')
    await done
    expect(() => parseRename('door_front')).toThrow(/current name -> new name/)
    expect(() => parseRename(' -> x')).toThrow()
  })

  it('remove carries the force flag only when asked, and a refusal reaches the caller with the reason', async () => {
    const h = harness()
    const plain = h.management.removeDevice({ device: 'door_front' })
    expect(h.sentOn('z2m-1', 'device/remove')[0]?.payload).toMatchObject({
      id: 'door_front',
      force: false,
    })
    h.answer('z2m-1', 'device/remove', 'ok')
    await plain
    const forced = h.management.removeDevice({ device: 'door_front', force: true })
    expect(h.sentOn('z2m-1', 'device/remove')[1]?.payload).toMatchObject({ force: true })
    h.answer('z2m-1', 'device/remove', 'error', 'device did not respond')
    await expect(forced).rejects.toThrow(/did not respond/)
    await expect(h.management.removeDevice({ device: '  ' })).rejects.toThrow(/name the device/)
  })

  it('restarts the bridge', async () => {
    const h = harness()
    const done = h.management.restartBridge(undefined)
    expect(h.sentOn('z2m-1', 'restart')).toHaveLength(1)
    h.answer('z2m-1', 'restart', 'ok')
    await expect(done).resolves.toMatchObject({ message: expect.stringContaining('restarting') })
  })

  it('acts on the only open integration, and asks which one when there are several or none', async () => {
    await expect(harness([]).management.restartBridge(undefined)).rejects.toThrow(
      /no Zigbee2MQTT integration/,
    )
    const two = harness(['a', 'b'])
    await expect(two.management.restartBridge(undefined)).rejects.toThrow(/say which one/)
    const done = two.management.restartBridge({ instanceId: 'b' })
    expect(two.sentOn('b', 'restart')).toHaveLength(1)
    expect(two.sentOn('a', 'restart')).toHaveLength(0)
    two.answer('b', 'restart', 'ok')
    await done
  })

  it('the management buttons are on the form of a saved integration, not on the create form', () => {
    const keys = (id: string | null): string[] =>
      buildProviderZigbeeZ2mConnectionForm(id).sections.flatMap((s) => s.fields.map((f) => f.key))
    expect(keys(null)).not.toContain('__permit-join')
    const saved = buildProviderZigbeeZ2mConnectionForm('z2m-1')
    expect(keys('z2m-1')).toEqual(
      expect.arrayContaining(['__permit-join', '__remove-device', '__restart-bridge']),
    )
    const force = saved.sections
      .flatMap((s) => s.fields)
      .find((f) => f.key === '__remove-device-force')
    expect(force).toMatchObject({ paramsStatic: { instanceId: 'z2m-1', force: true } })
  })

  it('checks one device for firmware and reports what the server found', async () => {
    const h = harness()
    const found = h.management.checkDeviceUpdate({ device: 'door_front' })
    expect(h.sentOn('z2m-1', 'device/ota_update/check')[0]?.payload).toMatchObject({ id: DOOR })
    h.nets.get('z2m-1')?.last.push('bridge/response/device/ota_update/check', {
      data: { id: DOOR, update_available: true },
      status: 'ok',
      transaction: h.sentOn('z2m-1', 'device/ota_update/check')[0]?.payload['transaction'],
    })
    await expect(found).resolves.toMatchObject({ updateAvailable: true })
    await expect(h.management.checkDeviceUpdate({ device: 'ghost' })).rejects.toThrow(
      /does not list a device named ghost/,
    )
  })

  it('an update the server refuses at once fails the button with the reason', async () => {
    const h = harness()
    const started = h.management.updateDevice({ device: DOOR })
    h.answer('z2m-1', 'device/ota_update/update', 'error', 'no image available')
    await expect(started).rejects.toThrow(/no image available/)
  })

  it('an update that is going ahead answers once accepted, and its end is logged against the device', async () => {
    const h = harness()
    const started = h.management.updateDevice({ device: 'door_front' })
    h.elapse()
    await expect(started).resolves.toMatchObject({ message: expect.stringContaining('started') })
    h.answer('z2m-1', 'device/ota_update/update', 'error', 'device went away')
    await Promise.resolve()
    await Promise.resolve()
    const failed = h.lines.find((l) => l.message.includes('firmware update failed'))
    expect(failed?.extras).toMatchObject({ tags: { deviceId: 7 } })
  })

  it('lists the firmware state the server pushes with each device state', () => {
    const h = harness()
    h.nets.get('z2m-1')?.last.push('door_front', {
      battery: 90,
      update: {
        state: 'updating',
        progress: 42.5,
        remaining: 120,
        installed_version: 1,
        latest_version: 2,
      },
    })
    expect(h.management.deviceUpdates(undefined).devices).toEqual([
      {
        device: 'door_front',
        deviceId: 7,
        state: 'updating',
        progress: 42.5,
        remainingS: 120,
        installedVersion: 1,
        latestVersion: 2,
      },
    ])
  })
})
