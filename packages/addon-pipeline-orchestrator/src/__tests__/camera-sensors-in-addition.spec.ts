/**
 * "In addition" at the SESSION (D672, block-3 review M1; D673): motion is the
 * camera OR an attached sensor, so neither side's `false` may end a detection
 * session while the other side still sees motion. The bridge is the one emitter
 * of the camera's effective onboard motion: it withholds the camera's own
 * `false` while an attached sensor is high, and the sensors' `false` while the
 * camera's own level is high. A camera with no attached sensor behaves exactly
 * as before. The camera is driven by RAW pushes (`ProviderMotion`).
 *
 * Real pieces end to end (`camera-sensors-harness.ts`): `CameraSensorsSource` +
 * `CameraSensorsController` (fake ports), `wireOrchestratorSubscriptions` on a
 * local bus, and the real `SessionDispatchController` behind block 9b.
 */
import type { CameraSensorsConfig, MotionTriggeredBy } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MAX_SESSION_HOLD_MS, MIN_SESSION_OPEN_MS } from '../session-dispatch-controller.js'
import {
  HARNESS_CAMERA,
  HARNESS_COOLDOWN_MS,
  HARNESS_PIR,
  HARNESS_PIR_ADDON,
  HARNESS_PIR_STABLE_ID,
  wireCameraSensors,
} from './camera-sensors-harness.js'

const CAM = HARNESS_CAMERA
const PIR = HARNESS_PIR
const PORCH: CameraSensorsConfig = {
  sensors: [{ addonId: HARNESS_PIR_ADDON, stableId: HARNESS_PIR_STABLE_ID, mode: 'in-addition' }],
}
const COOLDOWN_MS = HARNESS_COOLDOWN_MS
const MAX_HOLD_MS = DEFAULT_MAX_SESSION_HOLD_MS

async function wire(opts: { readonly attached: boolean }) {
  const w = await wireCameraSensors(opts.attached ? PORCH : null)
  /** The camera's own firmware motion, as a raw push. */
  const camera = async (detected: boolean): Promise<void> => {
    w.emitRaw(CAM, detected)
    await vi.advanceTimersByTimeAsync(1)
  }
  const pir = async (detected: boolean): Promise<void> => {
    w.raisePir(detected)
    await vi.advanceTimersByTimeAsync(1)
  }
  const open = (): boolean => w.dispatch.open(CAM)
  const openedBy = (): MotionTriggeredBy | undefined =>
    w.sessions.controller.sessionRegistry.get(CAM)?.triggeredBy
  return {
    camera,
    pir,
    open,
    openedBy,
    dispatch: w.sessions,
    teardown: w.teardown,
    cameraSensors: w.controller,
    setPirDisabled: w.setPirDisabled,
    lines: w.lines,
  }
}

describe('in addition: neither side closes the session while the other sees motion (D672)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the PIR going quiet while the camera still sees motion keeps the session', async () => {
    const w = await wire({ attached: true })
    await w.pir(false)
    await w.camera(true)
    await w.pir(true)
    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS + 1_000)
    await w.pir(false)
    expect(w.open()).toBe(true)
    // …and the camera's own clear ends it, now that nothing sees motion.
    await w.camera(false)
    expect(w.open()).toBe(false)
    w.teardown()
  })

  it('the camera clearing while the PIR is high leaves ONE session, no close/reopen gap', async () => {
    const w = await wire({ attached: true })
    await w.pir(false)
    await w.pir(true)
    expect(w.openedBy()).toEqual({ kind: 'sensor', deviceId: PIR })
    await w.camera(true)
    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS + 1_000)
    await w.camera(false)
    expect(w.open()).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000) // a sustain tick lands meanwhile
    expect(w.open()).toBe(true)
    expect(w.dispatch.attached).toHaveLength(1)
    await w.pir(false)
    expect(w.open()).toBe(false)
    w.teardown()
  })

  it('a camera with NO attached sensor closes on its own clear, exactly as before', async () => {
    const w = await wire({ attached: false })
    await w.camera(true)
    expect(w.open()).toBe(true)
    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS + 1_000)
    await w.camera(false)
    expect(w.open()).toBe(false)
    w.teardown()
  })
})

describe('block 13: a soft-disabled sensor never reads ready (D62, review L2)', () => {
  it('DeviceDisabled / DeviceEnabled refresh the cameras that sensor feeds', async () => {
    const w = await wire({ attached: true })
    expect(w.cameraSensors.statusFor(CAM)).toMatchObject({ sensors: [{ state: 'ready' }] })
    w.setPirDisabled(true)
    await w.cameraSensors.idle()
    expect(w.cameraSensors.statusFor(CAM)).toMatchObject({
      sensors: [{ state: 'offline', reason: 'disabled' }],
    })
    // Disabled does not un-route (R10).
    expect(w.cameraSensors.watches(PIR)).toBe(true)
    w.setPirDisabled(false)
    await w.cameraSensors.idle()
    expect(w.cameraSensors.statusFor(CAM)).toMatchObject({ sensors: [{ state: 'ready' }] })
    w.teardown()
  })
})

describe('the holds are bounded (review N1, N2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const STILL_HIGH =
    "camera-sensors: sensors quiet — false held back, the camera's own motion is still high"

  it('a heartbeat-only camera (never sends false) does not hold the sensor clear past its cooldown', async () => {
    const w = await wire({ attached: true })
    await w.pir(false)
    await w.camera(true) // Reolink / Wyze: a `true` heartbeat, never a `false`
    await w.pir(true)
    await vi.advanceTimersByTimeAsync(COOLDOWN_MS + 1_000)
    await w.pir(false)
    expect(w.open()).toBe(false)
    expect(w.lines.map((l) => l.message)).not.toContain(STILL_HIGH)
    w.teardown()
  })

  it('a sensor stuck high stops sustaining after maxSessionHoldMs, releases the holds, and says so', async () => {
    const w = await wire({ attached: true })
    await w.pir(false)
    await w.pir(true) // …and its `off` is lost, or it went unavailable while on
    await w.camera(true)
    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS + 1_000)
    await w.camera(false) // held back: the PIR still reads high
    expect(w.open()).toBe(true)
    await vi.advanceTimersByTimeAsync(MAX_HOLD_MS + 20_000)
    expect(w.open()).toBe(false)
    const stuck = w.lines.filter(
      (l) => l.level === 'warn' && l.meta?.['reason'] === 'sensor-stuck-high',
    )
    expect(stuck).toHaveLength(1)
    expect(stuck[0]).toMatchObject({ deviceId: CAM, meta: { sourceDeviceId: PIR } })
    // No more ticks: nothing reopens it.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(w.open()).toBe(false)
    expect(w.dispatch.attached).toHaveLength(1)
    w.teardown()
  })

  it('a stuck release while the camera still sees motion leaves the session to the camera', async () => {
    const w = await wire({ attached: true })
    await w.pir(false)
    await w.pir(true) // …and its `off` is lost
    // The camera keeps sending its own `true` heartbeats past the hold bound.
    for (let elapsed = 0; elapsed < MAX_HOLD_MS + 20_000; elapsed += 10_000) {
      await w.camera(true)
      await vi.advanceTimersByTimeAsync(10_000)
    }
    const stuck = w.lines.filter((l) => l.meta?.['reason'] === 'sensor-stuck-high')
    expect(stuck).toHaveLength(1)
    expect(stuck[0]?.meta).toMatchObject({ falseWithheld: true })
    // ONE session throughout: never closed by the sensor and re-opened by the camera.
    expect(w.open()).toBe(true)
    expect(w.dispatch.attached).toHaveLength(1)
    // The hold is released: the camera's own clear now closes the session.
    await w.camera(false)
    expect(w.open()).toBe(false)
    w.teardown()
  })

  it('a sensor that keeps RISING is not stuck: each real rise restarts the bound', async () => {
    const w = await wire({ attached: true })
    await w.pir(false)
    await w.pir(true)
    await w.camera(true)
    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS + 1_000)
    await w.camera(false) // held: the PIR is high
    // Keep the PIR's own motion going: a fresh false→true inside every hold window.
    for (let elapsed = 0; elapsed < MAX_HOLD_MS * 2; elapsed += MAX_HOLD_MS / 2) {
      await vi.advanceTimersByTimeAsync(MAX_HOLD_MS / 2 - 2)
      await w.pir(false)
      await w.pir(true)
    }
    expect(w.open()).toBe(true)
    expect(w.lines.filter((l) => l.meta?.['reason'] === 'sensor-stuck-high')).toEqual([])
    w.teardown()
  })
})
