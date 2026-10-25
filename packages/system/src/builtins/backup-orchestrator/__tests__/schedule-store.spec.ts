/**
 * `BackupScheduleService` — the N:M "entry" store that binds one cron cadence
 * to a SET of destination locations with per-schedule retention.
 *
 * Driven by the real records engine on in-memory SQLite (D902: the
 * `schedules` kind is the only store), not a fake.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { type BackupSchedule, BackupScheduleService } from '../schedule-store.js'
import { makeBackupRecords } from './support/backup-records.js'

describe('BackupScheduleService', () => {
  let service: BackupScheduleService

  beforeEach(async () => {
    service = new BackupScheduleService((await makeBackupRecords()).stores.schedules)
  })

  it('upsert + get round-trips a schedule with multiple locations', async () => {
    const schedule: BackupSchedule = {
      id: 'sch-1',
      label: 'Nightly offsite',
      cron: '0 3 * * *',
      enabled: true,
      locationIds: ['backups:nas', 'backups:s3'],
      retentionCount: 14,
    }
    await service.upsert(schedule)
    const out = await service.get('sch-1')
    expect(out).toEqual(schedule)
  })

  it('persists and decodes optional dataSources array', async () => {
    await service.upsert({
      id: 'sch-2',
      label: 'DB only',
      cron: '0 * * * *',
      enabled: true,
      locationIds: ['backups:nas'],
      retentionCount: 7,
      dataSources: ['db', 'tls'],
    })
    const out = await service.get('sch-2')
    expect(out?.dataSources).toEqual(['db', 'tls'])
  })

  it('omits dataSources when not provided', async () => {
    await service.upsert({
      id: 'sch-3',
      label: 'Full',
      cron: '0 3 * * *',
      enabled: true,
      locationIds: ['backups:nas'],
      retentionCount: 7,
    })
    const out = await service.get('sch-3')
    expect(out?.dataSources).toBeUndefined()
  })

  it('upsert replaces an existing schedule by id (single row)', async () => {
    await service.upsert({
      id: 'sch-1',
      label: 'v1',
      cron: '0 3 * * *',
      enabled: true,
      locationIds: ['backups:nas'],
      retentionCount: 7,
    })
    await service.upsert({
      id: 'sch-1',
      label: 'v2',
      cron: '0 4 * * *',
      enabled: false,
      locationIds: ['backups:nas', 'backups:s3'],
      retentionCount: 30,
    })
    const out = await service.get('sch-1')
    expect(out?.label).toBe('v2')
    expect(out?.enabled).toBe(false)
    expect(out?.locationIds).toEqual(['backups:nas', 'backups:s3'])
    const all = await service.list()
    expect(all).toHaveLength(1)
  })

  it('delete removes a schedule by id', async () => {
    await service.upsert({
      id: 'sch-1',
      label: 'x',
      cron: '0 3 * * *',
      enabled: true,
      locationIds: ['backups:nas'],
      retentionCount: 7,
    })
    await service.delete('sch-1')
    expect(await service.get('sch-1')).toBeNull()
  })

  it('list returns deterministic ordering by id', async () => {
    for (const id of ['sch-z', 'sch-a', 'sch-m']) {
      await service.upsert({
        id,
        label: id,
        cron: '0 3 * * *',
        enabled: true,
        locationIds: ['backups:nas'],
        retentionCount: 7,
      })
    }
    const list = await service.list()
    expect(list.map((s) => s.id)).toEqual(['sch-a', 'sch-m', 'sch-z'])
  })

  it('keeps the attempt stamp and the SUCCESS stamp apart across a round-trip', async () => {
    // D384: `lastAttemptAt` is written before the archive runs and
    // `lastSuccessAt` only after one lands. A store that collapsed them is
    // how a schedule whose destination refused every byte reported a
    // healthy nightly backup.
    await service.upsert({
      id: 'sch-1',
      label: 'x',
      cron: '0 3 * * *',
      enabled: true,
      locationIds: ['backups:nas'],
      retentionCount: 7,
      lastAttemptAt: 1_700_000_000_000,
      lastError: 'missing config.share',
    })
    const out = await service.get('sch-1')
    expect(out?.lastAttemptAt).toBe(1_700_000_000_000)
    expect(out?.lastSuccessAt).toBeUndefined()
    expect(out?.lastError).toBe('missing config.share')
  })

  it('list returns an empty array when the kind is empty', async () => {
    expect(await service.list()).toEqual([])
  })
})
