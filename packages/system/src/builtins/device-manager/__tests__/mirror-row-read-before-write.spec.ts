/**
 * The row writer never writes a row this process has not READ (D677).
 *
 * A runtime-state row write REPLACES the whole row. At hub boot the
 * orchestrator's `zones` hydration reached the mirror before the camera's
 * provider had loaded it; the claims index vouched for the device (no claims),
 * the mirror called it seeded without reading, and the 1 s writer replaced the
 * stored row with the one slice memory held. 159 shrinks on 15 cameras at 65 of
 * 82 restarts — every restored cap nobody re-wrote soon after boot, erased, and
 * not one log line.
 *
 * Neutralisation (each goes red on its own): drop the read in
 * `MirrorRowWriter.rowReadOrRefuse` (let it answer true), or drop the
 * dropped-caps warn in `writeRow`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStatePolicy } from '@camstack/types'
import { MirrorRowWriter, RuntimeStateDrainError } from '../mirror-row-writer.js'
import { flushDebounce, harness, loadedIndex, POLICY } from './mirror-harness.js'

const DOORBELL = { pressCountSinceStart: 7, lastPressedAt: 1_790_000_000_000 }
const BATTERY = { percentage: 40, lastUpdated: 1 }
const ZONES = { zones: [{ id: 'z1' }] }
const STORED = { battery: BATTERY, doorbell: DOORBELL }
const UNREAD = 'runtime-state row write refused'
const DROPS = 'runtime-state row write DROPS caps'

/** The harness table plus `doorbell`, whose durability a test may demote. */
function mutablePolicy(): {
  lookup: (cap: string) => RuntimeStatePolicy
  demote: (cap: string) => void
} {
  const table: Record<string, RuntimeStatePolicy> = {
    ...POLICY,
    doorbell: { durability: 'restored', volatileFields: [] },
  }
  return {
    lookup: (cap) => table[cap] ?? { durability: 'session', volatileFields: [] },
    demote: (cap) => {
      table[cap] = { durability: 'session', volatileFields: [] }
    },
  }
}

describe('the row writer reads before it writes (D677)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a slice written before ANY read at boot: the stored row’s other caps survive the writer', async () => {
    const p = mutablePolicy()
    const h = harness(p.lookup)
    h.rows.set(7, STORED)

    h.mirror.applySingleCapUpdate(7, 'zones', ZONES)
    h.mirror.scheduleRuntimeStateDiskWrite(7, h.settings, 'zones')
    await flushDebounce()

    expect(h.writes).toEqual([{ deviceId: 7, blob: { ...STORED, zones: ZONES } }])
    // Memory learnt the row too: a later read of the device answers it.
    expect(h.mirror.capSlice(7, 'doorbell')).toEqual(DOORBELL)
  })

  it('memory wins per cap over the row it fills (fill semantics kept)', async () => {
    const p = mutablePolicy()
    const h = harness(p.lookup)
    h.rows.set(7, STORED)
    const fresher = { percentage: 12, lastUpdated: 2 }

    h.mirror.applySingleCapUpdate(7, 'battery', fresher)
    h.mirror.scheduleRuntimeStateDiskWrite(7, h.settings, 'battery')
    await flushDebounce()

    expect(h.writes).toEqual([{ deviceId: 7, blob: { battery: fresher, doorbell: DOORBELL } }])
  })

  it('refuses a device the index vouched for while its row cannot be read: no write, one tagged warn per episode, a backed-off re-arm', async () => {
    const p = mutablePolicy()
    const h = harness(p.lookup)
    h.rows.set(7, STORED)
    h.failReads.add(7)
    const reads = vi.spyOn(h.settings, 'readDeviceRuntimeState')
    await h.mirror.ensureSeeded(7, h.settings, loadedIndex([])) // claims known, row NOT read
    expect(reads).not.toHaveBeenCalled()

    h.mirror.applySingleCapUpdate(7, 'zones', ZONES)
    h.mirror.scheduleRuntimeStateDiskWrite(7, h.settings, 'zones')
    await vi.advanceTimersByTimeAsync(1_000) // the debounce fires: read 1, refused
    expect(reads).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000) // re-armed after 1 s: read 2
    expect(reads).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_999) // then 2 s — not yet
    expect(reads).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1) // read 3
    expect(reads).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(4_000) // then 4 s: read 4 — a backoff, never 1 Hz
    expect(reads).toHaveBeenCalledTimes(4)

    expect(h.writes).toEqual([])
    const refusals = h.logs.filter((l) => l.message.startsWith(UNREAD))
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.level).toBe('warn')
    expect(refusals[0]?.extras).toMatchObject({
      tags: { deviceId: 7 },
      meta: { path: 'debounced', error: 'sqlite busy' },
    })

    // The read comes back: the re-armed writer merges the row and writes it.
    h.failReads.delete(7)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(h.writes).toEqual([{ deviceId: 7, blob: { ...STORED, zones: ZONES } }])
  })

  it('the backoff is capped at 60 s', () => {
    expect(MirrorRowWriter.unreadRearmDelayMs(1)).toBe(1_000)
    expect(MirrorRowWriter.unreadRearmDelayMs(3)).toBe(4_000)
    expect(MirrorRowWriter.unreadRearmDelayMs(7)).toBe(60_000)
    expect(MirrorRowWriter.unreadRearmDelayMs(50)).toBe(60_000)
  })

  it('a migration drain after a TRANSIENT unread refusal writes once the row reads (L4)', async () => {
    const p = mutablePolicy()
    const h = harness(p.lookup)
    h.rows.set(7, STORED)
    h.failReads.add(7)
    h.mirror.applySingleCapUpdate(7, 'zones', ZONES)
    h.mirror.scheduleRuntimeStateDiskWrite(7, h.settings, 'zones')
    await vi.advanceTimersByTimeAsync(1_000) // refused once, re-armed
    h.failReads.delete(7)

    const hold = await h.mirror.holdDiskWrites([7], h.settings)
    hold.release()
    expect(h.writes).toEqual([{ deviceId: 7, blob: { ...STORED, zones: ZONES } }])
  })

  it('forgetDevice cancels an armed write and drops memory: no orphan row after removal (L3)', async () => {
    const p = mutablePolicy()
    const h = harness(p.lookup)
    h.mirror.seedMirror(7, STORED)
    h.mirror.applySingleCapUpdate(7, 'zones', ZONES)
    h.mirror.scheduleRuntimeStateDiskWrite(7, h.settings, 'zones')

    await h.mirror.forgetDevice(7)
    await flushDebounce()

    expect(h.writes).toEqual([])
    expect(h.mirror.snapshotForDevice(7)).toEqual({})
    expect(h.mirror.isSeeded(7)).toBe(false)
    expect(h.mirror.isRowRead(7)).toBe(false)
  })

  it('the shutdown flush reads first too, and writes nothing when it cannot', async () => {
    const p = mutablePolicy()
    const h = harness(p.lookup)
    h.rows.set(7, STORED)
    h.rows.set(8, STORED)
    h.failReads.add(8)
    for (const id of [7, 8]) {
      h.mirror.applySingleCapUpdate(id, 'zones', ZONES)
      h.mirror.scheduleRuntimeStateDiskWrite(id, h.settings, 'zones')
    }

    await h.mirror.flushPendingWrites(h.settings)

    expect(h.writes).toEqual([{ deviceId: 7, blob: { ...STORED, zones: ZONES } }])
    expect(h.logs.filter((l) => l.message.startsWith(UNREAD))[0]?.extras).toMatchObject({
      tags: { deviceId: 8 },
      meta: { path: 'shutdown-flush' },
    })
  })

  it('a migration drain over a row it cannot read refuses by name, writing nothing', async () => {
    const p = mutablePolicy()
    const h = harness(p.lookup)
    h.failReads.add(7)
    h.mirror.applySingleCapUpdate(7, 'zones', ZONES)
    h.mirror.scheduleRuntimeStateDiskWrite(7, h.settings, 'zones')

    await expect(h.mirror.holdDiskWrites([7], h.settings)).rejects.toBeInstanceOf(
      RuntimeStateDrainError,
    )
    expect(h.writes).toEqual([])
  })

  it('TRIPWIRE: a write that DROPS a cap the stored row holds is named at warn with tags.deviceId', async () => {
    const p = mutablePolicy()
    const h = harness(p.lookup)
    h.mirror.seedMirror(7, STORED)
    // No production path drops a cap once the row was read (a demotion ships
    // in code and is already out of the baseline at boot). A policy flipped
    // mid-process is simply the one lever a test has to make memory lose a cap.
    p.demote('doorbell')

    h.mirror.applySingleCapUpdate(7, 'battery', { percentage: 12, lastUpdated: 2 })
    h.mirror.scheduleRuntimeStateDiskWrite(7, h.settings, 'battery')
    await flushDebounce()

    expect(h.writes).toEqual([
      { deviceId: 7, blob: { battery: { percentage: 12, lastUpdated: 2 } } },
    ])
    const drops = h.logs.filter((l) => l.message.startsWith(DROPS))
    expect(drops).toHaveLength(1)
    expect(drops[0]?.level).toBe('warn')
    expect(drops[0]?.extras).toMatchObject({
      tags: { deviceId: 7 },
      meta: { path: 'debounced', dropped: ['doorbell'], storedCaps: 2, writtenCaps: 1 },
    })
  })

  it('a write that keeps every stored cap logs no drop', async () => {
    const p = mutablePolicy()
    const h = harness(p.lookup)
    h.mirror.seedMirror(7, STORED)
    h.mirror.applySingleCapUpdate(7, 'zones', ZONES)
    h.mirror.scheduleRuntimeStateDiskWrite(7, h.settings, 'zones')
    await flushDebounce()

    expect(h.writes).toHaveLength(1)
    expect(h.logs.filter((l) => l.message.startsWith(DROPS))).toEqual([])
  })
})
