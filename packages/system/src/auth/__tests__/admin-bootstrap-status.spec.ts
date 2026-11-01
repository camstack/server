import type { SettingsStoreClient } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { AuthManager } from '../auth-manager.js'
import { staticJwtSigningKey } from '../jwt-signing-key.js'
import { UserManager } from '../user-manager.js'

/**
 * `adminBootstrapStatus` answers ONE typed boolean: does any admin account
 * still hash to the first-boot password? A real `UserManager` + `AuthManager`
 * (bcrypt) over an in-memory users table: the answer comes from the stored
 * hashes, not from a flag the seed could leave behind.
 */

interface Row {
  readonly id: string
  readonly data: Record<string, unknown>
}

function storeOver(rows: Map<string, Row>): SettingsStoreClient {
  const matches = (row: Row, where: Record<string, unknown> | undefined): boolean =>
    where === undefined || Object.entries(where).every(([k, v]) => row.data[k] === v)
  const client = {
    query: {
      query: async (input: { filter?: { where?: Record<string, unknown> } }) =>
        [...rows.values()].filter((r) => matches(r, input.filter?.where)),
    },
    insert: {
      mutate: async (input: { record: Row }) => {
        rows.set(input.record.id, input.record)
      },
    },
    update: {
      mutate: async (input: { id: string; data: Record<string, unknown> }) => {
        rows.set(input.id, { id: input.id, data: input.data })
      },
    },
    delete: {
      mutate: async (input: { key: string }) => {
        rows.delete(input.key)
      },
    },
  }
  // Type boundary: `SettingsStoreClient` is the generated tRPC client; the
  // user manager calls only the four procedures implemented above.
  return client as unknown as SettingsStoreClient
}

function users(): UserManager {
  const rows = new Map<string, Row>()
  const auth = new AuthManager({ get: () => undefined }, undefined, staticJwtSigningKey('secret'))
  return new UserManager({ getStore: () => storeOver(rows) }, auth)
}

describe('adminBootstrapStatus', () => {
  it('is true while the seeded admin still has the first-boot password', async () => {
    const um = users()
    await um.ensureAdminExists()
    expect(await um.adminBootstrapStatus()).toEqual({ defaultPasswordInUse: true })
  })

  it('is false once the password was replaced', async () => {
    const um = users()
    await um.ensureAdminExists()
    const admin = await um.findByUsername('admin')
    if (!admin) throw new Error('admin not seeded')
    await um.resetPassword(admin.id, 'operator-chosen')
    expect(await um.adminBootstrapStatus()).toEqual({ defaultPasswordInUse: false })
  })

  it('looks at admins only: a non-admin with the default password does not count', async () => {
    const um = users()
    await um.create({ username: 'boss', password: 'a-real-password', isAdmin: true })
    await um.create({ username: 'guest', password: 'changeme', isAdmin: false })
    expect(await um.adminBootstrapStatus()).toEqual({ defaultPasswordInUse: false })
  })

  it('is true when a non-seeded admin carries the default password', async () => {
    const um = users()
    await um.create({ username: 'ops', password: 'changeme', isAdmin: true })
    expect(await um.adminBootstrapStatus()).toEqual({ defaultPasswordInUse: true })
  })

  it('never carries a password or a hash', async () => {
    const um = users()
    await um.ensureAdminExists()
    const status = await um.adminBootstrapStatus()
    expect(Object.keys(status)).toEqual(['defaultPasswordInUse'])
  })
})
