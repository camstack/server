/**
 * D696 end to end through the orchestrator's real subscriptions and the real
 * camera-sensors bridge: the camera's `motion` slice is the EFFECTIVE motion,
 * so every reader of the slice (HA export's camera motion entity
 * `ha-export.addon.ts` `onSliceChanged`, provider `isDetected`, HAP's
 * hydration) sees what the effective event says, under every mode.
 *
 * The camera's OWN level, the raw input, is on the camera-sensors status
 * (`cameraLevel`), for the Motion card's camera row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type CameraSensorsWire, wireCameraSensors } from './camera-sensors-harness.js'

const CAM = 103
const PIR = { addonId: 'provider-homeassistant', stableId: 'ha:porch-pir' }
let wire: CameraSensorsWire | null = null
afterEach(() => {
  wire?.teardown()
  wire = null
  vi.useRealTimers()
})

const detectedWrites = (w: CameraSensorsWire): readonly boolean[] =>
  w.sliceWrites.filter((s) => s.deviceId === CAM).map((s) => s.slice.detected)

describe('the camera motion slice is the effective motion (D696)', () => {
  it('Replace with the sensor quiet: the camera`s own push writes nothing — the slice stays OFF', async () => {
    wire = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'replace' }] })
    wire.emitRaw(CAM, true)
    await wire.settleSlice()
    expect(detectedWrites(wire)).toEqual([])
  })

  it('In addition: the sensor raises the slice and its fall lowers it, like the effective event', async () => {
    wire = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'in-addition' }] })
    wire.raisePir(true)
    await wire.settleSlice()
    expect(detectedWrites(wire)).toEqual([true])
    wire.raisePir(false)
    await wire.settleSlice()
    expect(detectedWrites(wire)).toEqual([true, false])
    expect(wire.onboardOnBus().map((e) => e.detected)).toEqual([true, false])
  })

  it('no sensor: the bridge`s pass-through is the slice', async () => {
    wire = await wireCameraSensors(null)
    wire.emitRaw(CAM, true)
    wire.emitRaw(CAM, false)
    await wire.settleSlice()
    expect(detectedWrites(wire)).toEqual([true, false])
  })

  it('an unsplit provider`s direct emit is written too: the orchestrator writes every camera', async () => {
    wire = await wireCameraSensors(null)
    wire.emitDirect(CAM, true)
    await wire.settleSlice()
    expect(detectedWrites(wire)).toEqual([true])
  })

  it('D1: a session opened and closed by motion leaves the slice OFF', async () => {
    wire = await wireCameraSensors(null)
    wire.emitRaw(CAM, true)
    await wire.dispatch.settle()
    expect(wire.dispatch.dispatched(CAM)).toBe(true)
    wire.emitRaw(CAM, false)
    await wire.dispatch.settle()
    await wire.settleSlice()
    expect(detectedWrites(wire).at(-1)).toBe(false)
    expect(wire.hubSlice(CAM)?.['detected']).toBe(false)
  })

  it('an old runner (gate closed) keeps the orchestrator from writing at all', async () => {
    wire = await wireCameraSensors(null, { writerOpen: false })
    wire.emitRaw(CAM, true)
    await wire.settleSlice()
    expect(wire.sliceWrites).toEqual([])
  })
})

describe('the camera`s own raw level on the status (D696, the Motion card`s camera row)', () => {
  it('is absent until the camera said something, then carries its own last edge', async () => {
    wire = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'replace' }] })
    expect(wire.controller.statusFor(CAM)).not.toHaveProperty('cameraLevel')
    wire.emitRaw(CAM, true)
    await wire.settleSlice()
    // Under Replace the slice stays OFF, and the camera's own row still sees the camera.
    expect(wire.controller.statusFor(CAM)).toMatchObject({
      state: 'configured',
      cameraLevel: { detected: true, atMs: expect.any(Number) },
    })
    expect(detectedWrites(wire)).toEqual([])
  })

  it('is carried on a not-configured camera too (pass-through)', async () => {
    wire = await wireCameraSensors(null)
    wire.emitRaw(CAM, false)
    expect(wire.controller.statusFor(CAM)).toMatchObject({
      state: 'not-configured',
      cameraLevel: { detected: false },
    })
  })

  it('is evaluated against the bridge`s window at status time: a heartbeat-only camera with no push inside it reads idle (review F4)', async () => {
    wire = await wireCameraSensors({ sensors: [{ ...PIR, mode: 'replace' }] })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    wire.emitRaw(CAM, true)
    expect(wire.controller.statusFor(CAM)).toMatchObject({
      cameraLevel: { detected: true, atMs: 1_000_000 },
    })
    vi.setSystemTime(1_000_000 + 30_000 - 1)
    expect(wire.controller.statusFor(CAM)).toMatchObject({ cameraLevel: { detected: true } })
    vi.setSystemTime(1_000_000 + 30_000)
    expect(wire.controller.statusFor(CAM)).toMatchObject({
      cameraLevel: { detected: false, atMs: 1_000_000 },
    })
  })
})
