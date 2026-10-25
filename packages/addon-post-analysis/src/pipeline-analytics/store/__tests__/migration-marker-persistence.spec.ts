/**
 * Migration markers over the `migrations` record kind.
 *
 * A marker's presence is the fact that stops a pass re-scanning the whole
 * analytics store on every boot. The records facade enforces declare + schema
 * on write — the in-memory transport mirrors that.
 */
import { describe, expect, it } from 'vitest'
import { makeAnalyticsRecords } from '../../__tests__/fake-records.js'
import { MIGRATION_MARKER_KEY } from '../label-tier-migration.js'
import { MigrationMarkerStore } from '../migration-marker-store.js'

describe('migration markers persist on the records kind', () => {
  it('a set marker survives to the next read on a fresh store handle', async () => {
    const world = await makeAnalyticsRecords()
    const markers = MigrationMarkerStore.of(world.records)
    await markers.set(MIGRATION_MARKER_KEY, { completedAt: 123, rewritten: 0 })
    expect(await markers.has(MIGRATION_MARKER_KEY)).toBe(true)

    const reborn = MigrationMarkerStore.of(world.records)
    expect(await reborn.has(MIGRATION_MARKER_KEY)).toBe(true)
    const row = world.tables.get('migrations')?.get(MIGRATION_MARKER_KEY)
    expect(row?.data).toMatchObject({ completedAt: 123 })
  })
})
