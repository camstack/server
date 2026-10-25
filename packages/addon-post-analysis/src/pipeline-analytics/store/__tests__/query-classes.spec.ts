import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { TRACKS_COLLECTION, TrackStore } from '../track-store.js'

/**
 * The class filter runs in the STORE, not in the client.
 *
 * `listTracks` accepted `deviceId`, time, `limit`, `zone`, `projection` and
 * `includeStationary` — no class. So the viewer downloaded a day of tracks and
 * threw most away in memory whenever a class chip was active. The zone filter
 * had already been moved server-side for exactly this reason, and it is also
 * what lets the rows come back `slim`; the class filter was left behind.
 *
 * ## The contract these tests pin
 *
 * The store is a SUPERSET prefilter, not the exact rule: it must never return
 * a row that cannot match, and must never DROP a row that might. The client's
 * `filterDetectionsByClass` stays the exact rule — same division of labour the
 * zone filter already uses (server prefilters on the persisted envelope, the
 * client runs the per-position test).
 *
 * That is why the filter reads `classes[]` and not `className`. Measured on
 * the live hub over 24 h (devices 102/101/104, 1021 tracks): 0.5% of tracks
 * carry a class their `className` does not name, and 5.5% have no usable
 * `classes[]` at all. A `whereIn className` would have hidden the first group
 * while looking like it worked.
 */
const DEVICE = 101

interface SeedRow {
  readonly id: string
  readonly className: string
  /** Omit to seed a row that predates the column — it must be KEPT. */
  readonly classes?: readonly string[]
}

function seed(fake: FakeSettingsStore, rows: readonly SeedRow[]): void {
  fake.seed(
    TRACKS_COLLECTION,
    rows.map((r, i) => ({
      id: r.id,
      data: {
        deviceId: DEVICE,
        className: r.className,
        ...(r.classes !== undefined ? { classes: [...r.classes] } : {}),
        firstSeen: 1_000 + i,
        lastSeen: 2_000 + i,
        positions: [],
        snapshots: [],
      },
    })),
  )
}

const idsOf = (rows: readonly { trackId?: string; id?: string }[]): string[] =>
  rows.map((r) => String(r.trackId ?? r.id)).toSorted()

describe('TrackStore.queryHistorical — class filter', () => {
  let fake: FakeSettingsStore
  let store: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
    seed(fake, [
      { id: 't1', className: 'person', classes: ['person'] },
      { id: 't2', className: 'vehicle', classes: ['vehicle'] },
      { id: 't3', className: 'animal', classes: ['animal'] },
      { id: 't4', className: 'person', classes: ['person'] },
    ])
  })

  it('drops the rows that cannot match', async () => {
    const rows = await store.queryHistorical({ deviceId: DEVICE, classes: ['person'] })
    expect(idsOf(rows)).toEqual(['t1', 't4'])
  })

  it('accepts several classes at once', async () => {
    const rows = await store.queryHistorical({ deviceId: DEVICE, classes: ['vehicle', 'animal'] })
    expect(idsOf(rows)).toEqual(['t2', 't3'])
  })

  it('answers empty for a class this camera has none of', async () => {
    expect(await store.queryHistorical({ deviceId: DEVICE, classes: ['boat'] })).toHaveLength(0)
  })

  it('returns EVERYTHING when the filter is absent — the existing contract', async () => {
    expect(await store.queryHistorical({ deviceId: DEVICE })).toHaveLength(4)
  })

  it('treats an EMPTY list as "no filter", never as "nothing matches"', async () => {
    // A UI with every chip cleared means "show all"; answering with an empty
    // timeline would read as a camera that saw nothing.
    expect(await store.queryHistorical({ deviceId: DEVICE, classes: [] })).toHaveLength(4)
  })
})

describe('TrackStore.queryHistorical — the prefilter never hides', () => {
  let fake: FakeSettingsStore
  let store: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
    seed(fake, [
      // The 0.5% case, measured on device 104: className says one thing, the
      // track ALSO saw another. Selecting the second class must keep it.
      { id: 'ambiguous', className: 'person', classes: ['person', 'animal'] },
      // The 5.5% case: no usable classes[]. Unknown is not "does not match".
      { id: 'legacy', className: 'person' },
      { id: 'plainVehicle', className: 'vehicle', classes: ['vehicle'] },
    ])
  })

  it('keeps a track whose className disagrees with the selected class', async () => {
    const rows = await store.queryHistorical({ deviceId: DEVICE, classes: ['animal'] })
    expect(idsOf(rows)).toContain('ambiguous')
  })

  it('keeps a row that carries no classes[] at all', async () => {
    const rows = await store.queryHistorical({ deviceId: DEVICE, classes: ['animal'] })
    expect(idsOf(rows)).toContain('legacy')
  })

  it('still drops what genuinely cannot match', async () => {
    const rows = await store.queryHistorical({ deviceId: DEVICE, classes: ['animal'] })
    expect(idsOf(rows)).not.toContain('plainVehicle')
  })
})

/**
 * The zone path runs its own pair of queries (envelope-overlap + NULL-envelope).
 * A class filter applied to only one of them works until the operator draws a
 * zone and then quietly stops — the kind of half-fix that reads as a flaky
 * feature rather than a bug.
 */
describe('TrackStore.queryHistorical — class filter WITH a zone drawn', () => {
  let fake: FakeSettingsStore
  let store: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
    seed(fake, [
      { id: 'z1', className: 'person', classes: ['person'] },
      { id: 'z2', className: 'vehicle', classes: ['vehicle'] },
    ])
  })

  it('still drops what cannot match', async () => {
    const rows = await store.queryHistorical({
      deviceId: DEVICE,
      classes: ['person'],
      zone: { kind: 'rect', x: 0, y: 0, width: 1, height: 1 },
    })
    expect(idsOf(rows)).not.toContain('z2')
  })
})

/**
 * The SCOPED feed (`queryRecent`, the multi-camera timeline) takes the same
 * filter.
 *
 * One filter must not have two costs. Before this, drawing a class chip
 * narrowed the READ on a single camera and narrowed a DOWNLOADED page on
 * twelve — the same fix the single-camera path already got, missing on the
 * path that fetches from more cameras at once.
 */
describe('TrackStore.queryRecent — the same class filter', () => {
  let fake: FakeSettingsStore
  let store: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
    seed(fake, [
      { id: 'r1', className: 'person', classes: ['person'] },
      { id: 'r2', className: 'vehicle', classes: ['vehicle'] },
      { id: 'r3', className: 'person', classes: ['person', 'animal'] },
      { id: 'r4', className: 'person' },
    ])
  })

  it('drops the rows that cannot match', async () => {
    const page = await store.queryRecent({ deviceIds: [DEVICE], classes: ['person'] })
    expect(idsOf(page.tracks)).not.toContain('r2')
  })

  it('keeps the ambiguous row and the one with no classes[] — superset, as ever', async () => {
    const page = await store.queryRecent({ deviceIds: [DEVICE], classes: ['animal'] })
    expect(idsOf(page.tracks)).toContain('r3')
    expect(idsOf(page.tracks)).toContain('r4')
  })

  it('treats an EMPTY list as no filter', async () => {
    const page = await store.queryRecent({ deviceIds: [DEVICE], classes: [] })
    expect(page.tracks).toHaveLength(4)
  })
})
