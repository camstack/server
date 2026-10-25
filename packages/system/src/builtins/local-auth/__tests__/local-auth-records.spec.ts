/**
 * Phase 6: local-auth stores read/write through ctx.records, not legacy tables.
 */
import { createRecordsAccess } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { UserManager } from '../../../auth/user-manager.js'
import { AuthManager } from '../../../auth/auth-manager.js'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { localAuthRecordKinds } from '../record-kinds.js'
import { makeStore } from './memory-settings-store.js'
import type { SettingsStoreClient } from '@camstack/types'

function authManager(): AuthManager {
  return new AuthManager({
    get: () => undefined,
    update: () => {},
  })
}

describe('local-auth — records path (phase 6)', () => {
  it('UserManager does not declare legacy users when a users kind is bound', async () => {
    const declared: string[] = []
    const legacy = makeStore() as unknown as SettingsStoreClient
    const origDeclare = legacy.declareCollection.mutate.bind(legacy.declareCollection)
    legacy.declareCollection.mutate = async (input) => {
      declared.push(input.collection)
      return origDeclare(input)
    }
    const world = makeRecordsWorld()
    await world.provider.init()
    const records = createRecordsAccess({
      owner: 'local-auth',
      transport: world.transportFor('local-auth'),
      secrets: null,
    })
    await records.declare(localAuthRecordKinds)
    const usersKind = records.kind(localAuthRecordKinds.users)
    const users = new UserManager({ usersKind, legacyStore: legacy }, authManager())
    await users.create({
      username: 'alice',
      password: 'secret-long-enough',
      isAdmin: false,
    })
    expect(declared.filter((c) => c === 'users')).toEqual([])
    const found = await users.findByUsername('alice')
    expect(found?.username).toBe('alice')
  })
})
