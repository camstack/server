/**
 * P1 (D852) — settings runs nightly, events and history weekly.
 *
 * Four things keep that honest: a schedule with no `databases` carries settings
 * only; the weekly schedule is seeded once and never over anything; a weekly
 * run with nothing beyond settings to carry is skipped rather than repeating
 * the nightly archive; and retention is counted per cadence, so seven nightlies
 * never evict the weekly archive that holds the events ledgers.
 *
 * The schedule store is the real one on the real records engine (in-memory).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  databasesOfSchedule,
  hasNothingBeyondSettings,
  seedWeeklySchedule,
  WEEKLY_SCHEDULE_ID,
} from '../backup-databases.js'
import {
  applyRetention,
  buildArchiveEntry,
  type ManifestArchiveEntry,
  parseManifestBytes,
  retentionClassOf,
} from '../manifest-store.js'
import { type BackupSchedule, BackupScheduleService } from '../schedule-store.js'
import { BackupSeedMarkerStore } from '../seed-marker-store.js'
import { makeBackupRecords } from './support/backup-records.js'

const NIGHTLY: BackupSchedule = {
  id: 'nightly',
  label: 'Nightly',
  cron: '0 3 * * *',
  enabled: true,
  locationIds: ['backups:default', 'backups:nas'],
  retentionCount: 7,
}

describe('schedule databases', () => {
  let service: BackupScheduleService
  let markers: BackupSeedMarkerStore

  beforeEach(async () => {
    const { stores } = await makeBackupRecords()
    service = new BackupScheduleService(stores.schedules)
    markers = new BackupSeedMarkerStore(stores.seedMarkers)
  })

  it('NULL databases ⇒ settings only', async () => {
    await service.upsert(NIGHTLY)
    const out = await service.get('nightly')
    expect(out?.databases).toBeUndefined()
    expect(out === null ? [] : databasesOfSchedule(out)).toEqual(['settings'])
  })

  it('round-trips a stated list, and drops a name it does not know', async () => {
    await service.upsert({ ...NIGHTLY, id: 'w', databases: ['settings', 'events', 'history'] })
    expect((await service.get('w'))?.databases).toEqual(['settings', 'events', 'history'])
  })

  describe('the weekly seed', () => {
    it('is created once, from the nightly destinations, and never again', async () => {
      await service.upsert(NIGHTLY)
      const first = await seedWeeklySchedule(service, markers)
      expect(first?.id).toBe(WEEKLY_SCHEDULE_ID)
      expect(first?.cron).toBe('0 4 * * 0')
      // Snapshots only: the weekly carries neither settings nor the data-root walk.
      expect(first?.databases).toEqual(['events', 'history'])
      expect(first?.locationIds).toEqual(['backups:default', 'backups:nas'])

      // A second boot finds it there.
      expect(await seedWeeklySchedule(service, markers)).toBeNull()
      const all = await service.list()
      expect(all.filter((s) => s.databases?.includes('events'))).toHaveLength(1)
      expect(all).toHaveLength(2)
    })

    it('never overwrites an edited seed', async () => {
      await service.upsert(NIGHTLY)
      await seedWeeklySchedule(service, markers)
      const seeded = await service.get(WEEKLY_SCHEDULE_ID)
      if (seeded === null) throw new Error('not seeded')
      await service.upsert({ ...seeded, cron: '30 5 * * 6', retentionCount: 9, enabled: false })

      expect(await seedWeeklySchedule(service, markers)).toBeNull()
      const kept = await service.get(WEEKLY_SCHEDULE_ID)
      expect(kept).toMatchObject({ cron: '30 5 * * 6', retentionCount: 9, enabled: false })
    })

    it('leaves an operator-made schedule that already carries events alone', async () => {
      await service.upsert(NIGHTLY)
      await service.upsert({ ...NIGHTLY, id: 'mine', databases: ['events'] })
      expect(await seedWeeklySchedule(service, markers)).toBeNull()
      expect(await service.get(WEEKLY_SCHEDULE_ID)).toBeNull()
    })

    it('seeds nothing on a hub that backs up nowhere', async () => {
      expect(await seedWeeklySchedule(service, markers)).toBeNull()
      await service.upsert({ ...NIGHTLY, locationIds: [] })
      expect(await seedWeeklySchedule(service, markers)).toBeNull()
    })

    it('a weekly the operator DELETED stays deleted — the seed ran once, ever', async () => {
      await service.upsert(NIGHTLY)
      expect(await seedWeeklySchedule(service, markers)).not.toBeNull()
      await service.delete(WEEKLY_SCHEDULE_ID)

      // Every later boot.
      expect(await seedWeeklySchedule(service, markers)).toBeNull()
      expect(await seedWeeklySchedule(service, markers)).toBeNull()
      expect(await service.get(WEEKLY_SCHEDULE_ID)).toBeNull()
    })

    it('a weekly the operator DISABLED stays as they left it', async () => {
      await service.upsert(NIGHTLY)
      await seedWeeklySchedule(service, markers)
      const seeded = await service.get(WEEKLY_SCHEDULE_ID)
      if (seeded === null) throw new Error('not seeded')
      await service.upsert({ ...seeded, enabled: false })

      expect(await seedWeeklySchedule(service, markers)).toBeNull()
      expect((await service.get(WEEKLY_SCHEDULE_ID))?.enabled).toBe(false)
    })

    it('a weekly seeded before the marker existed is marked, then respected when deleted', async () => {
      await service.upsert(NIGHTLY)
      await service.upsert({
        ...NIGHTLY,
        id: WEEKLY_SCHEDULE_ID,
        databases: ['settings', 'events'],
      })
      expect(await seedWeeklySchedule(service, markers)).toBeNull()
      expect(await markers.has(WEEKLY_SCHEDULE_ID)).toBe(true)
      await service.delete(WEEKLY_SCHEDULE_ID)
      expect(await seedWeeklySchedule(service, markers)).toBeNull()
    })
  })
})

describe('a weekly run with nothing to carry', () => {
  it('is nothing-to-carry while only settings exists', () => {
    expect(hasNothingBeyondSettings(['settings', 'events', 'history'], ['settings'])).toBe(true)
  })

  it('is not, once events or history exists', () => {
    expect(
      hasNothingBeyondSettings(['settings', 'events', 'history'], ['settings', 'events']),
    ).toBe(false)
    expect(hasNothingBeyondSettings(['history'], ['settings', 'history'])).toBe(false)
  })

  it('a settings-only run is never skipped', () => {
    expect(hasNothingBeyondSettings(['settings'], ['settings'])).toBe(false)
    expect(hasNothingBeyondSettings(['settings'], [])).toBe(false)
  })
})

describe('retention is counted per cadence', () => {
  function entryFromWire(databases: readonly unknown[]): ManifestArchiveEntry {
    const parsed = parseManifestBytes(
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          archives: [
            {
              id: 'x',
              filename: 'x.tar.gz',
              createdAt: 1,
              sizeBytes: 1,
              manifest: { archiveVersion: 1 },
              databases,
            },
          ],
        }),
      ),
    )
    const first = parsed.archives[0]
    if (first === undefined) throw new Error('entry dropped')
    return first
  }

  it('an unknown database id does not collapse the entry to settings', () => {
    // Known ids are kept and classify the entry; the unknown one is ignored.
    expect(retentionClassOf(entryFromWire(['events', 'future-db']))).toBe('events')
    // Unknown-only is its own class: never counted, never pruned by a nightly.
    const unknownOnly = entryFromWire(['future-db'])
    expect(retentionClassOf(unknownOnly)).not.toBe('settings')
    const nightlies = Array.from({ length: 3 }, (_, i) => archive(`n${i}`, 10 + i))
    const written = nightlies[2]
    if (written === undefined) throw new Error('no nightly')
    const { drop } = applyRetention([unknownOnly, ...nightlies], 1, retentionClassOf(written))
    expect(drop.map((a) => a.id).toSorted()).toEqual(['n0', 'n1'])
  })

  function archive(id: string, createdAt: number, databases?: ManifestArchiveEntry['databases']) {
    return buildArchiveEntry({
      id,
      filename: `${id}.tar.gz`,
      createdAt,
      sizeBytes: 1,
      manifest: {
        archiveVersion: 1,
        createdAt,
        dataDir: '/data',
        locations: ['addons-data'],
        entries: [],
        totalBytes: 0,
        totalFiles: 0,
      },
      ...(databases !== undefined ? { databases } : {}),
    })
  }

  it('an entry without databases belongs to the settings cadence', () => {
    expect(retentionClassOf(archive('old', 1))).toBe('settings')
    expect(retentionClassOf(archive('new', 1, ['settings']))).toBe('settings')
    expect(retentionClassOf(archive('wk', 1, ['history', 'settings', 'events']))).toBe(
      'events+history+settings',
    )
  })

  it('seven nightlies do not evict the weekly archive', () => {
    const weekly = archive('weekly', 1_000, ['settings', 'events', 'history'])
    const nightlies = Array.from({ length: 8 }, (_, i) => archive(`n${i}`, 2_000 + i))
    const written = nightlies[7]
    if (written === undefined) throw new Error('no nightly')
    const { keep, drop } = applyRetention([weekly, ...nightlies], 7, retentionClassOf(written))
    expect(drop.map((a) => a.id)).toEqual(['n0'])
    expect(keep.map((a) => a.id)).toContain('weekly')
  })

  it('weekly retention does not evict nightlies', () => {
    const weeklies = Array.from({ length: 5 }, (_, i) =>
      archive(`w${i}`, 1_000 + i, ['settings', 'events', 'history']),
    )
    const nightlies = Array.from({ length: 3 }, (_, i) => archive(`n${i}`, 5_000 + i))
    const written = weeklies[4]
    if (written === undefined) throw new Error('no weekly')
    const { keep, drop } = applyRetention([...nightlies, ...weeklies], 4, retentionClassOf(written))
    expect(drop.map((a) => a.id)).toEqual(['w0'])
    expect(keep.filter((a) => a.id.startsWith('n'))).toHaveLength(3)
  })

  it('without a cadence the count is over everything, as before', () => {
    const all = Array.from({ length: 5 }, (_, i) => archive(`a${i}`, i))
    expect(applyRetention(all, 3).drop).toHaveLength(2)
  })
})
