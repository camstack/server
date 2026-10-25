/**
 * `excludeSources` — track PROVENANCE as a real query filter.
 *
 * ## What was broken
 *
 * There was no source dimension on either track query, so a client that wanted
 * "not the synthetic projections" had to say it in the only vocabulary
 * available: `classes`. That vocabulary cannot express it, and trying produced
 * a filter that silently did the opposite.
 *
 * A synthetic row (`source: 'audio' | 'sensor'`) carried no accumulated
 * `classes[]` at all, and `classes` compiles to `whereJsonArrayAny`, a
 * DELIBERATE superset that keeps a row whose column it cannot read. Measured
 * against the live hub (devices 101 + 104, one day):
 *
 *   classes: ['person']   → 500 rows, incl. 66 contact + 11 doorbell + 29 audio
 *   classes: ['contact']  → 116 rows, ALL of them synthetic, none by its class
 *   classes: ['sensor']   → the identical 116
 *   classes: ['audio']    → the identical 116
 *   classes: ['nope']     → the identical 116
 *
 * A class that exists nowhere answered the same set as every real selection:
 * the chips were not selecting anything, they were failing to exclude the rows
 * the escape hatch keeps. That is the operator's "the sensor and control
 * filters do not work".
 *
 * ## What these tests pin
 *
 * Unlike `classes`, this filter is EXACT — a source filter whose whole purpose
 * is hiding a population must never keep one "just in case". The awkward part
 * is that the column is NULLABLE: a pipeline track writes no `source`, so
 * every fixture below holds pipeline rows written BOTH ways (an explicit
 * `null` and a row that never wrote the column). A fixture where the pipeline
 * rows all carried a value would pass against a compilation that drops NULLs,
 * which is the whole defect.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { trackSourceFilter } from '../track-source-filter.js'
import { TRACKS_COLLECTION, TrackStore } from '../track-store.js'

const DEVICE = 101

interface SeedRow {
  readonly id: string
  readonly className: string
  /** Omit entirely to seed a pipeline row that never WROTE the column. */
  readonly source?: string | null
}

/** Two pipeline rows shaped differently, two audio, two sensor. */
const ROWS: readonly SeedRow[] = [
  { id: 'p-unwritten', className: 'person' },
  { id: 'p-null', className: 'vehicle', source: null },
  { id: 'a-1', className: 'audio', source: 'audio' },
  { id: 'a-2', className: 'audio', source: 'audio' },
  { id: 's-contact', className: 'contact', source: 'sensor' },
  { id: 's-doorbell', className: 'doorbell', source: 'sensor' },
]

function seed(fake: FakeSettingsStore): void {
  fake.seed(
    TRACKS_COLLECTION,
    ROWS.map((r, i) => ({
      id: r.id,
      data: {
        deviceId: DEVICE,
        className: r.className,
        ...('source' in r ? { source: r.source } : {}),
        firstSeen: 1_000 + i,
        lastSeen: 2_000 + i,
        positions: [],
        snapshots: [],
      },
    })),
  )
}

const ids = (rows: readonly { trackId: string }[]): string[] =>
  rows.map((r) => r.trackId).toSorted()

describe('trackSourceFilter — the compiled predicate', () => {
  it('adds no predicate when nothing is excluded', () => {
    expect(trackSourceFilter(undefined).kind).toBe('none')
    expect(trackSourceFilter([]).kind).toBe('none')
  })

  it('excludes the synthetic sources NULL-safely, so pipeline rows survive', () => {
    expect(trackSourceFilter(['audio'])).toEqual({
      kind: 'filter',
      filter: { whereNotIn: { source: ['audio'] } },
    })
  })

  it('turns into a POSITIVE membership test when pipeline itself is excluded', () => {
    // A NULL-safe exclusion would keep exactly the rows being excluded here:
    // pipeline rows carry no value, so `IS NULL OR NOT IN (…)` is true for
    // every one of them. The positive form names what survives instead.
    // `onboard` is here because it is a real, persisted source with a value of
    // its own — the camera's firmware — not because the list grew by accident.
    expect(trackSourceFilter(['pipeline'])).toEqual({
      kind: 'filter',
      filter: { whereIn: { source: ['onboard', 'sensor', 'audio'] } },
    })
  })

  it('reports excluding everything as impossible rather than compiling it away', () => {
    // Every empty form in this filter language means "no narrowing", so a
    // predicate that excluded all three would vanish and answer with the whole
    // collection — the loudest possible version of the bug being fixed.
    expect(trackSourceFilter(['pipeline', 'onboard', 'sensor', 'audio']).kind).toBe('impossible')
  })

  it('ignores a source this build has never heard of', () => {
    // The list crosses a wire from a client whose enum may be newer.
    const result = trackSourceFilter(['audio', 'telepathy'] as never)
    expect(result).toEqual({ kind: 'filter', filter: { whereNotIn: { source: ['audio'] } } })
  })
})

describe('TrackStore.queryHistorical — excludeSources', () => {
  let fake: FakeSettingsStore
  let store: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
    seed(fake)
  })

  it('returns every source when the filter is absent', async () => {
    const rows = await store.queryHistorical({ deviceId: DEVICE, limit: 50 })
    expect(rows).toHaveLength(6)
  })

  it('hides audio rows and keeps BOTH shapes of pipeline row', async () => {
    const rows = await store.queryHistorical({
      deviceId: DEVICE,
      limit: 50,
      excludeSources: ['audio'],
    })
    expect(ids(rows)).toEqual(['p-null', 'p-unwritten', 's-contact', 's-doorbell'])
  })

  it('hides both synthetic sources at once — the thing whereNot could not say', async () => {
    const rows = await store.queryHistorical({
      deviceId: DEVICE,
      limit: 50,
      excludeSources: ['audio', 'sensor'],
    })
    expect(ids(rows)).toEqual(['p-null', 'p-unwritten'])
  })

  it('is EXACT, unlike the class filter it replaces', async () => {
    // The proof that the two filters are not interchangeable: a class
    // selection keeps every synthetic row (their `classes[]` is unreadable),
    // and the source filter is what actually removes them.
    const byClass = await store.queryHistorical({
      deviceId: DEVICE,
      limit: 50,
      classes: ['person'],
    })
    expect(ids(byClass)).toContain('a-1')
    const both = await store.queryHistorical({
      deviceId: DEVICE,
      limit: 50,
      classes: ['person'],
      excludeSources: ['audio', 'sensor'],
    })
    expect(ids(both)).not.toContain('a-1')
  })

  it('applies to the ZONE path too, where a synthetic row always matches', async () => {
    // A synthetic track has no positions, so it has no envelope, so it lands
    // in the NULL-envelope branch and matches every zone. Omitting the filter
    // there would make drawing a zone the one gesture that puts every hidden
    // marker back.
    const rows = await store.queryHistorical({
      deviceId: DEVICE,
      limit: 50,
      zone: { kind: 'rect', x: 0, y: 0, width: 1, height: 1 },
      excludeSources: ['audio', 'sensor'],
    })
    expect(ids(rows)).toEqual(['p-null', 'p-unwritten'])
  })

  it('answers nothing when every source is excluded', async () => {
    expect(
      await store.queryHistorical({
        deviceId: DEVICE,
        limit: 50,
        excludeSources: ['pipeline', 'sensor', 'audio'],
      }),
    ).toHaveLength(0)
  })
})

describe('TrackStore.queryRecent — excludeSources', () => {
  let fake: FakeSettingsStore
  let store: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
    seed(fake)
  })

  it('narrows the merged page — the events feed reads this one', async () => {
    const page = await store.queryRecent({
      deviceIds: [DEVICE],
      limit: 50,
      excludeSources: ['audio'],
    })
    expect(ids(page.tracks)).toEqual(['p-null', 'p-unwritten', 's-contact', 's-doorbell'])
  })

  it('narrows the READ, so paging does not lie about how much is left', async () => {
    // The rows are dropped by the query, not after it: a page of 2 that had
    // been filtered on the client would have arrived as 2 minus the audio
    // rows, and the cursor would have promised a page the operator never gets.
    const page = await store.queryRecent({
      deviceIds: [DEVICE],
      limit: 2,
      excludeSources: ['audio', 'sensor'],
    })
    expect(page.tracks).toHaveLength(2)
    expect(ids(page.tracks)).toEqual(['p-null', 'p-unwritten'])
  })

  it('answers an empty page with no cursor when every source is excluded', async () => {
    const page = await store.queryRecent({
      deviceIds: [DEVICE],
      limit: 50,
      excludeSources: ['pipeline', 'sensor', 'audio'],
    })
    expect(page.tracks).toHaveLength(0)
    expect(page.nextCursor).toBeNull()
  })
})
