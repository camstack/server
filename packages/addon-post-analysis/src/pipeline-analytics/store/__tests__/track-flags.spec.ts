/**
 * Per-track operator flags — the retrain LIFECYCLE (`markForTrain`) and `debug`.
 *
 * `debug` is a boolean an operator sets on a SINGLE track. `markForTrain` is no
 * longer one: it is the wire face of a three-state lifecycle column,
 * `retrainStatus: 'none' | 'staging' | 'trained'` (D81). What is pinned here is
 * the storage contract, because that is what every later behaviour reads:
 *
 *  - they live on the track row (`pipeline-analytics:tracks`), not in a
 *    per-device settings store — they are per-TRACK state, and the track row is
 *    the only place per-track mutable state lives (`setLabel` / `setImportance`
 *    are the precedent);
 *  - a patch is PARTIAL: setting one never clears the other;
 *  - a track flagged while still ACTIVE (in RAM, not yet persisted) must carry
 *    its status into `persistCompleted`, or the mark would silently evaporate at
 *    track expiry — the exact failure `setLabel`'s dual write exists to avoid;
 *  - `markForTrain: true` means `staging` and NOTHING else: `readFlags` and the
 *    feed rows report `retrainStatus === 'staging'`, so a `trained` track is not
 *    a marked one.
 *
 * The last describe block is the retention lifecycle itself, on the one query
 * that implements it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { TRACKS_COLLECTION, TrackStore } from '../track-store.js'

function seedTrack(fake: FakeSettingsStore, id: string, deviceId: number, lastSeen: number): void {
  fake.seed(TRACKS_COLLECTION, [
    { id, data: { deviceId, className: 'person', firstSeen: 0, lastSeen } },
  ])
}

/**
 * A row that already carries a retrain status — the only way to arrange a
 * `trained` track, since promoting one is the retrain page's job and no
 * server-side writer produces it yet.
 */
function seedTrackWithStatus(
  fake: FakeSettingsStore,
  id: string,
  deviceId: number,
  lastSeen: number,
  retrainStatus: string,
): void {
  fake.seed(TRACKS_COLLECTION, [
    { id, data: { deviceId, className: 'person', firstSeen: 0, lastSeen, retrainStatus } },
  ])
}

describe('TrackStore.setFlags — persisted track', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  it('persists markForTrain as retrainStatus:staging so a later read sees both', async () => {
    seedTrack(fake, 'track-1', 101, 1000)

    await trackStore.setFlags('track-1', { markForTrain: true })

    const track = await trackStore.getPersistedByTrackId('track-1')
    expect(track?.retrainStatus).toBe('staging')
    expect(track?.markForTrain).toBe(true)
  })

  it('persists debug independently of the retrain status', async () => {
    seedTrack(fake, 'track-1', 101, 1000)

    await trackStore.setFlags('track-1', { debug: true })

    const track = await trackStore.getPersistedByTrackId('track-1')
    expect(track?.debug).toBe(true)
    // Untouched retrain status reads as the column default — `'none'`, never
    // absent: the column is TEXT NOT NULL DEFAULT 'none' (D81 enum form).
    expect(track?.retrainStatus).toBe('none')
    expect(track?.markForTrain).toBe(false)
  })

  it('a partial patch leaves the other flag untouched', async () => {
    seedTrack(fake, 'track-1', 101, 1000)
    await trackStore.setFlags('track-1', { markForTrain: true, debug: true })

    await trackStore.setFlags('track-1', { debug: false })

    const track = await trackStore.getPersistedByTrackId('track-1')
    expect(track?.markForTrain).toBe(true)
    expect(track?.debug).toBe(false)
  })

  it('un-marking returns the track to none — the status is stored, not dropped', async () => {
    seedTrack(fake, 'track-1', 101, 1000)
    await trackStore.setFlags('track-1', { markForTrain: true })

    await trackStore.setFlags('track-1', { markForTrain: false })

    const track = await trackStore.getPersistedByTrackId('track-1')
    expect(track?.retrainStatus).toBe('none')
    expect(track?.markForTrain).toBe(false)
  })

  it('an empty patch is a no-op that does not throw', async () => {
    seedTrack(fake, 'track-1', 101, 1000)

    await expect(trackStore.setFlags('track-1', {})).resolves.toBeUndefined()

    const track = await trackStore.getPersistedByTrackId('track-1')
    expect(track?.retrainStatus).toBe('none')
    expect(track?.markForTrain).toBe(false)
    expect(track?.debug).toBeUndefined()
  })

  it('a row written before the column existed reads as none (the default), evictable', async () => {
    // The load-bearing half of D81's enum form: a legacy row has no stored
    // value, the TEXT NOT NULL DEFAULT 'none' materialises `'none'`, and
    // `'none'` is one of the two values the sweep's `whereIn` matches — history
    // stays evictable. `debug` keeps the nullable collapse (it never pins).
    seedTrack(fake, 'legacy', 101, 1000)

    const track = await trackStore.getPersistedByTrackId('legacy')

    expect(track).not.toBeNull()
    expect(track?.retrainStatus).toBe('none')
    expect(track?.markForTrain).toBe(false)
    expect(track?.debug).toBeUndefined()
  })

  it('a TRAINED track reports markForTrain false — trained is not marked', async () => {
    // The wire contract is `markForTrain === (retrainStatus === 'staging')`.
    // Reporting a trained track as marked would put it back in the export
    // selection and in the budget, and would offer the operator a toggle whose
    // only legal move is refused.
    seedTrackWithStatus(fake, 'done', 101, 1000, 'trained')

    const track = await trackStore.getPersistedByTrackId('done')

    expect(track?.retrainStatus).toBe('trained')
    expect(track?.markForTrain).toBe(false)
  })

  it('readFlags reports the lifecycle status, not just the boolean', async () => {
    seedTrackWithStatus(fake, 'done', 101, 1000, 'trained')

    const flags = await trackStore.readFlags('done')

    expect(flags).toEqual({
      retrainStatus: 'trained',
      debug: false,
      debugNote: '',
      favourited: false,
      // The track's own context, carried off the row this read already had in
      // its hand (D405). It is what the note ARCHIVE keeps so a sentence stays
      // identifiable after the track is evicted — and it is here rather than in
      // a second read precisely so archiving costs no extra round trip. The
      // seeded row has no label, so `label` is absent, never `''`.
      startedAt: 0,
      className: 'person',
    })
  })

  it('readFlags carries the DISPLAY label — the finest thing known, not the raw column', async () => {
    fake.seed(TRACKS_COLLECTION, [
      {
        id: 'labelled',
        data: {
          deviceId: 101,
          className: 'person',
          firstSeen: 500,
          lastSeen: 1000,
          label: 'person',
          subLabel: 'Alice',
        },
      },
    ])

    const flags = await trackStore.readFlags('labelled')

    expect(flags?.label).toBe('Alice')
    expect(flags?.startedAt).toBe(500)
  })

  /**
   * `debugNote` — the operator's sentence about what to check. Stored on the
   * track row beside the flag it explains, for exactly the reason the flags are
   * there: it is per-TRACK mutable state, and the row is where per-track
   * mutable state lives. A never-touched row must read back ABSENT, never as an
   * empty note the operator supposedly typed.
   */
  it('persists the debug note on the track row', async () => {
    seedTrack(fake, 'track-1', 101, 1000)

    await trackStore.setFlags('track-1', { debug: true, debugNote: 'the box jumps to the fence' })

    const track = await trackStore.getPersistedByTrackId('track-1')
    expect(track?.debugNote).toBe('the box jumps to the fence')
    expect((await trackStore.readFlags('track-1'))?.debugNote).toBe('the box jumps to the fence')
  })

  it('writes an EMPTY note rather than dropping it — that is how a note is cleared', async () => {
    seedTrack(fake, 'track-1', 101, 1000)
    await trackStore.setFlags('track-1', { debug: true, debugNote: 'stale question' })

    await trackStore.setFlags('track-1', { debug: false, debugNote: '' })

    const track = await trackStore.getPersistedByTrackId('track-1')
    expect(track?.debugNote).toBe('')
    expect(track?.debug).toBe(false)
  })

  it('absent note stays absent on a never-touched row, and reads back as empty', async () => {
    seedTrack(fake, 'legacy', 101, 1000)

    const track = await trackStore.getPersistedByTrackId('legacy')

    expect(track?.debugNote).toBeUndefined()
    expect((await trackStore.readFlags('legacy'))?.debugNote).toBe('')
  })

  it('a note-only patch leaves every flag untouched', async () => {
    seedTrack(fake, 'track-1', 101, 1000)
    await trackStore.setFlags('track-1', { markForTrain: true, debug: true, favourited: true })

    await trackStore.setFlags('track-1', { debugNote: 'second thoughts' })

    const track = await trackStore.getPersistedByTrackId('track-1')
    expect(track?.markForTrain).toBe(true)
    expect(track?.debug).toBe(true)
    expect(track?.favourited).toBe(true)
    expect(track?.debugNote).toBe('second thoughts')
  })

  it('persists favourited independently of debug and the retrain status', async () => {
    seedTrack(fake, 'track-1', 101, 1000)

    await trackStore.setFlags('track-1', { favourited: true })

    const track = await trackStore.getPersistedByTrackId('track-1')
    expect(track?.favourited).toBe(true)
    expect(track?.debug).toBeUndefined()
    expect(track?.retrainStatus).toBe('none')
    expect(track?.markForTrain).toBe(false)
  })

  it('a favourited partial patch leaves debug and markForTrain untouched', async () => {
    seedTrack(fake, 'track-1', 101, 1000)
    await trackStore.setFlags('track-1', { markForTrain: true, debug: true, favourited: true })

    await trackStore.setFlags('track-1', { favourited: false })

    const track = await trackStore.getPersistedByTrackId('track-1')
    expect(track?.markForTrain).toBe(true)
    expect(track?.debug).toBe(true)
    expect(track?.favourited).toBe(false)
  })

  it('absent favourited stays absent — never coerced to false on a never-touched row', async () => {
    seedTrack(fake, 'legacy', 101, 1000)

    const track = await trackStore.getPersistedByTrackId('legacy')

    expect(track?.favourited).toBeUndefined()
    expect((await trackStore.readFlags('legacy'))?.favourited).toBe(false)
  })
})

describe('TrackStore.setFlags — active track', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  function openTrack(trackId: string, deviceId: number, timestamp: number): void {
    trackStore.upsert({
      trackId,
      deviceId,
      className: 'person',
      timestamp,
      position: { x: 0.5, y: 0.5, timestamp, bbox: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } },
      zones: [],
      state: 'moving',
    })
  }

  it('reflects the flag on the live active track immediately', () => {
    openTrack('track-2', 102, 1000)

    void trackStore.setFlags('track-2', { markForTrain: true })

    expect(trackStore.getActiveByTrack('track-2')?.markForTrain).toBe(true)
    expect(trackStore.getActiveByTrack('track-2')?.retrainStatus).toBe('staging')
  })

  it('carries the status into the persisted row when the track expires', async () => {
    openTrack('track-2', 102, 1000)
    await trackStore.setFlags('track-2', { markForTrain: true, debug: true })

    await trackStore.expireStale(1000 + 60_000)

    const persisted = await trackStore.getPersistedByTrackId('track-2')
    expect(persisted?.retrainStatus).toBe('staging')
    expect(persisted?.markForTrain).toBe(true)
    expect(persisted?.debug).toBe(true)
  })

  it('carries the debug NOTE into the persisted row when the track expires', async () => {
    // `persistCompleted` REPLACES the row: a note typed while the track was
    // still live exists only in RAM until that write, so omitting it there
    // would leave the flag standing with its question gone — the same hazard
    // the status above is asserted against.
    openTrack('track-2', 102, 1000)
    await trackStore.setFlags('track-2', { debug: true, debugNote: 'check the crop at 22:14' })

    await trackStore.expireStale(1000 + 60_000)

    const persisted = await trackStore.getPersistedByTrackId('track-2')
    expect(persisted?.debug).toBe(true)
    expect(persisted?.debugNote).toBe('check the crop at 22:14')
  })
})

/**
 * The retrain LIFECYCLE against retention (D81, enum form). This block was a
 * characterization test asserting that a `markForTrain` track was still evicted
 * for as long as the flag was inert (D59); it became the pin's red-to-green
 * target, and it is now the lifecycle's, for the same reason it was written:
 * nobody may change the selection query without this file disagreeing.
 *
 * Every case below is about ONE query, `listIdsBefore`, because after D61 the
 * track row is the only CASCADING retention root — everything a track owns
 * (events, crops, keyframes, CLIP vector) leaves only through the cascade the
 * row triggers. Surviving that query is therefore the whole pin.
 *
 * **Only `staging` survives.** `none` never entered the lifecycle and `trained`
 * has left it: by the retrain page's contract the frames a trained track
 * contributed were COPIED into the retrain dataset at selection time, so the
 * dataset no longer depends on the track's media and holding it would cost disk
 * for nothing.
 */
describe('retention holds STAGING tracks only (D81)', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  it('listIdsBefore does NOT select a STAGING track, and still selects an unmarked one', async () => {
    seedTrack(fake, 'flagged', 101, 100)
    seedTrack(fake, 'plain', 101, 100)
    await trackStore.setFlags('flagged', { markForTrain: true })

    const ids = await trackStore.listIdsBefore(101, 300, 100)

    expect([...ids]).toEqual(['plain'])
  })

  it('a TRAINED track is EVICTABLE again — its frames were copied during staging', async () => {
    // The half that is new in the enum form, and the one a `retrainStatus !=
    // 'none'` shaped predicate would get wrong: `trained` is terminal for the
    // TOGGLE, not for retention. The dataset holds copies; the track's own
    // media has no further claim on the disk.
    seedTrackWithStatus(fake, 'done', 101, 100, 'trained')
    seedTrackWithStatus(fake, 'staged', 101, 100, 'staging')

    const ids = await trackStore.listIdsBefore(101, 300, 100)

    expect([...ids]).toEqual(['done'])
  })

  it('un-marking RELEASES the pin — the track is selected again', async () => {
    seedTrack(fake, 'flagged', 101, 100)
    await trackStore.setFlags('flagged', { markForTrain: true })

    await trackStore.setFlags('flagged', { markForTrain: false })

    const ids = await trackStore.listIdsBefore(101, 300, 100)
    expect([...ids]).toEqual(['flagged'])
  })

  it('`debug` alone does NOT pin — only staging claims durability', async () => {
    seedTrack(fake, 'noisy', 101, 100)

    await trackStore.setFlags('noisy', { debug: true })

    const ids = await trackStore.listIdsBefore(101, 300, 100)
    expect([...ids]).toEqual(['noisy'])
  })

  it('a row written BEFORE the lifecycle column existed is still selected', async () => {
    // The dangerous direction. The filter language has only positive equality
    // and `whereIn` — no negation, no IS NULL — so a NULL is not selectable by
    // any predicate, and a nullable column here would make every historical
    // track in the fleet immortal in one deploy. SQLite materialises the TEXT
    // NOT NULL DEFAULT 'none' for existing rows on `ALTER TABLE … ADD COLUMN`;
    // this asserts the behaviour that depends on it.
    seedTrack(fake, 'legacy', 101, 100)

    const ids = await trackStore.listIdsBefore(101, 300, 100)

    expect([...ids]).toEqual(['legacy'])
  })

  it('listIdsBefore does NOT select a FAVOURITED track, even a trained one', async () => {
    seedTrack(fake, 'kept', 101, 100)
    seedTrackWithStatus(fake, 'trained-kept', 101, 100, 'trained')
    seedTrack(fake, 'plain', 101, 100)
    await trackStore.setFlags('kept', { favourited: true })
    await trackStore.setFlags('trained-kept', { favourited: true })

    const ids = await trackStore.listIdsBefore(101, 300, 100)

    expect([...ids]).toEqual(['plain'])
  })

  it('un-favouriting RELEASES the pin — the track is selected again', async () => {
    seedTrack(fake, 'kept', 101, 100)
    await trackStore.setFlags('kept', { favourited: true })
    await trackStore.setFlags('kept', { favourited: false })

    const ids = await trackStore.listIdsBefore(101, 300, 100)
    expect([...ids]).toEqual(['kept'])
  })

  it('a track favourited while LIVE survives its own expiry-time persist', async () => {
    trackStore.upsert({
      trackId: 'live-fav',
      deviceId: 102,
      className: 'person',
      timestamp: 100,
      position: { x: 0.5, y: 0.5, timestamp: 100, bbox: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } },
      zones: [],
      state: 'moving',
    })
    await trackStore.setFlags('live-fav', { favourited: true })

    await trackStore.expireStale(100 + 60_000)

    expect((await trackStore.getPersistedByTrackId('live-fav'))?.favourited).toBe(true)
    const ids = await trackStore.listIdsBefore(102, 10_000_000, 100)
    expect([...ids]).toEqual([])
  })

  it('a track marked while LIVE survives its own expiry-time persist as staging', async () => {
    trackStore.upsert({
      trackId: 'live',
      deviceId: 102,
      className: 'person',
      timestamp: 100,
      position: { x: 0.5, y: 0.5, timestamp: 100, bbox: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } },
      zones: [],
      state: 'moving',
    })
    await trackStore.setFlags('live', { markForTrain: true })

    await trackStore.expireStale(100 + 60_000)

    expect((await trackStore.getPersistedByTrackId('live'))?.retrainStatus).toBe('staging')
    const ids = await trackStore.listIdsBefore(102, 10_000_000, 100)
    expect([...ids]).toEqual([])
  })
})

/**
 * The staging SELECTIONS — the export set and the budget count. Both are the
 * complement of the sweep's `whereIn`, and both must exclude `trained`: a
 * trained track is evictable, so exporting it would describe files the archive
 * is not guaranteed to contain, and counting it would charge an operator budget
 * for storage that is already free to go.
 */
describe('listStaging / countStaging select ONLY staging', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
    seedTrackWithStatus(fake, 'staged', 101, 100, 'staging')
    seedTrackWithStatus(fake, 'done', 101, 100, 'trained')
    seedTrack(fake, 'plain', 101, 100)
  })

  it('listStaging returns the staging track alone', async () => {
    const tracks = await trackStore.listStaging(101, 50)

    expect(tracks.map((t) => t.trackId)).toEqual(['staged'])
  })

  it('countStaging counts the staging track alone', async () => {
    expect(await trackStore.countStaging({ deviceId: 101 })).toBe(1)
  })
})

describe('countFavourited selects ONLY favourited', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
    seedTrack(fake, 'plain', 101, 100)
    seedTrack(fake, 'starred', 101, 100)
    await trackStore.setFlags('starred', { favourited: true })
    seedTrackWithStatus(fake, 'staged', 101, 100, 'staging')
  })

  it('counts the favourited track and ignores staging-only rows', async () => {
    expect(await trackStore.countFavourited({ deviceId: 101 })).toBe(1)
  })
})
