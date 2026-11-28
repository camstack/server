/**
 * Rooms and site zones become records with an id (D1089), on REAL SQLite: the records engine,
 * the `device-manager:devices` table and the `addon-settings` table share one file, the plan is
 * applied by the production transaction (`applyPlanFile`), and every assertion reads the file.
 */
import { roomIdFromKey, zoneIdFromKey } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { deviceManagerRecordKinds } from '../../record-kinds.js'
import { decodeDeviceRow } from '../../device-row-store.js'
import { RoomStore } from '../../room-store.js'
import { LEGACY_ROOM_KEYS, ROOMS_AS_RECORDS_ID } from '../rooms-as-records.js'
import { makeMigrationWorld, type MigrationWorld } from './device-manager-migration-world.js'

const KITCHEN = roomIdFromKey('kitchen')
const GARAGE = roomIdFromKey('garage')
const PORCH = roomIdFromKey('porch')
const UPSTAIRS = zoneIdFromKey('upstairs')

/** A hub as the label-based design left it: maps, a registry, three spellings of one porch. */
async function legacyHub(): Promise<MigrationWorld> {
  const w = await makeMigrationWorld([
    { deviceId: 1, location: 'kitchen' },
    { deviceId: 2, location: 'Kitchen' },
    { deviceId: 3, location: 'porch' },
    { deviceId: 4, location: 'porch' },
    { deviceId: 5, location: 'Porch' },
    { deviceId: 6, location: null },
    { deviceId: 7, location: '  ' },
  ])
  w.setStore('locations', ['Kitchen', 'Garage'])
  w.setStore('locationIcons', { kitchen: 'home', garage: 'not-an-icon', porch: 'home' })
  w.setStore('locationDescriptions', { kitchen: 'Where the stove is', garage: '   ' })
  w.setStore('siteZones', { upstairs: { label: 'Upstairs' } })
  w.setStore('locationZones', { kitchen: 'upstairs', garage: 'ghost-zone' })
  return w
}

const listRooms = async (w: MigrationWorld) => {
  const store = RoomStore.of(w.records)
  await store.load()
  return Object.fromEntries(store.rooms.list().map((room) => [room.id, room]))
}

describe('rooms-as-records on real SQLite', () => {
  it('writes one record per label and the ids on the devices, and keeps everything it does not know', async () => {
    const w = await legacyHub()
    expect(await w.run(ROOMS_AS_RECORDS_ID)).toMatchObject({ status: 'applied', error: null })

    const rooms = await listRooms(w)
    // The registry's spelling wins; the most used one is the fallback; a blank description and
    // an icon outside the vocabulary are dropped, never trusted.
    expect(rooms[KITCHEN]).toEqual({
      id: KITCHEN,
      name: 'Kitchen',
      icon: 'house',
      description: 'Where the stove is',
      zoneId: UPSTAIRS,
    })
    expect(rooms[GARAGE]).toEqual({ id: GARAGE, name: 'Garage' })
    expect(rooms[PORCH]).toEqual({ id: PORCH, name: 'porch', icon: 'house' })
    expect(Object.keys(rooms)).toHaveLength(3)
    const zone = await w.records.kind(deviceManagerRecordKinds.zones).get(UPSTAIRS)
    expect(zone?.data).toEqual({ name: 'Upstairs' })

    for (const id of [1, 2])
      expect(w.device(id)).toMatchObject({ locationId: KITCHEN, location: null })
    for (const id of [3, 4, 5])
      expect(w.device(id)).toMatchObject({ locationId: PORCH, location: null })
    expect(w.device(6)).toMatchObject({ locationId: null, location: null })
    // A blank label is no room and is cleared.
    expect(w.device(7)).toMatchObject({ locationId: null, location: null })
    // The field the migration does not know survives on every row.
    for (const id of [1, 2, 3, 4, 5, 6, 7]) expect(w.device(id)['mark']).toBe('marked-survives')

    expect(Object.keys(w.store()).filter((key) => LEGACY_ROOM_KEYS.includes(key))).toEqual([])
    // Another addon's row of the same key is not touched.
    const neighbour = w.db
      .prepare('SELECT id FROM "addon-settings" WHERE id LIKE ?')
      .all('other-addon.%')
    expect(neighbour).toHaveLength(LEGACY_ROOM_KEYS.length)
  })

  it('logs ONE line with counts and the raw values of every legacy entry it drops, before the keys go', async () => {
    const w = await legacyHub()
    w.setStore('locationDescriptions', {
      kitchen: 'Where the stove is',
      garage: '   ',
      porch: 'x'.repeat(2000),
    })
    w.setStore('siteZones', {
      upstairs: { label: 'Upstairs', icon: 'nope' },
      blank: { label: ' ' },
    })
    await w.run(ROOMS_AS_RECORDS_ID)

    expect(w.reports).toHaveLength(1)
    const line = w.reports[0]
    expect(line?.meta['counts']).toEqual({
      locationIcons: 1,
      locationDescriptions: 2,
      siteZones: 2,
      locationZones: 1,
    })
    expect(line?.meta['dropped']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ map: 'locationIcons', key: 'garage', value: 'not-an-icon' }),
        expect.objectContaining({ map: 'locationDescriptions', key: 'garage', value: '   ' }),
        expect.objectContaining({
          map: 'locationDescriptions',
          key: 'porch',
          reason: 'description truncated',
        }),
        expect.objectContaining({ map: 'locationZones', key: 'garage', value: 'ghost-zone' }),
      ]),
    )
  })

  it('a legacy map key that was never folded still reaches its room', async () => {
    const w = await legacyHub()
    w.setStore('locationIcons', { ' Kitchen ': 'home' })
    w.setStore('locationDescriptions', { GARAGE: 'Cars and tools' })
    await w.run(ROOMS_AS_RECORDS_ID)
    const rooms = await listRooms(w)
    expect(rooms[KITCHEN]).toMatchObject({ icon: 'house' })
    expect(rooms[GARAGE]).toMatchObject({ description: 'Cars and tools' })
  })

  it('a rerun plans nothing and changes nothing', async () => {
    const w = await legacyHub()
    await w.run(ROOMS_AS_RECORDS_ID)
    const dump = JSON.stringify(
      w.db.prepare('SELECT * FROM "device-manager:devices" ORDER BY id').all(),
    )
    expect((await w.planOf(ROOMS_AS_RECORDS_ID)).edits).toEqual([])
    expect(await w.run(ROOMS_AS_RECORDS_ID)).toMatchObject({ status: 'applied' })
    expect(
      JSON.stringify(w.db.prepare('SELECT * FROM "device-manager:devices" ORDER BY id').all()),
    ).toBe(dump)
  })

  it('a restored older snapshot converges: the edited room is kept, the devices get the same ids', async () => {
    const w = await legacyHub()
    await w.run(ROOMS_AS_RECORDS_ID)
    // The operator renames the room afterwards...
    const store = RoomStore.of(w.records)
    await store.load()
    await store.rooms.update(KITCHEN, (body) => ({ ...body, name: 'Cooking' }))
    // ...then an older file is restored over the device rows and the settings: labels are back.
    w.db
      .prepare(
        'UPDATE "device-manager:devices" SET location = ?, locationId = NULL WHERE deviceId IN (1, 2)',
      )
      .run('kitchen')
    w.setStore('locations', ['Kitchen', 'Garage'])
    w.setStore('locationIcons', { kitchen: 'home' })

    expect(await w.run(ROOMS_AS_RECORDS_ID)).toMatchObject({ status: 'applied', error: null })

    expect((await listRooms(w))[KITCHEN]?.name).toBe('Cooking')
    for (const id of [1, 2])
      expect(w.device(id)).toMatchObject({ locationId: KITCHEN, location: null })
    expect(Object.keys(w.store()).filter((key) => LEGACY_ROOM_KEYS.includes(key))).toEqual([])
  })

  it('rolls records, device rows and deleted keys back together when a later edit fails', async () => {
    const w = await legacyHub()
    const before = JSON.stringify(
      w.db.prepare('SELECT * FROM "device-manager:devices" ORDER BY id').all(),
    )
    const storeBefore = JSON.stringify(w.store())
    const out = await w.run(ROOMS_AS_RECORDS_ID, (plan) => ({
      edits: [...plan.edits, { op: 'deleteRow', table: 'no_such_table', key: { id: 1 } }],
    }))
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/no_such_table/)

    expect(await listRooms(w)).toEqual({})
    expect(
      JSON.stringify(w.db.prepare('SELECT * FROM "device-manager:devices" ORDER BY id').all()),
    ).toBe(before)
    expect(JSON.stringify(w.store())).toBe(storeBefore)
  })

  it('refuses the plan when a device row changed since it was read, and writes nothing', async () => {
    const w = await legacyHub()
    const plan = await w.planOf(ROOMS_AS_RECORDS_ID)
    w.db
      .prepare('UPDATE "device-manager:devices" SET location = ? WHERE deviceId = 3')
      .run('Terrace')
    const out = w.target.applyPlan({
      meta: (await import('../index.js')).ADDON_MIGRATIONS[0]!.meta,
      plan,
      bootId: 'late',
      codeVersion: '1.0.0',
    })
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/precondition/)
    expect(await listRooms(w)).toEqual({})
  })

  it('a write to another column of a device row between the read and the apply does not refuse it', async () => {
    const w = await legacyHub()
    const plan = await w.planOf(ROOMS_AS_RECORDS_ID)
    w.db
      .prepare('UPDATE "device-manager:devices" SET name = ? WHERE deviceId = 3')
      .run('renamed meanwhile')
    const out = await w.run(ROOMS_AS_RECORDS_ID, () => plan)
    expect(out.status).toBe('applied')
    expect(w.device(3)).toMatchObject({ name: 'renamed meanwhile', locationId: PORCH })
  })

  it('an unknown room id reads as unset, never as the raw id', async () => {
    const w = await legacyHub()
    await w.run(ROOMS_AS_RECORDS_ID)
    const store = RoomStore.of(w.records)
    await store.load()
    const names = { room: (id: string | null | undefined) => store.nameOf(id), tag: () => null }
    const row = (locationId: string) =>
      decodeDeviceRow({ ...w.device(1), deviceId: 1, type: 'camera', locationId }, names)
    expect(row(KITCHEN)?.meta.location).toBe('Kitchen')
    expect(row('room_deleted_long_ago')?.meta.location).toBeNull()
  })

  it('a rename writes exactly one record and no device row', async () => {
    const w = await legacyHub()
    await w.run(ROOMS_AS_RECORDS_ID)
    const revs = (): string =>
      JSON.stringify(
        w.db.prepare('SELECT kind_id, id, rev FROM records ORDER BY kind_id, id').all(),
      )
    const devices = (): string =>
      JSON.stringify(w.db.prepare('SELECT * FROM "device-manager:devices" ORDER BY id').all())
    const store = RoomStore.of(w.records)
    await store.load()
    const recordsBefore = JSON.parse(revs()) as { kind_id: number; id: string; rev: number }[]
    const devicesBefore = devices()
    await store.rooms.update(KITCHEN, (body) => ({ ...body, name: 'Cooking' }))
    const recordsAfter = JSON.parse(revs()) as { kind_id: number; id: string; rev: number }[]
    const changed = recordsAfter.filter(
      (row, i) => recordsBefore[i]?.rev !== row.rev || recordsBefore[i]?.id !== row.id,
    )
    expect(changed.map((row) => row.id)).toEqual([KITCHEN])
    expect(devices()).toBe(devicesBefore)
  })
})
