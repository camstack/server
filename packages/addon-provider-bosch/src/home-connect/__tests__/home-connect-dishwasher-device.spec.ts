import {
  type ConsumablesStatus,
  DeviceType,
  type DishwasherOptions,
  type DishwasherStatus,
  type RunningStateStatus,
} from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { HomeConnectDishwasherDevice } from '../devices/home-connect-dishwasher-device.js'
import { homeConnectConnections } from '../home-connect-gateway.js'
import { makeDeviceCtx } from './device-ctx.js'
import { dishwasherCompactJson, FX, HA_ID } from './dishwasher-iddf-fixture.js'
import { makeFakeClient, type FakeHomeConnectClient } from './fake-client.js'

const BROKER = 'broker-1'
const APPLIANCE = { haId: HA_ID, name: 'Kitchen DW', type: 'Dishwasher', availablePrograms: [] }

interface DishwasherProvider {
  getStatus(): Promise<DishwasherStatus>
  getOptions(): Promise<DishwasherOptions>
  start(input: {
    program?: string
    options?: Record<string, string | number | boolean>
  }): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
  setProgram(input: { program: string }): Promise<void>
  setPower(input: { on: boolean }): Promise<void>
  setChildLock(input: { on: boolean }): Promise<void>
  setIntensiveZone(input: { on: boolean }): Promise<void>
  setOption(input: { key: string; value: string | number | boolean }): Promise<void>
}

function connect(client: FakeHomeConnectClient): void {
  homeConnectConnections.set(BROKER, { appliances: [APPLIANCE], client })
}

function liveClient(features: Record<string, unknown> = {}): FakeHomeConnectClient {
  return makeFakeClient({
    appliances: [APPLIANCE],
    description: dishwasherCompactJson(),
    features: { [HA_ID]: features },
  })
}

async function activate() {
  const t = makeDeviceCtx({
    id: 50,
    stableId: `home-connect:${BROKER}:${HA_ID}:dishwasher`,
    type: DeviceType.Dishwasher,
    parentDeviceId: 42,
    config: { haId: HA_ID, brokerId: BROKER, system: 'home-connect' },
  })
  const device = new HomeConnectDishwasherDevice(t.ctx)
  await device.onActivate()
  const provider = t.providers.get('dishwasher') as DishwasherProvider
  const slice = (): DishwasherStatus | null | undefined =>
    t.runtimeState().getCapState<DishwasherStatus>('dishwasher')
  const consumables = (): ConsumablesStatus | null | undefined =>
    t.runtimeState().getCapState<ConsumablesStatus>('consumables')
  const running = (): RunningStateStatus | null | undefined =>
    t.runtimeState().getCapState<RunningStateStatus>('running-state')
  return { t, device, provider, slice, consumables, running }
}

afterEach(() => {
  homeConnectConnections.clear()
})

describe('HomeConnectDishwasherDevice — running-state', () => {
  it('before the appliance reports a program, running is unknown — never since 0', async () => {
    const { running } = await activate()
    const rs = running()
    expect(rs?.running).toBeNull()
    expect(rs?.since).toBeNull()
    expect(rs?.since).not.toBe(0)
    if (rs?.lastFetchedAt !== null) {
      expect(rs?.lastFetchedAt).toBeGreaterThan(0)
    }
  })

  it('first Ready reading is idle with null since and a real lastFetchedAt', async () => {
    const client = liveClient({ 'BSH.Common.Status.OperationState': 'Ready' })
    connect(client)
    const { running } = await activate()
    const rs = running()
    expect(rs?.running).toBe(false)
    expect(rs?.phase).toBe('Ready')
    expect(rs?.since).toBeNull()
    expect(rs?.lastFetchedAt).toBeGreaterThan(0)
  })

  it('Run→Ready transition stamps since at the observation', async () => {
    const client = liveClient({ 'BSH.Common.Status.OperationState': 'Run' })
    connect(client)
    const { running } = await activate()
    const runStamp = running()?.lastFetchedAt ?? 0
    client.emitFeature(HA_ID, 'BSH.Common.Status.OperationState', 'Ready')
    const rs = running()
    expect(rs?.running).toBe(false)
    expect(rs?.since).toBeGreaterThan(0)
    expect(rs?.since).toBe(rs?.lastFetchedAt)
    expect(rs?.lastFetchedAt).toBeGreaterThanOrEqual(runStamp)
  })
})

describe('HomeConnectDishwasherDevice — what it publishes', () => {
  it('starts as unknown with lastFetchedAt 0 — not "now", not Ready, not all-false', async () => {
    const { slice, device } = await activate()
    const s = slice()
    expect(s?.availability).toBe('offline')
    expect(s?.lastFetchedAt).toBe(0)
    expect(s?.operationState).toBeNull()
    expect(s?.doorOpen).toBeNull()
    expect(device.online).toBe(false)
  })

  it('attaches when the client appears AFTER the device started', async () => {
    const { slice, device } = await activate()
    const client = liveClient({ 'BSH.Common.Status.OperationState': 'Run' })
    connect(client)
    expect(slice()?.operationState).toBe('Run')
    expect(slice()?.availability).toBe('available')
    expect(device.online).toBe(true)
  })

  it('follows a replaced client (integration restarted) and ignores the old one', async () => {
    const first = liveClient({ 'BSH.Common.Status.OperationState': 'Run' })
    connect(first)
    const { slice } = await activate()
    expect(slice()?.operationState).toBe('Run')

    const second = liveClient({ 'BSH.Common.Status.OperationState': 'Finished' })
    connect(second)
    expect(slice()?.operationState).toBe('Finished')

    first.emitFeature(HA_ID, 'BSH.Common.Status.OperationState', 'Pause')
    expect(slice()?.operationState).toBe('Finished')
    second.emitFeature(HA_ID, 'BSH.Common.Status.OperationState', 'Ready')
    expect(slice()?.operationState).toBe('Ready')
  })

  it('a dropped link turns the slice unavailable at once, and the device offline', async () => {
    const client = liveClient({ 'BSH.Common.Status.OperationState': 'Run' })
    connect(client)
    const { slice, device } = await activate()
    expect(slice()?.state).toBe('running')

    client.emitLink(HA_ID, 'disconnected')

    expect(slice()?.availability).toBe('offline')
    expect(slice()?.state).toBe('unavailable')
    expect(slice()?.operationState).toBeNull()
    expect(device.online).toBe(false)

    client.emitFeature(HA_ID, 'BSH.Common.Status.OperationState', 'Ready')
    client.emitLink(HA_ID, 'connected')
    expect(slice()?.availability).toBe('available')
  })

  it('lastFetchedAt moves only when a value arrives, not on a link or description event', async () => {
    const client = liveClient({})
    connect(client)
    const { slice } = await activate()
    client.emitFeature(HA_ID, 'BSH.Common.Status.OperationState', 'Run')
    const stamp = slice()?.lastFetchedAt ?? 0
    expect(stamp).toBeGreaterThan(0)
    client.description.applyChanges([{ uid: FX.halfLoad, available: false }])
    expect(slice()?.lastFetchedAt).toBe(stamp)
    // nor does a /ci or /ni field: the slice does not carry it
    client.emitFeature(HA_ID, 'HomeConnect.Network.rssi', -60)
    client.emitFeature(HA_ID, 'HomeConnect.Info.vib', 'X')
    expect(slice()?.lastFetchedAt).toBe(stamp)
  })
})

describe('HomeConnectDishwasherDevice — commands', () => {
  it('pause / resume write the command entity the description names, as true', async () => {
    const client = liveClient()
    connect(client)
    const { provider } = await activate()
    await provider.pause()
    await provider.resume()
    expect(client.setFeatureCalls).toEqual([
      { haId: HA_ID, key: 'BSH.Common.Command.PauseProgram', value: true },
      { haId: HA_ID, key: 'BSH.Common.Command.ResumeProgram', value: true },
    ])
  })

  it('refuses a command the appliance declares unavailable — and writes nothing', async () => {
    const client = liveClient()
    connect(client)
    const { provider } = await activate()
    await expect(provider.stop()).rejects.toThrow(/does not offer AbortProgram/)
    expect(client.setFeatureCalls).toEqual([])
  })

  it('start runs the SELECTED program through the active-program resource', async () => {
    const client = liveClient({
      'BSH.Common.Root.SelectedProgram': 'Dishcare.Dishwasher.Program.Auto2',
    })
    connect(client)
    const { provider } = await activate()
    await provider.start({})
    expect(client.startCalls).toEqual([
      { haId: HA_ID, program: 'Dishcare.Dishwasher.Program.Auto2', options: undefined },
    ])
    expect(client.setFeatureCalls).toEqual([]) // no value is written under a made-up command key
  })

  it('start with no program selected says so instead of guessing one', async () => {
    connect(liveClient())
    const { provider } = await activate()
    await expect(provider.start({})).rejects.toThrow(/No program is selected/)
  })

  it('start checks the program and its options against the description', async () => {
    const client = liveClient()
    connect(client)
    const { provider } = await activate()
    await expect(
      provider.start({ program: 'Dishcare.Dishwasher.Program.Quick45' }),
    ).rejects.toThrow(/not available/)
    await expect(
      provider.start({
        program: 'Dishcare.Dishwasher.Program.Eco50',
        options: { 'BSH.Common.Option.StartInRelative': 61 },
      }),
    ).rejects.toThrow(/multiple of 60/)
    expect(client.startCalls).toEqual([])
    await provider.start({
      program: 'Dishcare.Dishwasher.Program.Eco50',
      options: { 'BSH.Common.Option.StartInRelative': 3600 },
    })
    expect(client.startCalls).toHaveLength(1)
  })

  it('setProgram selects (does not start) an offered program', async () => {
    const client = liveClient()
    connect(client)
    const { provider } = await activate()
    await provider.setProgram({ program: 'Dishcare.Dishwasher.Program.Eco50' })
    expect(client.selectCalls).toEqual([
      { haId: HA_ID, program: 'Dishcare.Dishwasher.Program.Eco50', options: undefined },
    ])
    expect(client.startCalls).toEqual([])
    await expect(
      provider.setProgram({ program: 'Dishcare.Dishwasher.Program.Nope' }),
    ).rejects.toThrow(/not a program/)
  })

  it('setIntensiveZone writes whichever spelling the description declares', async () => {
    const compact = dishwasherCompactJson()
    const entities = compact['entities'] as Record<string, Record<string, unknown>>
    const zone = entities[String(FX.intensivZone)]
    if (zone) zone['name'] = 'Dishcare.Dishwasher.Option.IntensiveZone'
    const client = makeFakeClient({ appliances: [APPLIANCE], description: compact })
    connect(client)
    const { provider } = await activate()
    await provider.setIntensiveZone({ on: true })
    expect(client.setFeatureCalls).toEqual([
      { haId: HA_ID, key: 'Dishcare.Dishwasher.Option.IntensiveZone', value: true },
    ])
  })

  it('setPower picks the On / Off members of the description', async () => {
    const client = liveClient()
    connect(client)
    const { provider } = await activate()
    await provider.setPower({ on: false })
    await provider.setPower({ on: true })
    expect(client.setFeatureCalls.map((c) => c.value)).toEqual(['Off', 'On'])
  })

  it('setOption refuses out-of-range values before anything is sent', async () => {
    const client = liveClient()
    connect(client)
    const { provider } = await activate()
    await expect(
      provider.setOption({ key: 'BSH.Common.Setting.Brightness', value: 9 }),
    ).rejects.toThrow(/at most 5/)
    expect(client.setFeatureCalls).toEqual([])
    await provider.setOption({ key: 'BSH.Common.Setting.Brightness', value: 3 })
    expect(client.setFeatureCalls).toEqual([
      { haId: HA_ID, key: 'BSH.Common.Setting.Brightness', value: 3 },
    ])
  })

  it('refuses while the appliance is not connected', async () => {
    const client = liveClient()
    connect(client)
    const { provider } = await activate()
    client.emitLink(HA_ID, 'disconnected')
    await expect(provider.pause()).rejects.toThrow(/not connected/)
  })

  it('logs a failed write on the device, tagged with its deviceId', async () => {
    const client = makeFakeClient({
      appliances: [APPLIANCE],
      description: dishwasherCompactJson(),
      setFeature: async () => {
        throw new Error('appliance said no')
      },
    })
    connect(client)
    const { provider, t } = await activate()
    await expect(provider.setChildLock({ on: true })).rejects.toThrow(/appliance said no/)
    const line = t.logs.find((l) => l.level === 'warn' && /failed/.test(l.message))
    expect(line?.extras).toMatchObject({ tags: { deviceId: 50 } })
  })
})

describe('HomeConnectDishwasherDevice — getOptions', () => {
  it('answers from the live description', async () => {
    connect(liveClient())
    const { provider } = await activate()
    const options = await provider.getOptions()
    expect(options.programs.map((p) => p.key)).toContain('Dishcare.Dishwasher.Program.Eco50')
    expect(options.supportsPause).toBe(true)
    expect(options.supportsStop).toBe(false)
  })
})

describe('HomeConnectDishwasherDevice — salt and rinse aid are consumables (D915)', () => {
  it('registers the consumables cap', async () => {
    const { t } = await activate()
    expect(t.providers.has('consumables')).toBe(true)
  })

  it('publishes salt and rinse aid as supply items from the events', async () => {
    connect(liveClient({ 'Dishcare.Dishwasher.Event.SaltNearlyEmpty': 'Present' }))
    const { consumables } = await activate()
    const items = consumables()?.items ?? []
    expect(items.map((i) => [i.key, i.kind, i.status])).toEqual([
      ['salt', 'supply', 'low'],
      ['rinseAid', 'supply', null],
    ])
  })

  it('an event that clears moves the item, and a dropped link keeps the last observation', async () => {
    const client = liveClient({ 'Dishcare.Dishwasher.Event.SaltNearlyEmpty': 'Present' })
    connect(client)
    const { consumables } = await activate()
    client.emitFeature(HA_ID, 'Dishcare.Dishwasher.Event.SaltNearlyEmpty', 'Off')
    expect(consumables()?.items.find((i) => i.key === 'salt')?.status).toBe('ok')
    client.emitLink(HA_ID, 'disconnected')
    expect(consumables()?.items.find((i) => i.key === 'salt')?.status).toBe('ok')
  })

  it('refuses a reset — refilling is the reset', async () => {
    const { t } = await activate()
    const cap = t.providers.get('consumables') as { reset(i: { key: string }): Promise<void> }
    await expect(cap.reset({ key: 'salt' })).rejects.toThrow(/refill/i)
  })
})
