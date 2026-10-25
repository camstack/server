/**
 * The OAuth sessions live only in the `oauth-sessions` records kind (D902):
 *
 *  - the daily sweep removes revoked rows past the horizon THROUGH THE REAL
 *    ENGINE. The kind once declared only a `user` index while the sweep asked
 *    `where: { revokedAt }`, which the engine refuses as an unindexed filter —
 *    so the sweep threw on every hub and took the login-session, audit and
 *    device-credential reaps after it down with it;
 *  - the auth schema no longer creates an `oauth_sessions` table.
 */
import { createRecordsAccess } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { SqliteSettingsBackend } from '../../sqlite-storage/sqlite-settings-backend.js'
import { declareAuthSchema } from '../auth-schema.js'
import { OauthSessionManager } from '../oauth-session-manager.js'
import { localAuthRecordKinds, localAuthRecordStoresOf } from '../record-kinds.js'

async function manager(): Promise<OauthSessionManager> {
  const world = makeRecordsWorld()
  await world.provider.init()
  const records = createRecordsAccess({
    owner: 'local-auth',
    transport: world.transportFor('local-auth'),
    secrets: null,
  })
  await records.declare(localAuthRecordKinds)
  return new OauthSessionManager({
    oauthSessionsKind: localAuthRecordStoresOf(records).oauthSessions,
  })
}

const LINK = { integrationId: 'alexa', scopes: [] }

describe('oauth sessions — records only', () => {
  it('reapRevoked deletes only rows revoked before the horizon, through the engine', async () => {
    const m = await manager()
    const active = await m.create({ userId: 'u1', username: 'a', ...LINK })
    const old = await m.create({ userId: 'u1', username: 'a', ...LINK })
    const oldToo = await m.create({ userId: 'u2', username: 'b', ...LINK })
    await m.markRevoked(old.id)
    await m.markRevoked(oldToo.id)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const horizon = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const recent = await m.create({ userId: 'u2', username: 'b', ...LINK })
    await m.markRevoked(recent.id)

    expect(await m.reapRevoked(horizon)).toBe(2)
    const left = (await m.list()).map((s) => s.id).sort()
    expect(left).toEqual([active.id, recent.id].sort())
  })

  it('the auth schema creates no oauth_sessions table', async () => {
    const backend = new SqliteSettingsBackend(':memory:')
    await backend.initialize()
    await declareAuthSchema({
      declareCollection: {
        mutate: (input) => backend.declareCollection(input),
      },
    })
    expect(backend.hasTable('oauth_sessions')).toBe(false)
    await backend.shutdown()
  })
})
