import { describe, expect, it } from 'vitest'
import { storageAdminCapability } from '../storage-admin.cap.js'

describe('storageAdminCapability is read-only (D900, D901)', () => {
  it('serves the Data page only: no adoption method and no drop', () => {
    expect(Object.keys(storageAdminCapability.methods).toSorted()).toEqual([
      'listKinds',
      'listTables',
      'readRecords',
    ])
  })
})
