/**
 * The last good frame has to outlive the process.
 *
 * The snapshot cache is RAM-only, and its own comment says what that costs:
 * *"after a hub restart this legitimately answers nothing and the generated
 * card is the picture"*. Measured 2026-09-17 — the baby monitor showed the
 * courtesy card all morning because three server updates had emptied the
 * cache, and a sleeping battery camera is never asked for a fresh one: the
 * sentry deliberately never passes `force`, since forcing would wake the
 * very camera the window exists so as not to disturb.
 *
 * So the last frame is written to the addon's own private directory
 * (`ctx.dataDir`, which it owns exclusively) and read back on the next boot.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SnapshotDurableStore } from '../snapshot-durable-store.js'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

describe('SnapshotDurableStore', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snap-durable-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads back what a previous process wrote', async () => {
    const first = new SnapshotDurableStore({ dataDir: dir })
    await first.put(640, JPEG)

    // A DIFFERENT instance, as after a restart — no shared memory.
    const second = new SnapshotDurableStore({ dataDir: dir })
    expect(await second.get(640)).toEqual(JPEG)
  })

  it('answers null for a device it has never seen', async () => {
    expect(await new SnapshotDurableStore({ dataDir: dir }).get(999)).toBeNull()
  })

  /**
   * Snapshots are captured far more often than a restart happens. Writing every
   * one would be disk traffic bought for nothing — the value here is having ONE
   * recent frame, not the newest possible one.
   */
  it('throttles writes per device', async () => {
    const store = new SnapshotDurableStore({ dataDir: dir, minIntervalMs: 60_000 })
    expect(await store.put(640, JPEG)).toBe(true)
    expect(await store.put(640, JPEG), 'a second write inside the window').toBe(false)
  })

  it('does not throttle a DIFFERENT device behind the first', async () => {
    const store = new SnapshotDurableStore({ dataDir: dir, minIntervalMs: 60_000 })
    await store.put(640, JPEG)
    expect(await store.put(587, JPEG)).toBe(true)
  })

  /**
   * A frame that cannot be written must not take a snapshot down with it. The
   * caller already has the picture; persistence is a bonus for the NEXT boot.
   */
  it('reports a failed write instead of throwing', async () => {
    const store = new SnapshotDurableStore({ dataDir: join(dir, 'a-file') })
    writeFileSync(join(dir, 'a-file'), 'not a directory')
    await expect(store.put(640, JPEG)).resolves.toBe(false)
  })

  it('reports an unreadable frame as absent instead of throwing', async () => {
    mkdirSync(join(dir, 'last-frame'), { recursive: true })
    // A directory where the file should be: present, unreadable, not a frame.
    mkdirSync(join(dir, 'last-frame', '640.jpg'), { recursive: true })
    await expect(new SnapshotDurableStore({ dataDir: dir }).get(640)).resolves.toBeNull()
  })

  /**
   * A zero-byte file is not a frame. It reaches the courtesy composer, which
   * asks sharp to overlay it, which throws — and the fallback then paints the
   * card anyway, so the only visible effect is a warning nobody asked for and
   * a decode attempt on nothing. Absent is the truthful answer.
   */
  it('reports a zero-byte frame as absent', async () => {
    mkdirSync(join(dir, 'last-frame'), { recursive: true })
    writeFileSync(join(dir, 'last-frame', '640.jpg'), Buffer.alloc(0))
    await expect(new SnapshotDurableStore({ dataDir: dir }).get(640)).resolves.toBeNull()
  })

  it('survives two writers of the SAME device without losing one silently', async () => {
    // Two stores over one dataDir is not hypothetical: the addon writes
    // fire-and-forget (`void this.durable.put(...)`), so two captures of one
    // camera overlap whenever the second arrives before the first has
    // renamed. With a staging path of `640.jpg.writing` — shared by every
    // writer of that device — the loser renames a file the winner already
    // moved, gets ENOENT, and reports `false` from a bare `catch`. The frame
    // is dropped and nothing anywhere says so.
    const a = new SnapshotDurableStore({ dataDir: dir, minIntervalMs: 0 })
    const b = new SnapshotDurableStore({ dataDir: dir, minIntervalMs: 0 })
    const second = Buffer.concat([JPEG, Buffer.from([7, 7, 7])])

    const outcomes = await Promise.all([a.put(640, JPEG), b.put(640, second)])

    expect(outcomes).toEqual([true, true])
    // Whichever landed last, the file is one of the two WHOLE payloads — never
    // a mix, and never absent.
    const landed = await new SnapshotDurableStore({ dataDir: dir }).get(640)
    expect([JPEG.toString('hex'), second.toString('hex')]).toContain(landed?.toString('hex'))
    // And no staging file is left behind for the next reader to trip over.
    expect(readdirSync(join(dir, 'last-frame'))).toEqual(['640.jpg'])
  })

  it('keeps one file per device, not a growing history', async () => {
    const store = new SnapshotDurableStore({ dataDir: dir, minIntervalMs: 0 })
    await store.put(640, JPEG)
    await store.put(640, Buffer.concat([JPEG, Buffer.from([9])]))
    expect(readdirSync(join(dir, 'last-frame'))).toEqual(['640.jpg'])
  })
})
