/**
 * `DeviceStateMirror` end to end: what reaches disk, and what does not.
 *
 * The mirror keeps mirroring and emitting EVERYTHING — that half must not
 * change, because `createRuntimeStateBridge.ensureFresh` detects a successful
 * refresh by a clock field advancing, and a mirror that swallowed clock-only
 * updates would make every landing refresh look like a failure. What changes is
 * only which of those updates is worth a SQLite commit.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceRuntimeState, runtimeStatePolicyFor } from '@camstack/types'
import type { DeviceManagerSettings } from '../device-meta-store.js'
import { RuntimeStateDrainError } from '../mirror-row-writer.js'
import { MigrationRefusedError } from '../migration-refused.js'
import { flushDebounce, harness } from './mirror-harness.js'

describe('DeviceStateMirror — durability gate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a session-only cap is mirrored and emitted but NEVER written', async () => {
    const h = harness()
    for (let i = 0; i < 5; i += 1) {
      h.mirror.applySingleCapUpdate(101, 'audio-metrics', { avgDbfs: -39 - i, ts: i })
      h.mirror.scheduleRuntimeStateDiskWrite(101, h.settings, 'audio-metrics')
      await flushDebounce()
    }

    expect(h.writes).toHaveLength(0)
    expect(h.emitted).toEqual(Array<string>(5).fill('audio-metrics'))
    // Still readable through the cap surface — RAM-only, not absent.
    expect(h.mirror.capSlice(101, 'audio-metrics')).toEqual({ avgDbfs: -43, ts: 4 })
  })

  it('a session slice never appears in the persisted blob of a restored write', async () => {
    const h = harness()
    h.mirror.applySingleCapUpdate(101, 'audio-metrics', { avgDbfs: -39 })
    h.mirror.applySingleCapUpdate(101, 'battery', { percentage: 80, lastUpdated: 1 })
    h.mirror.scheduleRuntimeStateDiskWrite(101, h.settings, 'battery')
    await flushDebounce()

    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]!.blob).toEqual({ battery: { percentage: 80, lastUpdated: 1 } })
  })
})

describe('DeviceStateMirror — effective-change gate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the battery case: a moved clock with an unmoved value costs no commit', async () => {
    const h = harness()
    h.mirror.applySingleCapUpdate(101, 'battery', { percentage: 47, lastUpdated: 1_000 })
    h.mirror.scheduleRuntimeStateDiskWrite(101, h.settings, 'battery')
    await flushDebounce()
    expect(h.writes).toHaveLength(1)

    // 20 more polls, same percentage, clock advancing every time.
    for (let i = 1; i <= 20; i += 1) {
      h.mirror.applySingleCapUpdate(101, 'battery', { percentage: 47, lastUpdated: 1_000 + i * 60 })
      h.mirror.scheduleRuntimeStateDiskWrite(101, h.settings, 'battery')
      await flushDebounce()
    }

    expect(h.writes).toHaveLength(1)
    // The mirror still carries the fresh clock — only the disk was spared.
    expect(h.mirror.capSlice(101, 'battery')).toEqual({ percentage: 47, lastUpdated: 2_200 })
  })

  it('a real change writes, and carries the fresh clock with it', async () => {
    const h = harness()
    h.mirror.applySingleCapUpdate(101, 'battery', { percentage: 47, lastUpdated: 1_000 })
    h.mirror.scheduleRuntimeStateDiskWrite(101, h.settings, 'battery')
    await flushDebounce()

    h.mirror.applySingleCapUpdate(101, 'battery', { percentage: 46, lastUpdated: 5_000 })
    h.mirror.scheduleRuntimeStateDiskWrite(101, h.settings, 'battery')
    await flushDebounce()

    expect(h.writes).toHaveLength(2)
    expect(h.writes[1]!.blob).toEqual({ battery: { percentage: 46, lastUpdated: 5_000 } })
  })

  it('drift does not accumulate: the compare is against DISK, not the previous tick', async () => {
    const h = harness()
    h.mirror.applySingleCapUpdate(101, 'zones', { zones: [{ id: 'a' }] })
    h.mirror.scheduleRuntimeStateDiskWrite(101, h.settings, 'zones')
    await flushDebounce()
    expect(h.writes).toHaveLength(1)

    // Re-publish the SAME polygon list as a fresh deserialisation, repeatedly.
    // Reference equality would have written every one of these.
    for (let i = 0; i < 10; i += 1) {
      h.mirror.applySingleCapUpdate(101, 'zones', { zones: [{ id: 'a' }] })
      h.mirror.scheduleRuntimeStateDiskWrite(101, h.settings, 'zones')
      await flushDebounce()
    }
    expect(h.writes).toHaveLength(1)
  })

  it('the boot seed IS the baseline — an unchanged device writes nothing after a restart', async () => {
    const h = harness()
    h.mirror.seedMirror(101, {
      battery: { percentage: 47, lastUpdated: 1_000 },
      'audio-metrics': { avgDbfs: -39 },
    })

    // The provider republishes what it read from the hardware: same value,
    // fresh clock. Before the baseline existed this always cost a commit, on
    // every device, at every boot.
    h.mirror.applySingleCapUpdate(101, 'battery', { percentage: 47, lastUpdated: 9_999 })
    h.mirror.scheduleRuntimeStateDiskWrite(101, h.settings, 'battery')
    await flushDebounce()

    expect(h.writes).toHaveLength(0)
  })

  it('a genuinely different value after a restart DOES write', async () => {
    const h = harness()
    h.mirror.seedMirror(101, { battery: { percentage: 47, lastUpdated: 1_000 } })
    h.mirror.applySingleCapUpdate(101, 'battery', { percentage: 12, lastUpdated: 9_999 })
    h.mirror.scheduleRuntimeStateDiskWrite(101, h.settings, 'battery')
    await flushDebounce()

    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]!.blob).toEqual({ battery: { percentage: 12, lastUpdated: 9_999 } })
  })

  it('a device-status flip always writes — it is the slice the restore exists for', async () => {
    const h = harness()
    h.mirror.seedMirror(101, { 'device-status': { online: true, lastChangedAt: 1 } })
    h.mirror.applySingleCapUpdate(101, 'device-status', { online: false, lastChangedAt: 2 })
    h.mirror.scheduleRuntimeStateDiskWrite(101, h.settings, 'device-status')
    await flushDebounce()

    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]!.blob).toEqual({ 'device-status': { online: false, lastChangedAt: 2 } })
  })
})

/**
 * `consumables` survives a restart (D642).
 *
 * Live, 2026-09-26: the Dreame mower 503 answered `consumables = { items: [] }`
 * because its three CMS counters can be read only in the charging wake window,
 * and the addon had restarted while the mower was idle. The mower's code said
 * "the last good reading (kernel-persisted across restarts) must survive boot",
 * and the cap said `durability: 'session'` — "mirrored in RAM, NEVER written to
 * disk". Nothing else holds that value, which is the definition of `restored`.
 *
 * These run the PRODUCTION policy (the codegen'd `RUNTIME_STATE_POLICY`)
 * through the whole round trip a restart takes: the mirror writes the slice, a
 * fresh mirror is seeded from what was written, and the device's runtime state
 * is hydrated from the same blob (`initialRuntimeState`).
 */
describe('consumables — durable across a restart (D642)', () => {
  const MOWER = 503
  const SLICE = {
    items: [
      {
        key: 'blade',
        label: 'Blade',
        level: 42.5,
        status: null,
        lastResetAt: null,
        resettable: true,
      },
    ],
    lastChangedAt: 1_000,
    lastFetchedAt: 1_000,
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a consumables write reaches disk', async () => {
    const h = harness(runtimeStatePolicyFor)
    h.mirror.applySingleCapUpdate(MOWER, 'consumables', SLICE)
    h.mirror.scheduleRuntimeStateDiskWrite(MOWER, h.settings, 'consumables')
    await flushDebounce()
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]!.blob).toEqual({ consumables: SLICE })
  })

  it('the written slice is what the next boot restores — mirror AND device', async () => {
    const before = harness(runtimeStatePolicyFor)
    before.mirror.applySingleCapUpdate(MOWER, 'consumables', SLICE)
    before.mirror.scheduleRuntimeStateDiskWrite(MOWER, before.settings, 'consumables')
    await flushDebounce()
    const onDisk = before.writes[0]?.blob ?? {}

    // The restart: a NEW mirror, seeded from disk (`loadRuntimeState`) …
    const after = harness(runtimeStatePolicyFor)
    after.mirror.seedMirror(MOWER, onDisk)
    expect(after.mirror.capSlice(MOWER, 'consumables')).toEqual(SLICE)
    // … and the device hydrated from the same blob (`initialRuntimeState`).
    const device = DeviceRuntimeState.fromInitial(onDisk, async () => undefined)
    expect(device.getCapState('consumables')).toEqual(SLICE)
  })

  it('a clock-only change (lastChangedAt / lastFetchedAt) costs no commit', async () => {
    const h = harness(runtimeStatePolicyFor)
    h.mirror.seedMirror(MOWER, { consumables: SLICE })
    for (let i = 1; i <= 5; i += 1) {
      h.mirror.applySingleCapUpdate(MOWER, 'consumables', {
        ...SLICE,
        lastChangedAt: 1_000 + i,
        lastFetchedAt: 1_000 + i,
      })
      h.mirror.scheduleRuntimeStateDiskWrite(MOWER, h.settings, 'consumables')
      await flushDebounce()
    }
    expect(h.writes).toHaveLength(0)
  })
})

/**
 * A migration swaps two runtime-state rows (`swapHardwareState`). A debounced
 * write whose timer already fired carries the PRE-swap hardware's blob; landing
 * after the swap it puts the other box's state back under the number, and sets
 * the effective-change baseline to it (D663 re-review N-6). The hold drains
 * both devices first and keeps the writer off their rows until released.
 */
describe('DeviceStateMirror — held for a migration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const OLD = { percentage: 10, lastUpdated: 1 }
  const NEWER = { percentage: 12, lastUpdated: 2 }

  /** Settings whose FIRST runtime write parks until `release()`. */
  function gatedSettings(h: ReturnType<typeof harness>) {
    const order: string[] = []
    let release: () => void = () => {}
    let gated = true
    const settings: DeviceManagerSettings = {
      ...h.settings,
      writeDeviceRuntimeState: async (deviceId: number, blob: Record<string, unknown>) => {
        if (gated) {
          gated = false
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        order.push(`write:${deviceId}:${JSON.stringify(blob)}`)
        await h.settings.writeDeviceRuntimeState(deviceId, blob)
      },
    }
    return { settings, order, release: () => release() }
  }

  it('an IN-FLIGHT write lands before the hold resolves — never after the swap', async () => {
    const h = harness()
    const g = gatedSettings(h)
    h.mirror.applySingleCapUpdate(108, 'battery', OLD)
    h.mirror.scheduleRuntimeStateDiskWrite(108, g.settings, 'battery')
    await flushDebounce() // the timer fired; its write is parked in flight

    const held = h.mirror.holdDiskWrites([108, 4362], g.settings).then((hold) => {
      g.order.push('held')
      return hold
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(g.order).toEqual([]) // still waiting on the in-flight write

    g.release()
    const hold = await held
    expect(g.order).toEqual([`write:108:${JSON.stringify({ battery: OLD })}`, 'held'])
    hold.release()
  })

  it('a write still in its debounce window is written NOW, and the timer never fires later', async () => {
    const h = harness()
    h.mirror.applySingleCapUpdate(108, 'battery', OLD)
    h.mirror.scheduleRuntimeStateDiskWrite(108, h.settings, 'battery')

    const hold = await h.mirror.holdDiskWrites([108], h.settings)
    expect(h.writes).toEqual([{ deviceId: 108, blob: { battery: OLD } }])

    await flushDebounce()
    expect(h.writes).toHaveLength(1)
    hold.release()
  })

  it('while held nothing reaches the row; after the reseed, release writes nothing', async () => {
    const h = harness()
    const hold = await h.mirror.holdDiskWrites([108], h.settings)

    h.mirror.applySingleCapUpdate(108, 'battery', NEWER)
    h.mirror.scheduleRuntimeStateDiskWrite(108, h.settings, 'battery')
    await flushDebounce()
    expect(h.writes).toEqual([])

    // The migration's reseed: the row now belongs to the other hardware.
    h.mirror.seedMirror(108, { battery: OLD }, 'replace')
    hold.release()
    await flushDebounce()
    expect(h.writes).toEqual([])
  })

  it('a hold released without a reseed (the swap failed) converges the row to memory', async () => {
    const h = harness()
    const hold = await h.mirror.holdDiskWrites([108], h.settings)
    h.mirror.applySingleCapUpdate(108, 'battery', NEWER)
    h.mirror.scheduleRuntimeStateDiskWrite(108, h.settings, 'battery')

    hold.release()
    await flushDebounce()
    expect(h.writes).toEqual([{ deviceId: 108, blob: { battery: NEWER } }])
  })

  it('a drain write that fails REJECTS the hold, names the device, and the owed write is retried unheld', async () => {
    const h = harness()
    let failures = 1
    const flaky: DeviceManagerSettings = {
      ...h.settings,
      writeDeviceRuntimeState: async (deviceId: number, blob: Record<string, unknown>) => {
        if (failures > 0) {
          failures -= 1
          throw new Error('sqlite busy')
        }
        await h.settings.writeDeviceRuntimeState(deviceId, blob)
      },
    }
    h.mirror.applySingleCapUpdate(108, 'battery', OLD)
    h.mirror.scheduleRuntimeStateDiskWrite(108, flaky, 'battery')

    await expect(h.mirror.holdDiskWrites([108], flaky)).rejects.toThrow(/sqlite busy/)
    const line = h.logs.find((l) => l.level === 'warn' && l.message.includes('migration drain'))
    expect(line?.extras).toMatchObject({ tags: { deviceId: 108 } })

    // Not left held, and the write still owed reaches the row.
    await flushDebounce()
    expect(h.writes).toEqual([{ deviceId: 108, blob: { battery: OLD } }])
  })

  it('an in-flight write that FAILED is not "landed": the hold refuses by name, typed as nothing-moved (ruling I-2)', async () => {
    const h = harness()
    let failures = 1
    const flaky: DeviceManagerSettings = {
      ...h.settings,
      writeDeviceRuntimeState: async (deviceId: number, blob: Record<string, unknown>) => {
        if (failures > 0) {
          failures -= 1
          throw new Error('sqlite busy')
        }
        await h.settings.writeDeviceRuntimeState(deviceId, blob)
      },
    }
    h.mirror.applySingleCapUpdate(108, 'battery', OLD)
    h.mirror.scheduleRuntimeStateDiskWrite(108, flaky, 'battery')
    await flushDebounce() // the debounced write fired and FAILED; no timer is pending

    const err = await h.mirror.holdDiskWrites([108], flaky).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(RuntimeStateDrainError)
    expect(err).toBeInstanceOf(MigrationRefusedError)
    expect(err instanceof RuntimeStateDrainError && err.deviceId).toBe(108)
    expect(String(err)).toMatch(/device 108 could not be drained .*did not land/)
    const line = h.logs.find((l) => l.level === 'warn' && l.message.includes('migration drain'))
    expect(line?.extras).toMatchObject({ tags: { deviceId: 108 } })

    // The owed write is re-armed on release and lands; the next drain passes.
    await flushDebounce()
    expect(h.writes).toEqual([{ deviceId: 108, blob: { battery: OLD } }])
    const hold = await h.mirror.holdDiskWrites([108], flaky)
    hold.release()
  })

  it('a failed write whose change has since been undone owes nothing — the drain passes', async () => {
    const h = harness()
    h.mirror.seedMirror(108, { battery: OLD })
    let failures = 1
    const flaky: DeviceManagerSettings = {
      ...h.settings,
      writeDeviceRuntimeState: async (deviceId: number, blob: Record<string, unknown>) => {
        if (failures > 0) {
          failures -= 1
          throw new Error('sqlite busy')
        }
        await h.settings.writeDeviceRuntimeState(deviceId, blob)
      },
    }
    h.mirror.applySingleCapUpdate(108, 'battery', NEWER)
    h.mirror.scheduleRuntimeStateDiskWrite(108, flaky, 'battery')
    await flushDebounce() // failed
    h.mirror.applySingleCapUpdate(108, 'battery', OLD) // back to what the row holds

    const hold = await h.mirror.holdDiskWrites([108], flaky)
    hold.release()
    expect(h.writes).toEqual([])
  })

  it('a claim that reaches the row AFTER the hold began is refused by name — it never lands on a row being swapped (final review I-1)', async () => {
    const h = harness()
    h.mirror.seedMirror(108, { battery: OLD })
    const hold = await h.mirror.holdDiskWrites([108], h.settings)

    // Passed the claim methods' migration gate before the migration began; its
    // row read (or its index write) was still pending when the hold went up.
    const claim = {
      owner: 'blk-1',
      mode: 'replace' as const,
      fields: ['percentage'],
      values: { percentage: 90 },
    }
    expect(await h.mirror.claim(108, 'battery', claim, h.settings)).toMatchObject({
      ok: false,
      code: 'migration-in-flight',
    })
    expect(h.mirror.ownedCaps(108).size).toBe(0)
    expect(h.writes).toEqual([])
    hold.release()
  })
})
