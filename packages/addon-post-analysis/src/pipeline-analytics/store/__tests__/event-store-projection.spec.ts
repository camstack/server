/**
 * `projection: 'slim'` on the event collections is a SQL projection now.
 *
 * It used to be a JS-side drop: `queryMotion` / `queryObjects` read the WHOLE
 * row and then built a lightweight object out of part of it. The reader saved
 * nothing — it just did not look at bytes it had already paid to fetch, and on
 * these tables the discarded columns are the expensive ones (`regions`, `bbox`,
 * `zones`, `labelMeta`, `subLabelMeta` are all JSON).
 *
 * So, as with `track-store-projection.spec.ts`, these tests assert on what the
 * store ASKED the engine for, not on the object it handed back. Both the old
 * drop and the new SELECT produce an identical `MotionEvent` — which is exactly
 * why asserting on the result would have passed before the change and proved
 * nothing.
 *
 * Motion and audio are records kinds: the projection is asserted at the store's
 * ask of its ledger (the column list it hands `EventLedgerCollection.query`).
 *
 * AUDIO is deliberately absent from the projected set: `slimAudio` reads every
 * column the collection declares, so a projection there would narrow nothing
 * while adding a way to be wrong. The test pins that decision so a later reader
 * does not "fix" the inconsistency.
 */
import {
  type EventStoreLedgers,
  eventStoreLedgers,
  type FakeRecords,
  makeAnalyticsRecords,
} from '../../__tests__/fake-records.js'
import { mockQueryColumnProjections } from '../../../__tests__/support/vitest-mock.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  makeFakeSettingsStore,
  makeSilentLogger,
  seedTracklessEvents,
} from '../../__tests__/test-helpers.js'
import type { FakeSettingsStore } from '../../__tests__/test-helpers.js'
import { EventStore, MOTION_COLUMNS, MOTION_EVENTS_COLLECTION } from '../event-store.js'

const DEVICE_ID = 102

describe('EventStore — the slim projection reaches the SELECT', () => {
  let fake: FakeSettingsStore
  let world: FakeRecords
  let ledgers: EventStoreLedgers
  let eventStore: EventStore

  /** The column list of every ledger read the spy saw. */
  const ledgerColumns = (spy: { mock: { calls: readonly (readonly unknown[])[] } }) =>
    spy.mock.calls.map((call) => call[1])

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    world = await makeAnalyticsRecords()
    ledgers = eventStoreLedgers(world.records)
    eventStore = new EventStore({
      store: fake.client,
      logger: makeSilentLogger(),
      ...ledgers,
    })
    await EventStore.declareObjectCollection(fake.client)
  })

  it('motion slim does not read `regions` — the JSON column that dominates the row', async () => {
    const spy = vi.spyOn(ledgers.motionLedger, 'query')
    await eventStore.queryMotion({ deviceId: DEVICE_ID, projection: 'slim' })

    const asked = ledgerColumns(spy)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toBeDefined()
    expect(asked[0]).not.toContain('regions')
    // A projection, not an accident: everything `slimMotion` builds from is
    // still selected.
    expect(asked[0]).toEqual(expect.arrayContaining(['deviceId', 'timestamp', 'regionCount']))
  })

  it('object slim drops all four heavy JSON columns and keeps every field it renders', async () => {
    const spy = vi.spyOn(fake.client.query, 'query')
    await eventStore.queryObject({ deviceId: DEVICE_ID, projection: 'slim' })

    const asked = mockQueryColumnProjections(spy)
    expect(asked).toHaveLength(1)
    const columns = asked[0]
    expect(columns).toBeDefined()
    for (const heavy of ['bbox', 'zones', 'labelMeta', 'subLabelMeta']) {
      expect(columns).not.toContain(heavy)
    }
    // `label` / `subLabel` ride the slim projection (the timeline renders
    // `subLabel ?? label`); the SCORES and attributions do not — they are for
    // arguing about a value after the fact, never for rendering one.
    expect(columns).toEqual(
      expect.arrayContaining([
        'deviceId',
        'timestamp',
        'className',
        'frameId',
        'trackId',
        'importance',
        'label',
        'subLabel',
      ]),
    )
    expect(columns).not.toContain('labelScore')
    expect(columns).not.toContain('subLabelScore')
  })

  it('audio sends NO column list — slim reads every column it declares', async () => {
    const spy = vi.spyOn(ledgers.audioLedger, 'query')
    await eventStore.queryAudio({ deviceId: DEVICE_ID, projection: 'slim' })

    expect(ledgerColumns(spy)).toEqual([undefined])
  })

  it('the FULL projection sends no column list on any collection', async () => {
    const motionSpy = vi.spyOn(ledgers.motionLedger, 'query')
    const objectSpy = vi.spyOn(fake.client.query, 'query')
    await eventStore.queryMotion({ deviceId: DEVICE_ID, projection: 'full' })
    await eventStore.queryObject({ deviceId: DEVICE_ID })

    expect(ledgerColumns(motionSpy)).toEqual([undefined])
    expect(mockQueryColumnProjections(objectSpy)).toEqual([undefined])
  })

  it('a slim read still produces the same event the JS-side drop produced', async () => {
    // The projection must be invisible in the RESULT — that is the contract the
    // callers were written against. Asserted here so the two tests together say
    // "fewer bytes, same answer" rather than only the first half.
    const id = await eventStore.insertObject({
      kind: 'object',
      deviceId: DEVICE_ID,
      timestamp: 1_000,
      className: 'person',
      trackId: 't1',
      confidence: 0.9,
      bbox: { x: 1, y: 2, w: 3, h: 4 },
      zones: ['drive'],
    })

    const [slim] = await eventStore.queryObject({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(slim).toBeDefined()
    // Bound to the id the INSERT reported, not to a literal: the row's key is
    // whatever the database assigned (D474).
    expect(id).not.toBeNull()
    expect(slim?.id).toBe(id)
    expect(slim?.className).toBe('person')
    expect(slim?.trackId).toBe('t1')
    // Dropped by the projection, absent from the event — as before.
    expect(slim && 'bbox' in slim).toBe(false)
    expect(slim && 'zones' in slim).toBe(false)
  })
})

describe("EventStore — an onboard episode's first trigger persists (D672)", () => {
  let fake: FakeSettingsStore
  let world: FakeRecords
  let eventStore: EventStore

  beforeEach(async () => {
    // Enforcing: the real backend drops an undeclared key on write, so a
    // permissive fake would hand back a value production wrote into the void.
    fake = makeFakeSettingsStore({ enforceDeclaredColumns: true })
    world = await makeAnalyticsRecords()
    eventStore = new EventStore({
      store: fake.client,
      logger: makeSilentLogger(),
      ...eventStoreLedgers(world.records),
    })
    await EventStore.declareObjectCollection(fake.client)
  })

  it('declares `triggeredBy` as a JSON column', () => {
    expect(MOTION_COLUMNS.some((c) => c.name === 'triggeredBy' && c.type === 'JSON')).toBe(true)
  })

  it('a recorded trigger reads back in BOTH projections', async () => {
    await eventStore.insertMotion({
      kind: 'motion',
      deviceId: DEVICE_ID,
      timestamp: 1_000,
      regionCount: 0,
      durationMs: null,
      triggeredBy: { kind: 'sensor', deviceId: 3299 },
    })
    const [full] = await eventStore.queryMotion({ deviceId: DEVICE_ID })
    expect(full?.triggeredBy).toEqual({ kind: 'sensor', deviceId: 3299 })
    const [slim] = await eventStore.queryMotion({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(slim?.triggeredBy).toEqual({ kind: 'sensor', deviceId: 3299 })
  })

  it('a legacy row with no trigger reads back with NO `triggeredBy` key — not recorded, never a guessed camera (D393)', async () => {
    await eventStore.insertMotion({
      kind: 'motion',
      deviceId: DEVICE_ID,
      timestamp: 1_000,
      regionCount: 0,
      durationMs: null,
    })
    const [full] = await eventStore.queryMotion({ deviceId: DEVICE_ID })
    expect(full).toBeDefined()
    expect('triggeredBy' in full!).toBe(false)
    const [slim] = await eventStore.queryMotion({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(slim).toBeDefined()
    expect('triggeredBy' in slim!).toBe(false)
  })

  it('a stored value that does not parse is dropped, not guessed', async () => {
    seedTracklessEvents(world, MOTION_EVENTS_COLLECTION, [
      {
        id: '1',
        data: {
          deviceId: DEVICE_ID,
          timestamp: 1_000,
          regionCount: 0,
          triggeredBy: { kind: 'doorbell' },
        },
      },
    ])
    const [full] = await eventStore.queryMotion({ deviceId: DEVICE_ID })
    expect(full).toBeDefined()
    expect('triggeredBy' in full!).toBe(false)
    const [slim] = await eventStore.queryMotion({ deviceId: DEVICE_ID, projection: 'slim' })
    expect('triggeredBy' in slim!).toBe(false)
  })
})
