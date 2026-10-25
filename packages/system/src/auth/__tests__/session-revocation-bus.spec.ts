/**
 * Every revoke path of the login-session table announces the sessions it ended
 * (the hub closes their sockets and media on it). Disarm: take an
 * `announce(...)` call out of `login-session-manager.ts` and the matching
 * claim below goes red.
 */
import type { SettingsStoreClient } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { makeStore } from '../../builtins/local-auth/__tests__/memory-settings-store.js'
import { LoginSessionManager } from '../login-session-manager.js'
import { onSessionsRevoked, type SessionsRevokedEvent } from '../session-revocation-bus.js'

const MONTH = 30 * 86_400_000

function setup() {
  const store = makeStore() as unknown as SettingsStoreClient
  const sessions = new LoginSessionManager(store)
  const events: SessionsRevokedEvent[] = []
  const off = onSessionsRevoked((event) => events.push(event))
  const open = async (userId: string, credentialId?: string) =>
    (
      await sessions.create({
        userId,
        lifetimeMs: MONTH,
        refreshable: true,
        method: credentialId === undefined ? 'password' : 'device-certificate',
        ...(credentialId === undefined ? {} : { credentialId }),
      })
    ).session
  return { sessions, events, off, open }
}

let unsubscribe: (() => void) | null = null
afterEach(() => unsubscribe?.())

describe('login-session revocation announcements', () => {
  it('revoke names the one session that ended', async () => {
    const { sessions, events, off, open } = setup()
    unsubscribe = off
    const a = await open('u-1')
    await open('u-1')
    await sessions.revoke(a.id, 'logout')
    expect(events).toEqual([
      {
        sessionIds: [a.id],
        userId: 'u-1',
        allOfUser: false,
        exceptSessionId: null,
        reason: 'logout',
      },
    ])
  })

  it('revoking an already ended session announces nothing', async () => {
    const { sessions, events, off, open } = setup()
    unsubscribe = off
    const a = await open('u-1')
    await sessions.revoke(a.id, 'logout')
    events.length = 0
    await sessions.revoke(a.id, 'logout')
    expect(events).toEqual([])
  })

  it('revokeAllForUser names every session of THAT user and flags the user-wide revoke', async () => {
    const { sessions, events, off, open } = setup()
    unsubscribe = off
    const a = await open('u-1')
    const b = await open('u-1')
    const keep = await open('u-1')
    await open('u-2')
    await sessions.revokeAllForUser('u-1', {
      reason: 'logout-everywhere',
      exceptSessionId: keep.id,
    })
    expect(events).toHaveLength(1)
    const [event] = events
    expect([...(event?.sessionIds ?? [])].sort()).toEqual([a.id, b.id].sort())
    expect(event).toMatchObject({ userId: 'u-1', allOfUser: true, exceptSessionId: keep.id })
  })

  it('revokeByCredential names the credential sessions only', async () => {
    const { sessions, events, off, open } = setup()
    unsubscribe = off
    const cert = await open('u-1', 'cred-1')
    await open('u-1')
    await sessions.revokeByCredential('cred-1')
    expect(events).toHaveLength(1)
    expect(events[0]?.sessionIds).toEqual([cert.id])
    expect(events[0]?.reason).toBe('credential-revoked')
  })

  it('a throwing listener never breaks the revoke', async () => {
    const { sessions, off, open } = setup()
    const offThrowing = onSessionsRevoked(() => {
      throw new Error('boom')
    })
    unsubscribe = () => {
      off()
      offThrowing()
    }
    const a = await open('u-1')
    await expect(sessions.revoke(a.id, 'logout')).resolves.toBe(true)
    expect(sessions.check(a.id).state).toBe('revoked')
  })
})
