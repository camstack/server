/**
 * `BackupDestinationPolicyService` — per-`backups`-location policy (enabled,
 * retention, label) plus the attempt ledger (`lastAttemptAt` / `lastError`),
 * keyed by `locationId`.
 *
 * Driven by the real records engine on in-memory SQLite rather than a fake
 * (D902: the `destination-policies` kind is the only store): absent-vs-set
 * optional fields are what the engine gives back, not a Map's semantics.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type BackupDestinationPolicy,
  BackupDestinationPolicyService,
} from '../destination-policy.js'
import { makeBackupRecords } from './support/backup-records.js'

describe('BackupDestinationPolicyService', () => {
  let service: BackupDestinationPolicyService

  beforeEach(async () => {
    service = new BackupDestinationPolicyService(
      (await makeBackupRecords()).stores.destinationPolicies,
    )
  })

  it('upsert + get round-trips a policy', async () => {
    const policy: BackupDestinationPolicy = {
      locationId: 'backups:nas',
      enabled: true,
      retentionCount: 5,
      label: 'Office NAS',
    }
    await service.upsert(policy)

    const out = await service.get('backups:nas')
    expect(out).toEqual(policy)
  })

  it('round-trips the attempt ledger', async () => {
    await service.upsert({
      locationId: 'backups:nas',
      enabled: true,
      retentionCount: 7,
      lastAttemptAt: 1_700_000_000_000,
      lastError: 'smb-storage: missing config.share',
    })
    const out = await service.get('backups:nas')
    expect(out?.lastAttemptAt).toBe(1_700_000_000_000)
    expect(out?.lastError).toBe('smb-storage: missing config.share')
  })

  it('recordAttempt stamps a failure, and the next success CLEARS it', async () => {
    await service.upsert({
      locationId: 'backups:smb',
      enabled: true,
      retentionCount: 7,
      label: 'Unraid',
    })
    await service.recordAttempt(
      'backups:smb',
      { attemptAt: 1_788_742_826_188, error: 'missing config.share' },
      { retentionCount: 7 },
    )
    const failed = await service.get('backups:smb')
    expect(failed?.lastAttemptAt).toBe(1_788_742_826_188)
    expect(failed?.lastError).toBe('missing config.share')
    // The operator's own settings survive an outcome stamp.
    expect(failed?.label).toBe('Unraid')
    expect(failed?.retentionCount).toBe(7)

    await service.recordAttempt(
      'backups:smb',
      { attemptAt: 1_788_800_000_000 },
      {
        retentionCount: 7,
      },
    )
    const healed = await service.get('backups:smb')
    expect(healed?.lastAttemptAt).toBe(1_788_800_000_000)
    expect(healed?.lastError).toBeUndefined()
  })

  it('recordAttempt on a never-seen destination still records the failure', async () => {
    await service.recordAttempt(
      'backups:brand-new',
      { attemptAt: 1_788_742_826_188, error: 'host unreachable' },
      { retentionCount: 7 },
    )
    const out = await service.get('backups:brand-new')
    expect(out?.lastError).toBe('host unreachable')
    expect(out?.enabled).toBe(true)
  })

  it('omits label / lastAttemptAt / lastError when they were never set', async () => {
    await service.upsert({ locationId: 'backups:nas', enabled: true, retentionCount: 7 })
    const out = await service.get('backups:nas')
    expect(out).toEqual({ locationId: 'backups:nas', enabled: true, retentionCount: 7 })
  })

  it('upsert replaces an existing policy by locationId', async () => {
    await service.upsert({
      locationId: 'backups:nas',
      enabled: true,
      retentionCount: 5,
    })
    await service.upsert({
      locationId: 'backups:nas',
      enabled: false,
      retentionCount: 30,
      label: 'Office NAS',
    })

    const out = await service.get('backups:nas')
    expect(out).toEqual({
      locationId: 'backups:nas',
      enabled: false,
      retentionCount: 30,
      label: 'Office NAS',
    })
    // Only one row in the collection.
    const all = await service.list()
    expect(all).toHaveLength(1)
  })

  it('delete removes a policy by locationId', async () => {
    await service.upsert({
      locationId: 'backups:nas',
      enabled: true,
      retentionCount: 7,
    })
    await service.delete('backups:nas')
    const out = await service.get('backups:nas')
    expect(out).toBeNull()
  })

  it('list returns deterministic ordering by locationId', async () => {
    // Insert in non-alphabetical order to confirm sorting.
    await service.upsert({ locationId: 'backups:zeta', enabled: true, retentionCount: 1 })
    await service.upsert({ locationId: 'backups:alpha', enabled: true, retentionCount: 1 })
    await service.upsert({ locationId: 'backups:mike', enabled: true, retentionCount: 1 })

    const list = await service.list()
    expect(list.map((p) => p.locationId)).toEqual(['backups:alpha', 'backups:mike', 'backups:zeta'])
  })

  it('ensureDefault creates a fresh policy with the requested retention', async () => {
    const policy = await service.ensureDefault('backups:nas', { retentionCount: 7 })
    expect(policy).toEqual({
      locationId: 'backups:nas',
      enabled: true,
      retentionCount: 7,
    })
    const stored = await service.get('backups:nas')
    expect(stored).toEqual(policy)
  })

  it('ensureDefault is idempotent — preserves existing policy values', async () => {
    await service.upsert({
      locationId: 'backups:nas',
      enabled: false,
      retentionCount: 30,
      label: 'Custom',
    })
    const policy = await service.ensureDefault('backups:nas', { retentionCount: 7 })
    expect(policy).toEqual({
      locationId: 'backups:nas',
      enabled: false,
      retentionCount: 30,
      label: 'Custom',
    })
    // No second row inserted.
    const all = await service.list()
    expect(all).toHaveLength(1)
  })

  it('list returns an empty array when the collection is empty', async () => {
    const list = await service.list()
    expect(list).toEqual([])
  })

  it('decodes the enabled column from 0/1', async () => {
    await service.upsert({ locationId: 'backups:a', enabled: false, retentionCount: 3 })
    await service.upsert({ locationId: 'backups:b', enabled: true, retentionCount: 7 })
    const a = await service.get('backups:a')
    const b = await service.get('backups:b')
    expect(a?.enabled).toBe(false)
    expect(b?.enabled).toBe(true)
  })
})
