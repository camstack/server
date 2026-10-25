/**
 * The snooze half of the `notification-rules` cap, through the LIVE generated
 * router.
 *
 * What this pins that nothing else can:
 *
 *  - the three methods exist on the built router at all (a cap method that
 *    never reached codegen is invisible, not broken — it fails as "procedure
 *    missing", months later, from a client);
 *  - `caller: 'required'` actually INJECTS the server-derived identity. This is
 *    the whole security model of a snooze: `userId` decides whose silence it is,
 *    and a client that could supply it could silence someone else. The router
 *    is a structural pass-through — it does not re-validate output — so the
 *    injection is exactly the kind of thing only a router-level test sees.
 */

import type { NcSnooze, NcSnoozeInput } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildCapRouterForTest, invokeProcedure, makeCtx } from './harness.js'

interface CallerBox {
  readonly userId: string
  readonly isAdmin: boolean
}

interface Seen {
  listCaller?: CallerBox
  createCaller?: CallerBox
  createInput?: NcSnoozeInput
  cancelId?: string
}

function makeSnooze(overrides: Partial<NcSnooze> = {}): NcSnooze {
  return {
    id: 's1',
    userId: 'alice',
    scope: 'rule',
    ruleId: 'r1',
    startedAt: 1_000,
    expiresAt: 1_000 + 3_600_000,
    global: false,
    summary: true,
    ...overrides,
  }
}

function makeRouter(seen: Seen): ReturnType<typeof buildCapRouterForTest> {
  return buildCapRouterForTest('notification-rules', () => ({
    listSnoozes: async (input: { caller: CallerBox }) => {
      seen.listCaller = input.caller
      return { snoozes: [makeSnooze({ userId: input.caller.userId })] }
    },
    createSnooze: async (input: { snooze: NcSnoozeInput; caller: CallerBox }) => {
      seen.createCaller = input.caller
      seen.createInput = input.snooze
      return { snooze: makeSnooze({ userId: input.caller.userId }) }
    },
    cancelSnooze: async (input: { snoozeId: string }) => {
      seen.cancelId = input.snoozeId
      return { success: true }
    },
  }))
}

describe('notification-rules — snooze methods', () => {
  it('listSnoozes reaches the provider with the SERVER-derived caller', async () => {
    const seen: Seen = {}
    const res = await invokeProcedure(makeRouter(seen), 'listSnoozes', makeCtx('user'), {})
    expect(res.ok).toBe(true)
    // Not client input: whose silence this is comes from the session.
    expect(seen.listCaller?.userId).toBeTruthy()
    expect(seen.listCaller?.isAdmin).toBe(false)
  })

  it('an ADMIN caller is marked as one — that is what unlocks a household-wide window', async () => {
    const seen: Seen = {}
    await invokeProcedure(makeRouter(seen), 'listSnoozes', makeCtx('admin'), {})
    expect(seen.listCaller?.isAdmin).toBe(true)
  })

  it('createSnooze passes the authored window through and stamps the caller', async () => {
    const seen: Seen = {}
    const res = await invokeProcedure(makeRouter(seen), 'createSnooze', makeCtx('user'), {
      snooze: { scope: 'device', deviceId: 101, durationMinutes: 45 },
    })
    expect(res.ok).toBe(true)
    expect(seen.createInput).toMatchObject({ scope: 'device', deviceId: 101, durationMinutes: 45 })
    expect(seen.createCaller?.userId).toBeTruthy()
  })

  it('rejects a window longer than the 24h ceiling — a snooze that cannot expire is an outage', async () => {
    const seen: Seen = {}
    const res = await invokeProcedure(makeRouter(seen), 'createSnooze', makeCtx('user'), {
      snooze: { scope: 'all', durationMinutes: 1441 },
    })
    expect(res.ok).toBe(false)
    expect(seen.createInput).toBeUndefined()
  })

  it('cancelSnooze reaches the provider with the window id', async () => {
    const seen: Seen = {}
    const res = await invokeProcedure(makeRouter(seen), 'cancelSnooze', makeCtx('user'), {
      snoozeId: 's9',
    })
    expect(res.ok).toBe(true)
    expect(seen.cancelId).toBe('s9')
  })
})
