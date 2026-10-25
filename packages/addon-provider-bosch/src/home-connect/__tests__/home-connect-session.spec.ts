import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { HomeConnectDescriptionStore } from '../home-connect-description-store.js'
import {
  createScriptedHomeConnectWire,
  createSilentHomeConnectWire,
} from '../home-connect-fake-wire.js'
import {
  HOME_CONNECT_INIT_RESOURCE_TIMEOUT_MS,
  HomeConnectSession,
} from '../home-connect-session.js'
import { dishwasherDescription, FX } from './dishwasher-iddf-fixture.js'

const dishwasherStore = dishwasherDescription

function recordingLogger(): { logger: IScopedLogger; warnings: string[] } {
  const warnings: string[] = []
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => {
      warnings.push(message)
    },
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, warnings }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('HomeConnectSession.connect', () => {
  it('rejects when initialValues never arrives', async () => {
    vi.useFakeTimers()
    const session = new HomeConnectSession({
      wire: createSilentHomeConnectWire(),
      description: new HomeConnectDescriptionStore(undefined),
      onFeature: () => undefined,
    })
    const connectPromise = session.connect()
    const rejection = expect(connectPromise).rejects.toThrow(/init timeout.*initialValues/i)
    await vi.advanceTimersByTimeAsync(HOME_CONNECT_INIT_RESOURCE_TIMEOUT_MS)
    await rejection
    await session.close()
  })

  it('closes the wire when the handshake fails (no half-open socket is left behind)', async () => {
    vi.useFakeTimers()
    const wire = createSilentHomeConnectWire()
    const session = new HomeConnectSession({
      wire,
      description: new HomeConnectDescriptionStore(undefined),
      onFeature: () => undefined,
    })
    const settled = session.connect().catch(() => undefined)
    await vi.advanceTimersByTimeAsync(HOME_CONNECT_INIT_RESOURCE_TIMEOUT_MS)
    await settled
    expect(wire.open).toBe(false)
  })
})

describe('HomeConnectSession wire drop', () => {
  it('reports an unsolicited close, marks itself disconnected and stops probing', async () => {
    const wire = createScriptedHomeConnectWire({ mandatoryValues: [] })
    const onClosed = vi.fn()
    const session = new HomeConnectSession({
      wire,
      description: dishwasherStore(),
      onFeature: () => undefined,
      onClosed,
      keepaliveMs: 0,
    })
    await session.connect()
    expect(session.connected).toBe(true)

    wire.dropFromAppliance()

    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(session.connected).toBe(false)
  })

  it('does not report a close it asked for itself', async () => {
    const wire = createScriptedHomeConnectWire({ mandatoryValues: [] })
    const onClosed = vi.fn()
    const session = new HomeConnectSession({
      wire,
      description: dishwasherStore(),
      onFeature: () => undefined,
      onClosed,
      keepaliveMs: 0,
    })
    await session.connect()
    await session.close()
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('tears the link down when the keepalive probe gets no answer', async () => {
    vi.useFakeTimers()
    const wire = createScriptedHomeConnectWire({ mandatoryValues: [] })
    const onClosed = vi.fn()
    const session = new HomeConnectSession({
      wire,
      description: dishwasherStore(),
      onFeature: () => undefined,
      onClosed,
      keepaliveMs: 1_000,
      requestTimeoutMs: 500,
    })
    await session.connect()
    // The appliance stops answering (a dead socket that never reports closed).
    const originalSend = wire.send.bind(wire)
    vi.spyOn(wire, 'send').mockImplementation((text) => {
      if (!text.includes('/ci/services')) originalSend(text)
    })
    await vi.advanceTimersByTimeAsync(1_000 + 500)
    // a single missed probe is not a dead link
    expect(onClosed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(session.connected).toBe(false)
  })
})

describe('HomeConnectSession commands', () => {
  async function connected(
    respondToPost?: Parameters<typeof createScriptedHomeConnectWire>[0]['respondToPost'],
  ) {
    const wire = createScriptedHomeConnectWire({ mandatoryValues: [], respondToPost })
    const features: [string, unknown][] = []
    const session = new HomeConnectSession({
      wire,
      description: dishwasherStore(),
      onFeature: (key, value) => features.push([key, value]),
      keepaliveMs: 0,
    })
    await session.connect()
    return { wire, session, features }
  }

  it('does not echo a written value: the feature changes only when the appliance reports it', async () => {
    const { wire, session, features } = await connected()
    await session.setFeatureByName('BSH.Common.Setting.ChildLock', true)
    expect(features).toEqual([])
    const post = wire.sent.find((m) => m.action === 'POST')
    expect(post?.resource).toBe('/ro/values')
    expect(post?.data).toEqual([{ uid: FX.childLock, value: true }])

    wire.pushValues([{ uid: FX.childLock, value: true }])
    expect(features).toEqual([['BSH.Common.Setting.ChildLock', true]])
  })

  it('rejects a write the appliance refuses, and changes nothing', async () => {
    const { session, features } = await connected(() => ({ code: 403 }))
    await expect(session.setFeatureByName('BSH.Common.Setting.ChildLock', true)).rejects.toThrow(
      /refused.*403/,
    )
    expect(features).toEqual([])
  })

  it('refuses a write while the link is down', async () => {
    const { wire, session } = await connected()
    wire.dropFromAppliance()
    await expect(session.setFeatureByName('BSH.Common.Setting.ChildLock', true)).rejects.toThrow(
      /not connected/,
    )
  })

  it('resolves the program entity from the IDDF: select posts the program uid to /ro/selectedProgram', async () => {
    const { wire, session } = await connected()
    await session.selectProgram('Dishcare.Dishwasher.Program.Auto2', {
      'Dishcare.Dishwasher.Option.ExtraDry': true,
    })
    const post = wire.sent.find((m) => m.resource === '/ro/selectedProgram')
    expect(post?.data).toEqual([
      { program: FX.progAuto2, options: [{ uid: FX.extraDry, value: true }] },
    ])
  })

  it('start posts to /ro/activeProgram and refuses a name that is not a program', async () => {
    const { wire, session } = await connected()
    await session.startProgram('Dishcare.Dishwasher.Program.Eco50')
    expect(wire.sent.find((m) => m.resource === '/ro/activeProgram')?.data).toEqual([
      { program: FX.progEco50 },
    ])
    await expect(session.startProgram('BSH.Common.Status.DoorState')).rejects.toThrow(
      /Unknown Home Connect program/,
    )
  })

  it('leaves no request timer behind once the response arrived', async () => {
    vi.useFakeTimers()
    const { session } = await connected()
    await session.setFeatureByName('BSH.Common.Setting.ChildLock', true)
    expect(vi.getTimerCount()).toBe(0)
    await session.close()
  })
})

describe('HomeConnectSession values', () => {
  it('decodes enum, program and plain values by the description it was given', async () => {
    const wire = createScriptedHomeConnectWire({
      mandatoryValues: [
        { uid: FX.operationState, value: 3 },
        { uid: FX.activeProgram, value: FX.progEco50 },
        { uid: FX.selectedProgram, value: 0 },
        { uid: FX.programProgress, value: 40 },
      ],
    })
    const features = new Map<string, unknown>()
    const session = new HomeConnectSession({
      wire,
      description: dishwasherStore(),
      onFeature: (key, value) => features.set(key, value),
      keepaliveMs: 0,
    })
    await session.connect()
    expect(features.get('BSH.Common.Status.OperationState')).toBe('Run')
    expect(features.get('BSH.Common.Root.ActiveProgram')).toBe('Dishcare.Dishwasher.Program.Eco50')
    expect(features.get('BSH.Common.Root.SelectedProgram')).toBeNull()
    expect(features.get('BSH.Common.Option.ProgramProgress')).toBe(40)
  })

  it('logs a uid the description does not list, once per uid, and never invents a feature', async () => {
    const { logger, warnings } = recordingLogger()
    const wire = createScriptedHomeConnectWire({ mandatoryValues: [] })
    const features: string[] = []
    const session = new HomeConnectSession({
      wire,
      description: dishwasherStore(),
      onFeature: (key) => features.push(key),
      logger,
      keepaliveMs: 0,
    })
    await session.connect()
    wire.pushValues([
      { uid: 0x7777, value: 1 },
      { uid: 0x7777, value: 2 },
      { uid: 0x7778, value: 1 },
    ])
    expect(features).toEqual([])
    expect(warnings.filter((w) => /uid the description does not list/.test(w))).toHaveLength(2)
  })

  it('counts a frame it cannot decode instead of dropping it silently', async () => {
    const { logger, warnings } = recordingLogger()
    const wire = createScriptedHomeConnectWire({ mandatoryValues: [] })
    const session = new HomeConnectSession({
      wire,
      description: dishwasherStore(),
      onFeature: () => undefined,
      logger,
      keepaliveMs: 0,
    })
    await session.connect()
    wire.pushRaw('not json')
    wire.pushRaw('{"sID":1}')
    wire.pushRaw('{"sID":1,"msgID":2,"resource":"/x","version":1,"action":"EXPLODE"}')
    const dropped = warnings.filter((w) => /undecodable/.test(w))
    // First occurrence is logged; the next ones are counted (logged again at 10).
    expect(dropped).toHaveLength(1)
    for (let i = 0; i < 7; i += 1) wire.pushRaw('garbage')
    expect(warnings.filter((w) => /undecodable/.test(w))).toHaveLength(2)
  })

  it('applies /ro/descriptionChange to the live description and tells the owner which features moved', async () => {
    const wire = createScriptedHomeConnectWire({ mandatoryValues: [] })
    const description = dishwasherStore()
    const moved: (readonly string[])[] = []
    const session = new HomeConnectSession({
      wire,
      description,
      onFeature: () => undefined,
      onDescriptionChange: (names) => moved.push(names),
      keepaliveMs: 0,
    })
    await session.connect()
    wire.pushNotify('/ro/descriptionChange', [{ uid: FX.halfLoad, available: false }])
    expect(moved).toEqual([['Dishcare.Dishwasher.Option.HalfLoad']])
    expect(description.entity(FX.halfLoad)?.available).toBe(false)
  })

  it('reads /ci/info and /ni/info and hands every scalar field on', async () => {
    const wire = createScriptedHomeConnectWire({
      mandatoryValues: [],
      ciInfo: { vib: 'SMV4HCX48E/01', brand: 'Bosch', nested: { ignored: true } },
      niInfo: { ssid: 'home', rssi: -61 },
    })
    const info: [string, unknown][] = []
    const session = new HomeConnectSession({
      wire,
      description: dishwasherStore(),
      onFeature: () => undefined,
      onInfo: (service, fields) => info.push([service, fields]),
      keepaliveMs: 0,
    })
    await session.connect()
    expect(info).toEqual([
      ['ci', { vib: 'SMV4HCX48E/01', brand: 'Bosch' }],
      ['ni', { ssid: 'home', rssi: -61 }],
    ])
  })
})
