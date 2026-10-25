/**
 * "Is this eviction taking the WHOLE hour?" is a question about the DIRECTORY,
 * and neither the resident index nor a durable row may answer it.
 *
 * `SegmentStore.evict` has a fast path (R4): when a round's victims cover every
 * segment an hour bucket holds, one `rm -rf` of the directory replaces hundreds
 * of per-file deletes. Deciding "every segment it holds" is the whole safety of
 * that branch, and it has been decided wrongly twice.
 *
 * First from `RecordingIndex.bucketCounts` — RAM. That index holds the live
 * tail plus whatever a reader hydrated, so for a closed hour the resident count
 * is a FRACTION of what the disk holds. The comparison is short on BOTH sides
 * at once — the resident count and the resident victims — so it comes out
 * EQUAL, the branch fires, and the `rm -rf` takes every file the round never
 * enumerated. Those files leave disk; their durable hour accounts do not,
 * because `onDeindexed` is fed the rows the caller listed, never what the
 * filesystem actually lost. That is a ghost-row factory, and it is the one
 * deleter in this repo that can remove more than it names.
 *
 * Then from the hour ledger's `paths` column, which fails in the same shape: a
 * writer torn down mid-hour leaves the row short of the files it wrote. D523
 * removed that column outright — the directory tree is the authority for WHICH
 * segments exist, the table only for HOW MUCH — so the cover test is now asked
 * of the very directory the `rm -rf` will take (`hourDirectoryPaths`).
 *
 * The residency guard's allowlist asserted the opposite in prose —
 * *"under-residency makes the count 0 or short and `bucketFullyEvicted` then
 * returns false … the failure direction is a leftover empty directory, never a
 * deleted one that still held files"* — which is true only when ONE side of the
 * comparison shrinks. A justification nobody tested is exactly the paragraph
 * D295 says to replace with a guard.
 *
 * So: the directory listing decides, and a listing that cannot be had REFUSES
 * the fast path rather than falling back to the index (D295 rule 3).
 */
import { describe, expect, it } from 'vitest'
import { RecordingIndex } from '../recording-index.js'
import { segmentRelPath } from '../segment-path.js'
import { SegmentStore, type SegmentStoreDeps } from '../segment-store.js'
import type { SegmentRow } from '../types.js'

const HOUR_MS = 3_600_000
const HOUR0 = 1_700_000_000_000 - (1_700_000_000_000 % HOUR_MS)
const DEVICE = 1441
const PROFILE = 'low'
const LOCATION = 'recordingsLow:default'
/** Well past the bucket's hour: the current-hour guard is not what is on trial. */
const NOW = HOUR0 + 10 * HOUR_MS

function hourRows(count: number): SegmentRow[] {
  return Array.from({ length: count }, (_, i) => {
    const startMs = HOUR0 + i * 10_000
    const bytes = 500_000 + i
    return {
      deviceId: DEVICE,
      profile: PROFILE,
      startMs,
      durMs: 10_000,
      bytes,
      path: segmentRelPath(DEVICE, PROFILE, startMs, 10_000, bytes),
      locationId: LOCATION,
    }
  })
}

interface Harness {
  readonly store: SegmentStore
  readonly removedDirs: string[]
  readonly deletedPaths: string[]
  readonly deindexed: string[]
}

/**
 * The fixture shape that matters: a PARTIAL index and a FULLER directory. A
 * fixture where the two agree is what let this ship — every assertion below
 * passes under the defect when residency is complete.
 */
function harness(
  resident: readonly SegmentRow[],
  hourDirectory: readonly string[] | null,
  hasListing = true,
): Harness {
  const index = new RecordingIndex()
  for (const row of resident) index.addSegment(row)
  const removedDirs: string[] = []
  const deletedPaths: string[] = []
  const deindexed: string[] = []
  const deps: SegmentStoreDeps = {
    index,
    list: async () => [],
    deletePath: async ({ relativePath }) => {
      deletedPaths.push(relativePath)
    },
    statBytes: async () => 0,
    moveFile: async () => {},
    removeDir: async (_location, relDir) => {
      removedDirs.push(relDir)
    },
    onDeindexed: (rows) => {
      for (const row of rows) deindexed.push(row.path)
    },
    now: () => NOW,
    ...(hasListing
      ? { hourDirectoryPaths: async (): Promise<readonly string[] | null> => hourDirectory }
      : {}),
    logger: { warn: () => {}, info: () => {} },
  }
  return { store: new SegmentStore(deps), removedDirs, deletedPaths, deindexed }
}

describe('the eviction bucket fast path asks the DIRECTORY, never the resident index', () => {
  it('refuses the rm -rf when the directory holds more than this round enumerated', async () => {
    const all = hourRows(5)
    const victims = [all[0]!]
    // The production residency for a closed hour: one row a reader touched.
    const { store, removedDirs, deletedPaths, deindexed } = harness(
      victims,
      all.map((r) => r.path),
    )

    await store.evict(LOCATION, victims)

    // The whole hour directory must NOT go: four files in it were never named.
    expect(removedDirs).toEqual([])
    expect(deletedPaths).toEqual([victims[0]!.path])
    // And what the ledger is told still equals what actually left disk.
    expect(deindexed).toEqual([victims[0]!.path])
  })

  it('still takes the rm -rf when the DIRECTORY agrees the round covers the hour', async () => {
    // R4 exists for a reason — 360 `storage.delete` round trips per hour — so
    // the fix must not be "delete the fast path".
    const all = hourRows(5)
    const { store, removedDirs, deletedPaths, deindexed } = harness(
      [all[0]!],
      all.map((r) => r.path),
    )

    await store.evict(LOCATION, all)

    expect(removedDirs).toEqual([`${DEVICE}/${PROFILE}/${bucketOf(all[0]!)}`])
    expect(deletedPaths).toEqual([])
    expect(deindexed).toHaveLength(5)
  })

  it('a listing that cannot be had REFUSES the fast path — it does not fall back to the index', async () => {
    const all = hourRows(5)
    const { store, removedDirs, deletedPaths } = harness([all[0]!], null)

    await store.evict(LOCATION, all)

    expect(removedDirs).toEqual([])
    expect(deletedPaths).toHaveLength(5)
  })

  it('a directory that lists NOTHING is not a licence to rm -rf it', async () => {
    // `[].every(...)` is vacuously true, so an empty cover set reads as "the
    // round covers everything". It does not: a listing that names no file while
    // a round holds victims for that hour means the listing is BEHIND the disk
    // (a racing reader, a mount that came back empty), which is the one state
    // in which a recursive delete is guaranteed to take files nobody
    // enumerated.
    const all = hourRows(5)
    const { store, removedDirs, deletedPaths } = harness([all[0]!], [])

    await store.evict(LOCATION, all)

    expect(removedDirs).toEqual([])
    expect(deletedPaths).toHaveLength(5)
  })

  it('a node with NO listing wired at all evicts per file', async () => {
    const all = hourRows(5)
    const { store, removedDirs, deletedPaths } = harness([all[0]!], null, false)

    await store.evict(LOCATION, all)

    expect(removedDirs).toEqual([])
    expect(deletedPaths).toHaveLength(5)
  })
})

/** `YYYY/MM/DD/HH` of a row, from the path the repo already names it by. */
function bucketOf(row: SegmentRow): string {
  const parts = row.path.split('/')
  return parts.slice(2, 6).join('/')
}
