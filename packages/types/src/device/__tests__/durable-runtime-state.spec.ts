/**
 * The two runtime-state slices that nothing can regenerate.
 *
 * Of the 62 caps that declare `runtimeState`, all but two are ephemeral: a
 * provider re-publishes them within one poll, push or probe, so losing the
 * persisted copy costs a few seconds of stale UI. These two are different, and
 * they are the reason `writeDeviceRuntimeState` cannot be dropped in favour of a
 * memory-only mirror ([D96](../../../../../docs/decisions/adr-0096.md)):
 *
 *  - `native-object-detection.enabled` — an operator toggle on a Reolink camera.
 *    The cap's `refresh` is a no-op and `staleMs` is `Infinity`; there is no
 *    hardware value to re-read. `reolink-camera.ts` guards its cold-start seed on
 *    `getCapState(...) === undefined` precisely so a restored slice survives.
 *  - `doorbell.pressCountSinceStart` — a monotonic accumulator on the virtual
 *    doorbell, incremented by read-modify-write against the slice itself. There
 *    is no counter behind it; the slice IS the record.
 *
 * What this pins is the hydration contract they both rest on: `fromInitial`
 * carries the persisted blob into the live slice map, and reading it back
 * returns the persisted value rather than a default. A refactor that makes the
 * runtime state memory-only, or that seeds slices before hydrating, breaks this
 * and would otherwise be found by an operator whose AI forwarding switched
 * itself off.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { BatteryStatusSchema } from '../../capabilities/battery.cap.js'
import { DeviceRuntimeState } from '../device-runtime-state.js'

/** Writer stub — these assertions are about hydration, not propagation. */
const noopWriter = async (): Promise<void> => {}

/** What `registerNativeCap` installs for each of the two caps. A write without
 *  one is refused, so every test that writes registers first — same order as
 *  production, where hydration precedes registration. */
const nativeObjectDetectionSchema = z.object({
  lastByClass: z.record(z.string(), z.unknown()),
  supportedClasses: z.array(z.string()),
  enabled: z.boolean(),
  lastFetchedAt: z.number(),
})
const doorbellSchema = z.object({
  lastPressedAt: z.number(),
  pressCountSinceStart: z.number(),
})

/** The persisted shape of the two durable slices, as stored under `__device-state`. */
const persistedBlob: Record<string, unknown> = {
  'native-object-detection': {
    lastByClass: {},
    supportedClasses: ['person', 'vehicle'],
    enabled: true,
    lastFetchedAt: 1_700_000_000_000,
  },
  doorbell: {
    lastPressedAt: 1_700_000_000_000,
    pressCountSinceStart: 47,
  },
}

describe('durable runtime-state slices survive boot hydration', () => {
  it('restores the operator-set native-object-detection toggle', () => {
    const rs = DeviceRuntimeState.fromInitial(persistedBlob, noopWriter)
    expect(rs.getCapState('native-object-detection')).toMatchObject({ enabled: true })
  })

  it('keeps the cold-start seed guard from firing on a restored slice', () => {
    // This is the exact shape of `reolink-camera.ts`'s guard: seed ONLY when the
    // slice is absent. With hydration working it must not fire, so the operator's
    // saved `enabled: true` is never overwritten by the `enabled: false` default.
    const rs = DeviceRuntimeState.fromInitial(persistedBlob, noopWriter)
    rs.installCapSchema('native-object-detection', nativeObjectDetectionSchema)
    if (rs.getCapState('native-object-detection') === undefined) {
      rs.setCapState('native-object-detection', {
        lastByClass: {},
        supportedClasses: [],
        enabled: false,
        lastFetchedAt: 0,
      })
    }
    expect(rs.getCapState('native-object-detection')).toMatchObject({ enabled: true })
  })

  it('restores the doorbell accumulator so the next press continues the count', () => {
    const rs = DeviceRuntimeState.fromInitial(persistedBlob, noopWriter)
    rs.installCapSchema('doorbell', doorbellSchema)
    const prior = rs.getCapState<{ pressCountSinceStart: number }>('doorbell')
    expect(prior?.pressCountSinceStart).toBe(47)
    rs.setCapState('doorbell', {
      lastPressedAt: 1_700_000_001_000,
      pressCountSinceStart: (prior?.pressCountSinceStart ?? 0) + 1,
    })
    expect(rs.getCapState('doorbell')).toMatchObject({ pressCountSinceStart: 48 })
  })

  it('validates a restored slice when its cap registers later, without dropping it', () => {
    // Slices are hydrated before any cap has installed a schema; the schema
    // arrives with `registerNativeCap`. A valid persisted slice must pass that
    // late validation rather than be discarded.
    const rs = DeviceRuntimeState.fromInitial(persistedBlob, noopWriter)
    rs.installCapSchema('doorbell', doorbellSchema)
    expect(rs.getCapState('doorbell')).toMatchObject({ pressCountSinceStart: 47 })
  })

  it('an empty persisted blob is what the memory-only design would produce', () => {
    // The counterfactual, stated so the cost of dropping persistence is visible
    // in the suite: the toggle reads absent (so the cold-start guard fires and
    // writes `enabled: false`) and the counter restarts at zero.
    const rs = DeviceRuntimeState.fromInitial({}, noopWriter)
    expect(rs.getCapState('native-object-detection')).toBeUndefined()
    expect(rs.getCapState('doorbell')).toBeUndefined()
  })
})

/**
 * The hub may REFUSE a write (D663: a native write is not applied until the
 * hub knows whether a claim governs it — D49). The refusal used to vanish in a
 * `.catch(() => {})`, and the equality gate then blocked a re-send of the same
 * value forever: the slice was never mirrored and nothing said so (D391).
 */
describe('a refused hub write is surfaced and re-sent (S6, D391)', () => {
  const NATIVE = { level: 40, charging: 'none', sleeping: false, lastUpdated: 1 }

  it('a hub write the writer REJECTS is surfaced through onWriteFailed and the SAME value is re-sent on the next write', async () => {
    const calls: Record<string, unknown>[] = []
    let fail = true
    const writer = vi.fn(async (_cap: string, slice: Record<string, unknown>) => {
      calls.push(slice)
      if (fail) throw new Error('row unreadable')
    })
    const failed: [string, string][] = []
    const rs = DeviceRuntimeState.fromInitial({}, writer, (cap, error) => failed.push([cap, error]))
    rs.installCapSchema('battery', BatteryStatusSchema)
    rs.setCapState('battery', NATIVE)
    await rs.flush()
    expect(failed).toEqual([['battery', 'row unreadable']])
    fail = false
    rs.setCapState('battery', NATIVE) // identical value: the equality gate must NOT swallow it after a failed write
    await rs.flush()
    expect(writer).toHaveBeenCalledTimes(2)
    expect(calls[1]).toEqual(NATIVE)
    rs.setCapState('battery', NATIVE) // landed: the gate is back
    await rs.flush()
    expect(writer).toHaveBeenCalledTimes(2)
  })

  it('a refusal on one cap does not open the gate on another', async () => {
    let failBattery = true
    const writer = vi.fn(async (cap: string) => {
      if (cap === 'battery' && failBattery) throw new Error('row unreadable')
    })
    const rs = DeviceRuntimeState.fromInitial({}, writer)
    rs.installCapSchema('battery', BatteryStatusSchema)
    rs.installCapSchema('doorbell', doorbellSchema)
    rs.setCapState('battery', NATIVE)
    rs.setCapState('doorbell', { lastPressedAt: 1, pressCountSinceStart: 1 })
    await rs.flush()
    failBattery = false
    rs.setCapState('doorbell', { lastPressedAt: 1, pressCountSinceStart: 1 }) // gated: landed before
    rs.setCapState('battery', NATIVE) // re-sent
    await rs.flush()
    expect(writer).toHaveBeenCalledTimes(3)
  })

  it('without a hook the refusal is still tracked: the re-send happens', async () => {
    let fail = true
    const writer = vi.fn(async () => {
      if (fail) throw new Error('row unreadable')
    })
    const rs = DeviceRuntimeState.fromInitial({}, writer)
    rs.installCapSchema('battery', BatteryStatusSchema)
    rs.setCapState('battery', NATIVE)
    await rs.flush()
    fail = false
    rs.setCapState('battery', NATIVE)
    await rs.flush()
    expect(writer).toHaveBeenCalledTimes(2)
  })
})
