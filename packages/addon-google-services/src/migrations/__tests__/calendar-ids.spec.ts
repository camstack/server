/**
 * The shared calendar set becomes each broker's own, then the shared setting is dropped after a
 * read-back. Real SQLite for the addon settings (canonical `addon-settings` layout), the real
 * `brokers` record kind (in-memory records engine) for the broker rows, through the production
 * port binding.
 */
import { makeInMemoryRecords, type RecordKindHandle } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { googleBrokersEntryKind, type GoogleBrokerBody } from '../../broker-record-kinds.js'
import { settingsFixture } from '../../__tests__/settings-fixture.js'
import { ADDON_MIGRATIONS } from '../index.js'
import { calendarIdsPortsOver } from '../ports.js'

const COPY = 'google-services/2026-11-03-calendar-ids-to-brokers'
const DROP = 'google-services/2026-11-03-drop-shared-calendar-ids'
const SHARED = ['google_001:work@g', 'google_002:home@g']
const body = (name: string, extra: Partial<GoogleBrokerBody> = {}): GoogleBrokerBody => ({
  name,
  clientId: `${name}-client`,
  clientSecret: `${name}-secret`,
  calendarFilter: '',
  fromAddress: '',
  fromName: '',
  ...extra,
})

async function start(
  stored: Record<string, unknown> = { calendarIds: SHARED, other: { mark: 'survive' } },
  brokers: Record<string, GoogleBrokerBody> = {
    google_001: body('A'),
    google_002: body('B'),
  },
) {
  const world = makeInMemoryRecords('google-services')
  await world.records.declare({ brokers: googleBrokersEntryKind })
  const kind: RecordKindHandle<GoogleBrokerBody> = world.records.kind(googleBrokersEntryKind)
  for (const [id, data] of Object.entries(brokers)) await kind.put({ id, data })
  const f = settingsFixture(
    'google-services',
    ADDON_MIGRATIONS,
    (readStored) => calendarIdsPortsOver(kind, readStored),
    stored,
    'keep-me',
  )
  const idsOf = async (id: string): Promise<readonly string[] | undefined> =>
    (await kind.get(id))?.data.calendarIds
  return { f, kind, idsOf }
}

describe('google-services calendar ids: shared set to each broker', () => {
  it('copies the shared set to every broker record, then drops the shared row after the read-back', async () => {
    const { f, idsOf } = await start()
    expect(await f.boot()).toEqual({ failed: [], applied: [COPY, DROP] })
    expect(await idsOf('google_001')).toEqual(SHARED)
    expect(await idsOf('google_002')).toEqual(SHARED)
    expect(f.rows()['google-services.calendarIds']).toBeUndefined()
  })

  it('a marked field survives: unknown settings, another addon, and the record secrets', async () => {
    const { f, kind } = await start()
    await f.boot()
    expect(f.rows()['google-services.other']?.['value']).toEqual({ mark: 'survive' })
    expect(f.rows()['other-addon.calendarIds']?.['value']).toBe('keep-me')
    const a = await kind.getResolved('google_001')
    expect(a?.data.clientSecret).toBe('A-secret')
    expect(a?.data.clientId).toBe('A-client')
  })

  it('two instances: a set on A is invisible on B, and the copy never overwrites it', async () => {
    const { f, idsOf } = await start(
      { calendarIds: SHARED },
      {
        google_001: body('A', { calendarIds: ['google_001:marker-A'] }),
        google_002: body('B'),
      },
    )
    await f.boot()
    expect(await idsOf('google_001')).toEqual(['google_001:marker-A'])
    expect(await idsOf('google_002')).toEqual(SHARED)
  })

  it('a broker holding a different set parks the shared row: it is kept, never deleted', async () => {
    const { f } = await start(
      { calendarIds: SHARED },
      {
        google_001: body('A', { calendarIds: ['google_001:marker-A'] }),
        google_002: body('B'),
      },
    )
    expect(await f.boot()).toEqual({ failed: [], applied: [COPY, DROP] })
    expect(f.rows()['google-services.calendarIds']?.['value']).toEqual(SHARED)
  })

  it('a deleted broker is skipped, never recreated', async () => {
    const { f, kind } = await start()
    const ports = calendarIdsPortsOver(kind, f.readStored)
    expect(await ports.setBrokerCalendarIds('google_gone', SHARED)).toBe(false)
    expect(await kind.get('google_gone')).toBeNull()
  })

  it('a stored set that is not a list of ids throws: nothing is copied and nothing is dropped', async () => {
    const { f, idsOf } = await start({ calendarIds: 'google_001:work@g' })
    const result = await f.boot()
    expect(result.failed).toEqual([COPY, DROP])
    expect(await idsOf('google_001')).toBeUndefined()
    expect(f.rows()['google-services.calendarIds']?.['value']).toBe('google_001:work@g')
  })

  it('the drop refuses while a broker has no set of its own, and keeps the shared row', async () => {
    const { f, kind } = await start()
    const results = await f.boot()
    expect(results.applied).toContain(COPY)
    // A broker created between the copy and the drop's read: put it back without a set.
    await kind.put({ id: 'google_003', data: body('C') })
    const { planDropSharedCalendarIds } = await import('../calendar-ids-to-brokers.js')
    await expect(
      planDropSharedCalendarIds(
        calendarIdsPortsOver(kind, async () => ({ kind: 'present', value: SHARED })),
      ),
    ).rejects.toThrow(/google_003/)
  })

  it('a second run is a no-op', async () => {
    const { f, idsOf } = await start()
    await f.boot()
    const after = f.rows()
    const second = await f.boot()
    expect(second.failed).toEqual([])
    expect(f.rows()).toEqual(after)
    expect(await idsOf('google_001')).toEqual(SHARED)
  })

  it('an empty shared set is copied as empty (import none), not left unset', async () => {
    const { f, idsOf } = await start({ calendarIds: [] })
    await f.boot()
    expect(await idsOf('google_001')).toEqual([])
  })
})
