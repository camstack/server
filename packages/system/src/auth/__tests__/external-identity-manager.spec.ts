import type { SettingsStoreClient } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ExternalIdentityConflictError,
  ExternalIdentityManager,
} from '../external-identity-manager.js'

/**
 * D782 — an external sign-in identity `(provider, subject)` is linked
 * explicitly to ONE user; a user may hold several; deleting the user deletes
 * its links. In-memory fake of the `user_external_identities` collection.
 */

interface Row {
  id: string
  data: Record<string, unknown>
}

function makeFakeStore(): { store: SettingsStoreClient; rows: Map<string, Row> } {
  const rows = new Map<string, Row>()
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => row.data[k] === v)
  const store = {
    insert: {
      mutate: async (args: { collection: string; record: Row }) => {
        if (rows.has(args.record.id)) throw new Error('UNIQUE constraint failed')
        rows.set(args.record.id, { id: args.record.id, data: { ...args.record.data } })
      },
    },
    delete: {
      mutate: async (args: { collection: string; key: string }) => {
        rows.delete(args.key)
      },
    },
    query: {
      query: async (args: { collection: string; filter: { where?: Record<string, unknown> } }) =>
        Array.from(rows.values()).filter((row) => matches(row, args.filter.where ?? {})),
    },
  } as unknown as SettingsStoreClient
  return { store, rows }
}

const AUTHENTIK = 'auth-oidc/authentik'
const ISS = 'https://idp.example/'
const GOOGLE = 'auth-oidc/google'

describe('ExternalIdentityManager', () => {
  let mgr: ExternalIdentityManager

  beforeEach(() => {
    mgr = new ExternalIdentityManager(makeFakeStore().store)
  })

  it('stores and returns the issuer the identity was linked under', async () => {
    await mgr.link({ userId: 'u-alice', provider: AUTHENTIK, subject: 'sub-1', issuer: ISS })
    expect(await mgr.findLink(AUTHENTIK, 'sub-1')).toMatchObject({ userId: 'u-alice', issuer: ISS })
  })

  it('links an identity and finds its user', async () => {
    await mgr.link({
      userId: 'u-alice',
      provider: AUTHENTIK,
      subject: 'sub-1',
      issuer: ISS,
      label: 'alice',
    })
    expect(await mgr.findUser(AUTHENTIK, 'sub-1')).toBe('u-alice')
    expect(await mgr.findUser(AUTHENTIK, 'sub-2')).toBeNull()
    expect(await mgr.findUser(GOOGLE, 'sub-1')).toBeNull()
  })

  it('one (provider, subject) maps to ONE user — a second user is refused', async () => {
    await mgr.link({ userId: 'u-alice', provider: AUTHENTIK, subject: 'sub-1', issuer: ISS })
    await expect(
      mgr.link({ userId: 'u-bob', provider: AUTHENTIK, subject: 'sub-1', issuer: ISS }),
    ).rejects.toBeInstanceOf(ExternalIdentityConflictError)
    expect(await mgr.findUser(AUTHENTIK, 'sub-1')).toBe('u-alice')
  })

  it('re-linking the same identity to the same user is idempotent', async () => {
    await mgr.link({ userId: 'u-alice', provider: AUTHENTIK, subject: 'sub-1', issuer: ISS })
    await mgr.link({ userId: 'u-alice', provider: AUTHENTIK, subject: 'sub-1', issuer: ISS })
    expect(await mgr.listForUser('u-alice')).toHaveLength(1)
  })

  it('one user may link several providers', async () => {
    await mgr.link({ userId: 'u-alice', provider: AUTHENTIK, subject: 'sub-1', issuer: ISS })
    await mgr.link({ userId: 'u-alice', provider: GOOGLE, subject: 'g-9', issuer: ISS })
    const links = await mgr.listForUser('u-alice')
    expect(links.map((l) => l.provider).toSorted()).toEqual([AUTHENTIK, GOOGLE])
    expect(links.every((l) => l.userId === 'u-alice' && typeof l.linkedAt === 'number')).toBe(true)
  })

  it('unlink removes only that user’s link', async () => {
    await mgr.link({ userId: 'u-alice', provider: AUTHENTIK, subject: 'sub-1', issuer: ISS })
    expect(await mgr.unlink({ userId: 'u-bob', provider: AUTHENTIK, subject: 'sub-1' })).toBe(false)
    expect(await mgr.findUser(AUTHENTIK, 'sub-1')).toBe('u-alice')
    expect(await mgr.unlink({ userId: 'u-alice', provider: AUTHENTIK, subject: 'sub-1' })).toBe(
      true,
    )
    expect(await mgr.findUser(AUTHENTIK, 'sub-1')).toBeNull()
  })

  it('removeAllForUser deletes every link of a deleted user', async () => {
    await mgr.link({ userId: 'u-alice', provider: AUTHENTIK, subject: 'sub-1', issuer: ISS })
    await mgr.link({ userId: 'u-alice', provider: GOOGLE, subject: 'g-9', issuer: ISS })
    await mgr.link({ userId: 'u-bob', provider: AUTHENTIK, subject: 'sub-2', issuer: ISS })
    expect(await mgr.removeAllForUser('u-alice')).toBe(2)
    expect(await mgr.listForUser('u-alice')).toEqual([])
    expect(await mgr.findUser(AUTHENTIK, 'sub-2')).toBe('u-bob')
  })

  it('a subject containing separators cannot collide with another identity', async () => {
    await mgr.link({ userId: 'u-alice', provider: 'auth-oidc/a', subject: 'b|c', issuer: ISS })
    expect(await mgr.findUser('auth-oidc/a|b', 'c')).toBeNull()
  })
})
