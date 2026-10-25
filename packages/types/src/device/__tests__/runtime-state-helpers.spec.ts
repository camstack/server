import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { CapabilityDefinition } from '../../capabilities/capability-definition.js'
import { DeviceRuntimeState } from '../device-runtime-state.js'
import { DeviceType } from '../device-type.js'
import {
  createRuntimeStateBridge,
  OPERATOR_WRITTEN_STALE_MS,
  type RuntimeStateBridgeLogger,
} from '../runtime-state-helpers.js'

/**
 * A camera whose control plane is unreachable is the case these tests
 * exist for. Measured on the live hub: `privacyMask.getStatus` for a
 * device whose IP no longer answers cost 3.27s on EVERY call while the
 * same call on a reachable camera cost 0.20s — the kernel takes ~3.1s to
 * give up on the connect, and the bridge awaited that on every single
 * read because the failed refresh never advanced `lastFetchedAt`, so the
 * slice was permanently stale. That latency was inherited by the camera
 * switch/status aggregation on the viewer's first paint.
 */

const TestStatusSchema = z.object({
  reachable: z.boolean(),
  reading: z.number(),
})

const testCap = {
  name: 'test-bridge-cap',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  methods: {},
  status: { schema: TestStatusSchema, kind: 'poll' },
  runtimeState: TestStatusSchema.extend({ lastFetchedAt: z.number() }),
} as const satisfies CapabilityDefinition

const OWN_DEVICE_ID = 105
const STALE_MS = 10_000
const COOLDOWN_MS = 60_000

interface LoggedLine {
  readonly level: 'warn' | 'info'
  readonly message: string
  readonly extras?: {
    readonly tags?: Record<string, unknown>
    readonly meta?: Record<string, unknown>
  }
}

function createRecordingLogger(): {
  readonly logger: RuntimeStateBridgeLogger
  readonly lines: LoggedLine[]
} {
  const lines: LoggedLine[] = []
  const logger: RuntimeStateBridgeLogger = {
    warn(message, extras) {
      lines.push({ level: 'warn', message, extras })
    },
    info(message, extras) {
      lines.push({ level: 'info', message, extras })
    },
  }
  return { logger, lines }
}

function createState(): DeviceRuntimeState {
  const state = DeviceRuntimeState.fromInitial({}, async () => {})
  state.installCapSchema(testCap.name, testCap.runtimeState)
  return state
}

describe('createRuntimeStateBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-08T20:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshes once and serves the slice inside the freshness window', async () => {
    const runtimeState = createState()
    const refresh = vi.fn(async () => {
      runtimeState.setCapState(testCap.name, {
        reachable: true,
        reading: 42,
        lastFetchedAt: Date.now(),
      })
    })
    const bridge = createRuntimeStateBridge({
      runtimeState,
      cap: testCap,
      ownDeviceId: OWN_DEVICE_ID,
      refresh,
      staleMs: STALE_MS,
      empty: () => ({ reachable: false, reading: 0 }),
    })

    const first = await bridge.getStatus({ deviceId: OWN_DEVICE_ID })
    const second = await bridge.getStatus({ deviceId: OWN_DEVICE_ID })

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(first).toEqual({ reachable: true, reading: 42 })
    expect(second).toEqual({ reachable: true, reading: 42 })
  })

  it('re-refreshes once the slice goes stale', async () => {
    const runtimeState = createState()
    const refresh = vi.fn(async () => {
      runtimeState.setCapState(testCap.name, {
        reachable: true,
        reading: Date.now(),
        lastFetchedAt: Date.now(),
      })
    })
    const bridge = createRuntimeStateBridge({
      runtimeState,
      cap: testCap,
      ownDeviceId: OWN_DEVICE_ID,
      refresh,
      staleMs: STALE_MS,
      empty: () => ({ reachable: false, reading: 0 }),
    })

    await bridge.getStatus({ deviceId: OWN_DEVICE_ID })
    vi.setSystemTime(Date.now() + STALE_MS + 1)
    await bridge.getStatus({ deviceId: OWN_DEVICE_ID })

    expect(refresh).toHaveBeenCalledTimes(2)
  })

  // ── The unreachable-camera path ────────────────────────────────────

  it('does NOT re-attempt a refresh that did not land, on every read', async () => {
    const runtimeState = createState()
    // Mirrors the amcrest/hikvision providers: the refresh swallows its
    // own error and leaves the slice untouched, so it resolves normally
    // and writes nothing.
    const refresh = vi.fn(async () => {})
    const bridge = createRuntimeStateBridge({
      runtimeState,
      cap: testCap,
      ownDeviceId: OWN_DEVICE_ID,
      refresh,
      staleMs: STALE_MS,
      refreshMissCooldownMs: COOLDOWN_MS,
      empty: () => ({ reachable: false, reading: 0 }),
    })

    for (let i = 0; i < 5; i++) await bridge.getStatus({ deviceId: OWN_DEVICE_ID })

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('still answers with the empty status while the miss cooldown holds', async () => {
    const runtimeState = createState()
    const bridge = createRuntimeStateBridge({
      runtimeState,
      cap: testCap,
      ownDeviceId: OWN_DEVICE_ID,
      refresh: async () => {},
      staleMs: STALE_MS,
      refreshMissCooldownMs: COOLDOWN_MS,
      empty: () => ({ reachable: false, reading: 0 }),
    })

    await bridge.getStatus({ deviceId: OWN_DEVICE_ID })
    const suppressed = await bridge.getStatus({ deviceId: OWN_DEVICE_ID })

    expect(suppressed).toEqual({ reachable: false, reading: 0 })
  })

  it('opens the cooldown when the refresh THROWS, and still surfaces the error', async () => {
    const runtimeState = createState()
    const { logger, lines } = createRecordingLogger()
    const refresh = vi.fn(async () => {
      throw new Error('fetch failed')
    })
    const bridge = createRuntimeStateBridge({
      runtimeState,
      cap: testCap,
      ownDeviceId: OWN_DEVICE_ID,
      refresh,
      staleMs: STALE_MS,
      refreshMissCooldownMs: COOLDOWN_MS,
      logger,
      empty: () => ({ reachable: false, reading: 0 }),
    })

    await expect(bridge.getStatus({ deviceId: OWN_DEVICE_ID })).rejects.toThrow(/fetch failed/)
    // The second read must not pay for the same dead camera again.
    await bridge.getStatus({ deviceId: OWN_DEVICE_ID })

    expect(refresh).toHaveBeenCalledTimes(1)
    const warned = lines.filter((l) => l.level === 'warn')
    expect(warned).toHaveLength(1)
    expect(warned[0]?.extras?.tags).toEqual({ deviceId: OWN_DEVICE_ID })
    expect(warned[0]?.extras?.meta?.['error']).toBe('fetch failed')
  })

  it('logs the dropped refresh with tags.deviceId', async () => {
    const runtimeState = createState()
    const { logger, lines } = createRecordingLogger()
    const bridge = createRuntimeStateBridge({
      runtimeState,
      cap: testCap,
      ownDeviceId: OWN_DEVICE_ID,
      refresh: async () => {},
      staleMs: STALE_MS,
      refreshMissCooldownMs: COOLDOWN_MS,
      logger,
      empty: () => ({ reachable: false, reading: 0 }),
    })

    await bridge.getStatus({ deviceId: OWN_DEVICE_ID })

    const warned = lines.filter((l) => l.level === 'warn')
    expect(warned).toHaveLength(1)
    expect(warned[0]?.message).toContain(testCap.name)
    expect(warned[0]?.extras?.tags).toEqual({ deviceId: OWN_DEVICE_ID })
  })

  it('re-attempts the refresh once the miss cooldown has elapsed', async () => {
    const runtimeState = createState()
    const refresh = vi.fn(async () => {})
    const bridge = createRuntimeStateBridge({
      runtimeState,
      cap: testCap,
      ownDeviceId: OWN_DEVICE_ID,
      refresh,
      staleMs: STALE_MS,
      refreshMissCooldownMs: COOLDOWN_MS,
      empty: () => ({ reachable: false, reading: 0 }),
    })

    await bridge.getStatus({ deviceId: OWN_DEVICE_ID })
    vi.setSystemTime(Date.now() + COOLDOWN_MS + 1)
    await bridge.getStatus({ deviceId: OWN_DEVICE_ID })

    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('clears the cooldown and says so when the camera comes back', async () => {
    const runtimeState = createState()
    const { logger, lines } = createRecordingLogger()
    let reachable = false
    const refresh = vi.fn(async () => {
      if (!reachable) return
      runtimeState.setCapState(testCap.name, {
        reachable: true,
        reading: 7,
        lastFetchedAt: Date.now(),
      })
    })
    const bridge = createRuntimeStateBridge({
      runtimeState,
      cap: testCap,
      ownDeviceId: OWN_DEVICE_ID,
      refresh,
      staleMs: STALE_MS,
      refreshMissCooldownMs: COOLDOWN_MS,
      logger,
      empty: () => ({ reachable: false, reading: 0 }),
    })

    await bridge.getStatus({ deviceId: OWN_DEVICE_ID })
    reachable = true
    vi.setSystemTime(Date.now() + COOLDOWN_MS + 1)
    const recovered = await bridge.getStatus({ deviceId: OWN_DEVICE_ID })

    expect(recovered).toEqual({ reachable: true, reading: 7 })
    const recovery = lines.filter((l) => l.level === 'info')
    expect(recovery).toHaveLength(1)
    expect(recovery[0]?.extras?.tags).toEqual({ deviceId: OWN_DEVICE_ID })

    // And the cooldown is gone: normal freshness rules apply again.
    vi.setSystemTime(Date.now() + STALE_MS + 1)
    await bridge.getStatus({ deviceId: OWN_DEVICE_ID })
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('rejects a deviceId that is not this device', async () => {
    const runtimeState = createState()
    const bridge = createRuntimeStateBridge({
      runtimeState,
      cap: testCap,
      ownDeviceId: OWN_DEVICE_ID,
      refresh: async () => {},
      staleMs: STALE_MS,
      empty: () => ({ reachable: false, reading: 0 }),
    })

    await expect(bridge.getStatus({ deviceId: 101 })).rejects.toThrow(/deviceId mismatch/)
  })
})

/**
 * A cap whose value changes ONLY when the operator writes it, read by a POLLED
 * fleet-wide list.
 *
 * `privacy-mask` is the live case ([D221](../../../../../docs/decisions/adr-0221-a-polled-list-never-dials-a-camera.md)):
 * `getCameraStatuses` composes the switched-off badge for 29 cameras and the
 * admin page polls it every 5s. With a 10s freshness window the slice was stale
 * on essentially every poll, so the badge dialled 29 cameras twelve times a
 * minute for two facts an operator changes by hand.
 *
 * Two properties make that go away AT THE SOURCE, and both are tested here:
 * a long, motivated freshness window, and a stale read that is SERVED while it
 * revalidates instead of making the caller wait for the camera.
 */
describe('createRuntimeStateBridge — a polled reader of an operator-written cap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T20:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('serves a STALE slice immediately and refreshes behind the caller', async () => {
    const runtimeState = createState()
    let released = (): void => {}
    const gate = new Promise<void>((resolve) => {
      released = resolve
    })
    let reading = 1
    const refresh = vi.fn(async () => {
      if (reading > 1) await gate
      runtimeState.setCapState(testCap.name, {
        reachable: true,
        reading,
        lastFetchedAt: Date.now(),
      })
    })
    const bridge = createRuntimeStateBridge({
      runtimeState,
      cap: testCap,
      ownDeviceId: OWN_DEVICE_ID,
      refresh,
      staleMs: STALE_MS,
      staleRead: 'serve-and-revalidate',
      empty: () => ({ reachable: false, reading: 0 }),
    })

    // Cold read still AWAITS — the first render must be a real answer.
    expect(await bridge.getStatus({ deviceId: OWN_DEVICE_ID })).toEqual({
      reachable: true,
      reading: 1,
    })

    reading = 2
    vi.setSystemTime(Date.now() + STALE_MS + 1)
    // Stale, and the camera is not answering yet: the caller gets the last
    // known value NOW rather than waiting on the refresh it triggered.
    expect(await bridge.getStatus({ deviceId: OWN_DEVICE_ID })).toEqual({
      reachable: true,
      reading: 1,
    })
    expect(refresh).toHaveBeenCalledTimes(2)

    released()
    await vi.waitFor(() => {
      expect(runtimeState.getCapState<{ reading: number }>(testCap.name)?.reading).toBe(2)
    })
    // …and the NEXT caller sees what the background refresh landed.
    expect(await bridge.getStatus({ deviceId: OWN_DEVICE_ID })).toEqual({
      reachable: true,
      reading: 2,
    })
  })

  it('coalesces concurrent stale reads into ONE background refresh', async () => {
    const runtimeState = createState()
    let released = (): void => {}
    const gate = new Promise<void>((resolve) => {
      released = resolve
    })
    let cold = true
    const refresh = vi.fn(async () => {
      if (!cold) await gate
      runtimeState.setCapState(testCap.name, {
        reachable: true,
        reading: 5,
        lastFetchedAt: Date.now(),
      })
    })
    const bridge = createRuntimeStateBridge({
      runtimeState,
      cap: testCap,
      ownDeviceId: OWN_DEVICE_ID,
      refresh,
      staleMs: STALE_MS,
      staleRead: 'serve-and-revalidate',
      empty: () => ({ reachable: false, reading: 0 }),
    })

    await bridge.getStatus({ deviceId: OWN_DEVICE_ID })
    cold = false
    vi.setSystemTime(Date.now() + STALE_MS + 1)

    await Promise.all([
      bridge.getStatus({ deviceId: OWN_DEVICE_ID }),
      bridge.getStatus({ deviceId: OWN_DEVICE_ID }),
      bridge.getStatus({ deviceId: OWN_DEVICE_ID }),
    ])

    // One cold + ONE background. Twenty-nine cameras behind one page poll must
    // not each queue a second probe while the first is still outstanding.
    expect(refresh).toHaveBeenCalledTimes(2)
    released()
  })

  it('a background refresh that throws never reaches the caller', async () => {
    const runtimeState = createState()
    let fail = false
    const refresh = vi.fn(async () => {
      if (fail) throw new Error('camera unreachable')
      runtimeState.setCapState(testCap.name, {
        reachable: true,
        reading: 3,
        lastFetchedAt: Date.now(),
      })
    })
    const { logger, lines } = createRecordingLogger()
    const bridge = createRuntimeStateBridge({
      runtimeState,
      cap: testCap,
      ownDeviceId: OWN_DEVICE_ID,
      refresh,
      staleMs: STALE_MS,
      staleRead: 'serve-and-revalidate',
      logger,
      empty: () => ({ reachable: false, reading: 0 }),
    })

    await bridge.getStatus({ deviceId: OWN_DEVICE_ID })
    fail = true
    vi.setSystemTime(Date.now() + STALE_MS + 1)

    // The caller is answered from the slice; the failure becomes a logged miss
    // plus a cooldown, never a rejected read.
    await expect(bridge.getStatus({ deviceId: OWN_DEVICE_ID })).resolves.toEqual({
      reachable: true,
      reading: 3,
    })
    await vi.waitFor(() => {
      expect(lines.filter((l) => l.level === 'warn')).toHaveLength(1)
    })
    expect(lines[0]?.extras?.tags).toEqual({ deviceId: OWN_DEVICE_ID })
  })

  it('dials the camera ONCE across a minute of 5s polls at the operator-written window', async () => {
    const runtimeState = createState()
    const refresh = vi.fn(async () => {
      runtimeState.setCapState(testCap.name, {
        reachable: true,
        reading: 1,
        lastFetchedAt: Date.now(),
      })
    })
    const bridge = createRuntimeStateBridge({
      runtimeState,
      cap: testCap,
      ownDeviceId: OWN_DEVICE_ID,
      refresh,
      staleMs: OPERATOR_WRITTEN_STALE_MS,
      staleRead: 'serve-and-revalidate',
      empty: () => ({ reachable: false, reading: 0 }),
    })

    for (let poll = 0; poll < 12; poll += 1) {
      await bridge.getStatus({ deviceId: OWN_DEVICE_ID })
      vi.setSystemTime(Date.now() + 5_000)
    }

    // Twelve polls, ONE camera round trip — the cold one.
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('shows an OPERATOR WRITE immediately, however long the window is', async () => {
    const runtimeState = createState()
    let reading = 1
    const refreshFromCamera = async (): Promise<void> => {
      runtimeState.setCapState(testCap.name, {
        reachable: true,
        reading,
        lastFetchedAt: Date.now(),
      })
    }
    const bridge = createRuntimeStateBridge({
      runtimeState,
      cap: testCap,
      ownDeviceId: OWN_DEVICE_ID,
      refresh: refreshFromCamera,
      staleMs: OPERATOR_WRITTEN_STALE_MS,
      staleRead: 'serve-and-revalidate',
      empty: () => ({ reachable: false, reading: 0 }),
    })

    await bridge.getStatus({ deviceId: OWN_DEVICE_ID })

    // The write path does what every provider's `setX` already does: write the
    // camera, then re-read it. THAT is the invalidation — no second cache to
    // tell, and no window to wait out.
    reading = 9
    await refreshFromCamera()

    expect(await bridge.getStatus({ deviceId: OWN_DEVICE_ID })).toEqual({
      reachable: true,
      reading: 9,
    })
  })

  it('never JOINS a refresh already in the air — an unreachable camera stalls one read, not every read', async () => {
    const runtimeState = createState()
    let released = (): void => {}
    const gate = new Promise<void>((resolve) => {
      released = resolve
    })
    // The camera never answers. `refresh()` hangs, and its provider swallows
    // the error, so the slice stays cold forever — this is device 3629.
    const refresh = vi.fn(async () => {
      await gate
    })
    const bridge = createRuntimeStateBridge({
      runtimeState,
      cap: testCap,
      ownDeviceId: OWN_DEVICE_ID,
      refresh,
      staleMs: OPERATOR_WRITTEN_STALE_MS,
      staleRead: 'serve-and-revalidate',
      empty: () => ({ reachable: false, reading: 0 }),
    })

    // The FIRST read pays: it is the only one that can produce a real answer.
    let firstSettled = false
    const first = bridge.getStatus({ deviceId: OWN_DEVICE_ID }).then((v) => {
      firstSettled = true
      return v
    })
    await Promise.resolve()
    expect(firstSettled).toBe(false)

    // Every poll landing inside that hang is answered NOW, from the empty
    // slice — UNKNOWN, which is the truth about a camera nobody has reached.
    for (let poll = 0; poll < 5; poll += 1) {
      vi.setSystemTime(Date.now() + 5_000)
      await expect(bridge.getStatus({ deviceId: OWN_DEVICE_ID })).resolves.toEqual({
        reachable: false,
        reading: 0,
      })
    }
    // …and none of them started a second dial.
    expect(refresh).toHaveBeenCalledTimes(1)

    released()
    await first
  })

  it('defaults to awaiting the refresh, so a cap that did not ask does not change', async () => {
    const runtimeState = createState()
    let landed = false
    const refresh = vi.fn(async () => {
      runtimeState.setCapState(testCap.name, {
        reachable: true,
        reading: 4,
        lastFetchedAt: Date.now(),
      })
      landed = true
    })
    const bridge = createRuntimeStateBridge({
      runtimeState,
      cap: testCap,
      ownDeviceId: OWN_DEVICE_ID,
      refresh,
      staleMs: STALE_MS,
      empty: () => ({ reachable: false, reading: 0 }),
    })

    await bridge.getStatus({ deviceId: OWN_DEVICE_ID })
    vi.setSystemTime(Date.now() + STALE_MS + 1)
    landed = false
    // No `staleRead`: the stale read still WAITS, so the value it returns is
    // the freshly fetched one.
    await bridge.getStatus({ deviceId: OWN_DEVICE_ID })
    expect(landed).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
