/**
 * D673 through the whole orchestrator: a raw camera push enters on
 * ProviderMotion, the bridge decides, and session dispatch sees only the
 * effective stream (C7, C12, C13).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MIN_SESSION_OPEN_MS } from '../session-dispatch-controller.js'
import { createEvent, EventCategory } from '@camstack/types'
import { type CameraSensorsWire, wireCameraSensors } from './camera-sensors-harness.js'

const CAM = 103
const PIR = { addonId: 'provider-homeassistant', stableId: 'ha:porch-pir' }
let wire: CameraSensorsWire | null = null
afterEach(() => {
  wire?.teardown()
  wire = null
  vi.useRealTimers()
})

describe('ProviderMotion → the effective onboard stream (D673)', () => {
  it('a camera with no attached sensor: the raw push becomes the onboard event, named camera, and opens the session', async () => {
    wire = await wireCameraSensors(null)
    wire.emitRaw(CAM, true)
    await wire.dispatch.settle()
    expect(wire.onboardOnBus().map((e) => [e.detected, e.triggeredBy])).toEqual([
      [true, { kind: 'camera' }],
    ])
    expect(wire.dispatch.dispatched(CAM)).toBe(true)
  })

  it('Replace: the camera`s own push reaches nobody — no onboard event, no session', async () => {
    wire = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'replace' }] })
    wire.emitRaw(CAM, true)
    await wire.dispatch.settle()
    expect(wire.onboardOnBus()).toEqual([])
    expect(wire.dispatch.dispatched(CAM)).toBe(false)
    expect(wire.lines.some((l) => l.message === 'camera-sensors: camera motion not counted')).toBe(
      true,
    )
  })

  it('an unsplit provider`s direct emit is forwarded to the session as before, not re-emitted, and the status says Replace is not enforced', async () => {
    wire = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'replace' }] })
    wire.emitDirect(CAM, true)
    await wire.dispatch.settle()
    expect(wire.onboardOnBus()).toHaveLength(1)
    expect(wire.dispatch.dispatched(CAM)).toBe(true)
    expect(wire.controller.statusFor(CAM)).toMatchObject({
      state: 'configured',
      notEnforced: 'provider-not-split',
    })
  })

  it('a provider rolled forward (a ProviderMotion push arrives) clears the unsplit mark: the status stops saying provider-not-split', async () => {
    wire = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'replace' }] })
    wire.emitDirect(CAM, true)
    expect(wire.controller.statusFor(CAM)).toMatchObject({ notEnforced: 'provider-not-split' })
    wire.emitRaw(CAM, true)
    await wire.dispatch.settle()
    expect(wire.controller.statusFor(CAM)).not.toMatchObject({ notEnforced: 'provider-not-split' })
  })

  it('the CS-1 hold is gone: the camera clear while the PIR is high never reaches the bus', async () => {
    wire = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'in-addition' }] })
    wire.emitRaw(CAM, true)
    wire.raisePir(true)
    wire.emitRaw(CAM, false)
    await wire.dispatch.settle()
    expect(wire.onboardOnBus().filter((e) => !e.detected)).toEqual([])
    expect(wire.dispatch.open(CAM)).toBe(true)
  })
})

describe('fail open (C7): the push is never lost to a config that is not there', () => {
  it('the camera`s config has not loaded yet: a raw push still produces the effective event', async () => {
    wire = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'replace' }] }, { skipBoot: true })
    wire.emitRaw(CAM, true)
    await wire.dispatch.settle()
    expect(wire.onboardOnBus().map((e) => [e.detected, e.triggeredBy])).toEqual([
      [true, { kind: 'camera' }],
    ])
    expect(wire.dispatch.dispatched(CAM)).toBe(true)
  })

  it('settings unreadable with no prior: a raw push still produces the effective event', async () => {
    wire = await wireCameraSensors(null, {
      readSetting: async () => ({ state: 'unreadable', reason: 'settings read failed' }),
    })
    expect(wire.controller.statusFor(CAM)).toMatchObject({ state: 'unreadable' })
    wire.emitRaw(CAM, true)
    await wire.dispatch.settle()
    expect(wire.onboardOnBus().map((e) => [e.detected, e.triggeredBy])).toEqual([
      [true, { kind: 'camera' }],
    ])
    expect(wire.dispatch.dispatched(CAM)).toBe(true)
  })
})

describe('an unsplit provider is the RAW absent triggeredBy, never provenance (C13)', () => {
  it('an onboard event that HAS triggeredBy never notes a direct camera level', async () => {
    wire = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'replace' }] })
    const noted = vi.spyOn(wire.controller, 'noteDirectCameraMotion')
    wire.bus.emit(
      createEvent(
        EventCategory.MotionOnMotionChanged,
        { type: 'device', id: CAM, deviceId: CAM },
        {
          deviceId: CAM,
          detected: true,
          timestamp: Date.now(),
          source: 'onboard',
          triggeredBy: { kind: 'camera' },
        },
      ),
    )
    await wire.dispatch.settle()
    expect(noted).not.toHaveBeenCalled()
    expect(wire.controller.statusFor(CAM)).not.toHaveProperty('notEnforced')
    // The same event WITHOUT triggeredBy is the unsplit provider.
    wire.emitDirect(CAM, true)
    expect(noted).toHaveBeenCalledExactlyOnceWith(CAM, true)
  })

  it('a bridge emit (it always names a trigger) is not an unsplit provider', async () => {
    wire = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'confirm' }] })
    const noted = vi.spyOn(wire.controller, 'noteDirectCameraMotion')
    wire.raisePir(true)
    wire.emitRaw(CAM, true)
    await wire.dispatch.settle()
    expect(wire.onboardOnBus().length).toBeGreaterThan(0)
    expect(noted).not.toHaveBeenCalled()
    expect(wire.controller.statusFor(CAM)).not.toHaveProperty('notEnforced')
  })
})

describe('what travels on the wire', () => {
  it('regions travel end to end: raw push → effective event', async () => {
    wire = await wireCameraSensors(null)
    const regions = [{ bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, pixelCount: 120, intensity: 0.5 }]
    wire.emitRaw(CAM, true, regions)
    expect(wire.onboardOnBus()[0]?.regions).toEqual(regions)
  })

  it('a push that is not an onboard camera push is said and dropped, naming the camera', async () => {
    wire = await wireCameraSensors(null)
    wire.bus.emit(
      createEvent(
        EventCategory.ProviderMotion,
        { type: 'device', id: CAM, deviceId: CAM },
        { deviceId: CAM, detected: true, timestamp: Date.now(), source: 'analyzer' },
      ),
    )
    // A payload that does not parse: the typed builder refuses it, so the raw envelope is emitted.
    wire.bus.emit({
      id: 'evt-malformed-provider-motion',
      timestamp: new Date(),
      source: { type: 'device', id: CAM },
      category: EventCategory.ProviderMotion,
      data: { deviceId: CAM, detected: 'yes', source: 'onboard' },
    })
    expect(wire.onboardOnBus()).toEqual([])
    const dropped = wire.lines.filter(
      (l) => l.message === 'provider motion dropped — not an onboard camera push',
    )
    expect(dropped.map((l) => [l.level, l.deviceId, l.meta?.['reason']])).toEqual([
      ['warn', CAM, 'not-onboard'],
      ['warn', CAM, 'malformed'],
    ])
  })
})

describe('a respawned bridge: sessions die with the process, the camera clear still reaches the exports', () => {
  it('after a respawn the camera`s clear passes through, so motion cannot stick high', async () => {
    const before = await wireCameraSensors(null)
    before.emitRaw(CAM, true)
    expect(before.onboardOnBus().map((e) => e.detected)).toEqual([true])
    before.teardown()
    // The respawned orchestrator: a NEW bridge, no memory of the emitted true.
    wire = await wireCameraSensors(null)
    wire.emitRaw(CAM, false)
    expect(wire.onboardOnBus().map((e) => [e.detected, e.triggeredBy])).toEqual([
      [false, { kind: 'camera' }],
    ])
  })

  it('…also with a sensor attached: a clear this instance never saw the rise of passes through, so HA export and Alexa cannot stick high (review H2)', async () => {
    const before = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'in-addition' }] })
    before.emitRaw(CAM, true)
    before.teardown()
    wire = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'in-addition' }] })
    wire.emitRaw(CAM, false)
    await wire.dispatch.settle()
    expect(wire.onboardOnBus().map((e) => [e.detected, e.triggeredBy])).toEqual([
      [false, { kind: 'camera' }],
    ])
    expect(wire.dispatch.open(CAM)).toBe(false)
    expect(
      wire.lines.filter(
        (l) =>
          l.message === 'camera-sensors: camera clear passed — this instance never saw its rise' &&
          l.deviceId === CAM,
      ),
    ).toHaveLength(1)
  })

  it('a clear for a camera whose rise WAS seen is not passed on while a sensor holds it', async () => {
    wire = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'in-addition' }] })
    wire.emitRaw(CAM, true)
    wire.raisePir(true)
    wire.emitRaw(CAM, false)
    expect(wire.onboardOnBus().filter((e) => !e.detected)).toEqual([])
    expect(
      wire.lines.some(
        (l) =>
          l.message === 'camera-sensors: camera clear passed — this instance never saw its rise',
      ),
    ).toBe(false)
  })

  it('after a respawn, the first camera clear is NOT passed on while a freshly risen sensor holds motion (re-review R1)', async () => {
    const before = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'in-addition' }] })
    before.emitRaw(CAM, true)
    before.teardown()
    wire = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'in-addition' }] })
    wire.raisePir(true)
    wire.emitRaw(CAM, false)
    await wire.dispatch.settle()
    expect(wire.onboardOnBus().map((e) => e.detected)).toEqual([true])
    expect(wire.dispatch.open(CAM)).toBe(true)
    expect(
      wire.lines.some(
        (l) =>
          l.message === 'camera-sensors: camera clear passed — this instance never saw its rise',
      ),
    ).toBe(false)
  })
})

describe('an unsplit provider under in-addition (D672 hold, kept for C13 only)', () => {
  it('its direct clear while the PIR is high does not close the session; the PIR`s fall does (review H1)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    wire = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'in-addition' }] })
    wire.emitDirect(CAM, true)
    wire.raisePir(true)
    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS + 1_000)
    wire.emitDirect(CAM, false)
    await vi.advanceTimersByTimeAsync(1)
    expect(wire.dispatch.open(CAM)).toBe(true)
    expect(
      wire.lines.some(
        (l) =>
          l.message ===
            'session motion: camera clear held back — an attached sensor still sees motion' &&
          l.deviceId === CAM,
      ),
    ).toBe(true)
    wire.raisePir(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(wire.dispatch.open(CAM)).toBe(false)
    expect(wire.sessions.attached).toHaveLength(1)
  })

  it('an unsplit camera that is still high withholds the bridge`s sensor false (review M1)', async () => {
    wire = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'in-addition' }] })
    wire.emitDirect(CAM, true)
    wire.raisePir(true)
    wire.raisePir(false)
    await wire.dispatch.settle()
    expect(wire.onboardOnBus().filter((e) => !e.detected && e.triggeredBy !== undefined)).toEqual(
      [],
    )
    expect(wire.dispatch.open(CAM)).toBe(true)
    expect(
      wire.lines.some(
        (l) =>
          l.message ===
            "camera-sensors: sensors quiet — false held back, the camera's own motion is still high" &&
          l.deviceId === CAM,
      ),
    ).toBe(true)
  })
})

describe('the block-1 drop is sampled (review L1)', () => {
  it('a flood of non-onboard pushes says the first and counts the rest', async () => {
    wire = await wireCameraSensors(null)
    for (let i = 0; i < 20; i += 1) {
      wire.bus.emit(
        createEvent(
          EventCategory.ProviderMotion,
          { type: 'device', id: CAM, deviceId: CAM },
          { deviceId: CAM, detected: true, timestamp: Date.now(), source: 'analyzer' },
        ),
      )
    }
    expect(
      wire.lines.filter(
        (l) => l.message === 'provider motion dropped — not an onboard camera push',
      ),
    ).toHaveLength(1)
  })
})
