/**
 * Finalize-time mfra capture. The parse itself is `mfra-index`'s own spec —
 * what is pinned here is the FILE path (head + tail reads against a real
 * captured index) and the store's TTL bound.
 */
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { readMfraTable, isMfraTableServable, MfraTableStore } from '../mfra-capture.js'

const here = path.dirname(fileURLToPath(import.meta.url))
/**
 * Real captured bytes, owned by THIS suite.
 *
 * They used to be reached at `../../../embed/src/playback/__tests__/fixtures`,
 * inside a tree that moved to the viewer repo in 5bc2ec230 — which deleted them
 * and left this test red, reading a path nothing produces. A fixture a suite
 * depends on lives with the suite; reaching across a package boundary for one
 * is how it goes missing without anyone noticing.
 */
const FIXTURES = path.join(here, 'fixtures')

const tmpDirs: string[] = []
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })))
})

describe('readMfraTable', () => {
  it('reads the video sync-sample table off a real head + tail', async () => {
    // A synthetic segment with the REAL captured init at the head and the REAL
    // captured index at the tail — the shapes the parsers actually meet.
    const init = new Uint8Array(await readFile(path.join(FIXTURES, 'init-h264-low.bin')))
    const tail = new Uint8Array(await readFile(path.join(FIXTURES, 'tfra-h264-low.bin')))
    const fileBytes = 72_905
    const file = new Uint8Array(fileBytes)
    file.set(init.subarray(0, Math.min(init.length, 4096)), 0)
    file.set(tail, fileBytes - tail.length)

    const dir = await mkdtemp(path.join(tmpdir(), 'mfra-capture-'))
    tmpDirs.push(dir)
    const abs = path.join(dir, 'seg.m4s')
    await writeFile(abs, file)

    const table = await readMfraTable(abs, fileBytes)
    expect(table.samples.length).toBeGreaterThan(0)
    expect(table.mfraOffset).toBeLessThan(fileBytes)
    // Ascending offsets — the property fragmentRangeFor depends on.
    for (let i = 1; i < table.samples.length; i++) {
      expect(table.samples[i]!.moofOffset).toBeGreaterThan(table.samples[i - 1]!.moofOffset)
    }
  })

  it('throws on a file with no index, so the caller records nothing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mfra-capture-'))
    tmpDirs.push(dir)
    const abs = path.join(dir, 'junk.m4s')
    await writeFile(abs, new Uint8Array(8192))
    await expect(readMfraTable(abs, 8192)).rejects.toThrow()
  })
})

describe('MfraTableStore', () => {
  const table = { trackId: 1, mfraOffset: 1000, samples: [{ timeTicks: 0, moofOffset: 64 }] }

  it('serves what finalize recorded, per (device, profile, start)', () => {
    const store = new MfraTableStore(() => 1_785_300_000_000)
    store.record(104, 'low', 1_785_299_000_000, table)
    expect(store.get(104, 'low', 1_785_299_000_000)).toEqual(table)
    expect(store.get(104, 'high', 1_785_299_000_000)).toBeUndefined()
    expect(store.get(591, 'low', 1_785_299_000_000)).toBeUndefined()
  })

  it('prunes entries past the retention window, so RAM stays O(day)', () => {
    let now = 1_785_300_000_000
    const store = new MfraTableStore(() => now)
    store.record(104, 'low', now - 1000, table)
    now += 27 * 3_600_000 // beyond the 26 h retention
    store.record(104, 'low', now - 1000, table)
    expect(store.get(104, 'low', 1_785_300_000_000 - 1000)).toBeUndefined()
    expect(store.size).toBe(1)
  })
})

/**
 * The bulk-recovery guard (D160).
 *
 * The D148 staging reconcile finalizes tens of thousands of segments that are
 * WEEKS old. Every one of them used to trigger a capture: an unawaited `open` +
 * two reads on the same 4-thread libuv pool the live SegmentWriters' finalize
 * I/O shares, for a table this store can never serve.
 */
describe('mfra capture window', () => {
  const now = 1_785_300_000_000
  const table = { trackId: 1, mfraOffset: 1000, samples: [{ timeTicks: 0, moofOffset: 64 }] }

  it('a live segment is servable, one past the window is not', () => {
    expect(isMfraTableServable(now - 1000, now)).toBe(true)
    expect(isMfraTableServable(now - 25 * 3_600_000, now)).toBe(true)
    expect(isMfraTableServable(now - 27 * 3_600_000, now)).toBe(false)
    expect(isMfraTableServable(now - 41 * 24 * 3_600_000, now)).toBe(false)
  })

  it('refuses to store a segment already past the window', () => {
    const store = new MfraTableStore(() => now)
    store.record(104, 'low', now - 41 * 24 * 3_600_000, table)
    expect(store.size).toBe(0)
  })

  it('does not grow without bound when old entries arrive AFTER live ones', () => {
    // `prune` walks the insertion-ordered prefix and stops at the first live
    // entry, so an expired entry appended behind one is unreachable forever.
    // A recovery pass appends thousands of exactly that shape.
    const store = new MfraTableStore(() => now)
    store.record(104, 'low', now - 1000, table)
    for (let i = 0; i < 500; i++) store.record(104, 'low', now - (30 + i) * 3_600_000, table)
    expect(store.size).toBe(1)
  })
})
