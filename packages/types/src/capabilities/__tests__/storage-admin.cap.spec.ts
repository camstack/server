import { describe, expect, it } from 'vitest'
import { storageAdminCapability } from '../storage-admin.cap.js'

describe('storageAdminCapability (D900, D901, D905)', () => {
  it('serves the Data page: reads, and the stale-data audit - no adoption method, no table drop', () => {
    expect(Object.keys(storageAdminCapability.methods).toSorted()).toEqual([
      'dropOrphanedKind',
      'listKinds',
      'listTables',
      'readRecords',
      'scanStaleData',
      'staleDataReport',
      'unsetStaleSettingsKey',
    ])
  })

  it('every method is admin only, and the two deletions name their operator', () => {
    for (const method of Object.values(storageAdminCapability.methods)) {
      expect(method.auth).toBe('admin')
    }
    expect(storageAdminCapability.methods.dropOrphanedKind.caller).toBe('required')
    expect(storageAdminCapability.methods.unsetStaleSettingsKey.caller).toBe('required')
  })
})
