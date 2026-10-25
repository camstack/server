/**
 * S1 on the proactive side: events and the user's own Alexa device list follow
 * the linking user's grant, with D49's asymmetry — a gain applies at once, a
 * loss that would DELETE endpoints (and the user's routines) needs two reads.
 */
import type { DeviceMetaLike, IScopedLogger, TokenScope } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { AlexaAccessGate, type AlexaUserGrant } from '../access/access-gate.js'
import {
  AccountVisibilityMirror,
  type StoredVisibilityMap,
  visibilityAllows,
} from '../access/account-visibility.js'

const logger: IScopedLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  withTags: () => logger,
  child: () => logger,
}

const ids = (list: number[]): TokenScope => ({
  type: 'device',
  selector: { kind: 'ids', ids: list },
  access: ['view'],
})

function harness(initial: StoredVisibilityMap = {}) {
  let users: AlexaUserGrant[] = []
  let metaFails = false
  let t = 0
  const meta = (id: number): DeviceMetaLike => ({
    id,
    type: 'camera',
    location: null,
    parentDeviceId: null,
  })
  const gate = new AlexaAccessGate({
    listUserGrants: async () => users,
    getDeviceMeta: async (id) => {
      if (metaFails) throw new Error('registry down')
      return meta(id)
    },
    logger,
    now: () => t,
  })
  let stored: StoredVisibilityMap = initial
  const mirror = new AccountVisibilityMirror({
    gate,
    listLinkedUserIds: () => ['u'],
    listExposedDeviceIds: () => [1, 2, 3],
    getStored: () => stored,
    setStored: async (next) => {
      stored = next
    },
    logger,
  })
  return {
    mirror,
    setUser: (g: AlexaUserGrant) => {
      users = [g]
      t += 120_000 // past every cache
    },
    failMeta: (v: boolean) => {
      metaFails = v
      t += 120_000
    },
    stored: () => stored,
  }
}

describe('visibilityAllows', () => {
  it('fails closed for an account it knows nothing about', () => {
    expect(visibilityAllows(undefined, 1)).toBe(false)
    expect(visibilityAllows({ all: true }, 1)).toBe(true)
    expect(visibilityAllows({ view: [2] }, 1)).toBe(false)
  })
})

describe('AccountVisibilityMirror', () => {
  it('an admin link sees everything and nothing changes in Alexa', async () => {
    const h = harness()
    h.setUser({ userId: 'u', isAdmin: true, scopes: [] })
    expect(await h.mirror.refresh()).toEqual([])
    expect(h.mirror.allows('u', 3)).toBe(true)
  })

  it('heals a pre-S1 scoped link: events stop at once, the endpoints go after a second read', async () => {
    const h = harness()
    h.setUser({ userId: 'u', isAdmin: false, scopes: [ids([1])] })
    expect(await h.mirror.refresh()).toEqual([])
    expect(h.mirror.allows('u', 1)).toBe(true)
    expect(h.mirror.allows('u', 2)).toBe(false) // events stop immediately
    const second = await h.mirror.refresh()
    expect(second).toEqual([{ userId: 'u', added: [], removed: [2, 3] }])
    expect(await h.mirror.refresh()).toEqual([]) // and only once
  })

  it('a grant gained is pushed on the first read', async () => {
    const h = harness({ u: { view: [1] } })
    h.setUser({ userId: 'u', isAdmin: false, scopes: [ids([1, 2])] })
    expect(await h.mirror.refresh()).toEqual([{ userId: 'u', added: [2], removed: [] }])
    expect(h.mirror.allows('u', 2)).toBe(true)
  })

  it('a loss seen once and then reversed deletes nothing', async () => {
    const h = harness({ u: { view: [1, 2] } })
    h.setUser({ userId: 'u', isAdmin: false, scopes: [ids([1])] })
    expect(await h.mirror.refresh()).toEqual([])
    h.setUser({ userId: 'u', isAdmin: false, scopes: [ids([1, 2])] })
    const back = await h.mirror.refresh()
    expect(back).toEqual([{ userId: 'u', added: [2], removed: [] }])
    expect(await h.mirror.refresh()).toEqual([])
  })

  it('an unreadable registry keeps the previous answer instead of deleting', async () => {
    const h = harness({ u: { view: [1, 2] } })
    h.setUser({ userId: 'u', isAdmin: false, scopes: [ids([1, 2])] })
    h.failMeta(true)
    await h.mirror.refresh()
    await h.mirror.refresh()
    expect(h.stored()).toEqual({ u: { view: [1, 2] } })
  })

  it('a deleted hub user loses every device (after the confirming read)', async () => {
    const h = harness({ u: { all: true } })
    h.setUser({ userId: 'someone-else', isAdmin: true, scopes: [] })
    expect(await h.mirror.refresh()).toEqual([])
    expect(h.mirror.allows('u', 1)).toBe(false)
    expect(await h.mirror.refresh()).toEqual([{ userId: 'u', added: [], removed: [1, 2, 3] }])
  })
})
