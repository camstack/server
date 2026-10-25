/**
 * The verify-time `lastUsedAt` touch must never undo a revoke or an expiry
 * move (security review 2026-10-21, MEDIUM).
 *
 * `lookupLive` touches the row un-awaited, on the request path. It used to
 * write back the WHOLE row it had read: when a revoke landed between that
 * read and the touch's write, the touch restored the row as it was — live
 * again. The touch now patches `lastUsedAt` alone, merged into the row as it
 * is when the write lands.
 *
 * The race is made deterministic: the first write after `hold()` is parked
 * until `release()`, so the revoke provably lands between the touch's read
 * and its write.
 *
 * Disarm: make the touch `kind.put({ id, data: { ...row.data, lastUsedAt } })`
 * again → both rows below come back live.
 */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { CredentialTokenService } from '../credential-token.service.js'
import { coreAuthRecordKinds } from '../record-kinds.js'

const DAY_MS = 86_400_000

async function setup() {
  const world = makeInMemoryRecords('core-auth')
  await world.records.declare(coreAuthRecordKinds)
  const real = world.records.kind(coreAuthRecordKinds['credential-tokens'])
  let armed = false
  let parked: (() => void) | null = null
  const parkedDone: Promise<unknown>[] = []
  /** The same kind, with the first write after `hold()` parked until `release()`. */
  const kind = new Proxy(real, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver)
      if ((prop !== 'put' && prop !== 'patch') || typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (!armed) return Reflect.apply(value, target, args)
        armed = false
        const done = new Promise((resolve, reject) => {
          parked = () => {
            Promise.resolve(Reflect.apply(value, target, args)).then(resolve, reject)
          }
        })
        parkedDone.push(done)
        return done
      }
    },
  })
  let lastJti = ''
  const tokens = new CredentialTokenService({
    signCredentialToken: (claims) => {
      lastJti = claims.jti
      return 'signed'
    },
  })
  tokens.bindKind(() => kind)
  const hold = () => {
    armed = true
  }
  const release = async () => {
    parked?.()
    await Promise.allSettled(parkedDone)
  }
  const mint = async () => {
    const minted = await tokens.mint({
      subjectId: 'u-alice',
      createdBy: 'u-alice',
      label: 'ci',
      scopes: ['*'],
      expiresAt: Date.now() + DAY_MS,
    })
    return { id: minted.record.id, jti: lastJti }
  }
  return { tokens, hold, release, mint }
}

describe('the lastUsedAt touch writes lastUsedAt only', () => {
  it('SECURITY: a revoke that lands between the touch’s read and its write stays revoked', async () => {
    const h = await setup()
    const { id, jti } = await h.mint()
    h.hold()
    expect(await h.tokens.lookupLive(jti)).not.toBeNull() // reads the live row, parks its touch
    expect(await h.tokens.revoke(id)).toBe(true)
    await h.release()
    expect((await h.tokens.get(id))?.revokedAt).not.toBeNull()
    expect(await h.tokens.lookupLive(jti)).toBeNull()
  })

  it('SECURITY: an expiry move that lands between them stays moved', async () => {
    const h = await setup()
    const { id, jti } = await h.mint()
    const shortly = Date.now() + 60_000
    h.hold()
    await h.tokens.lookupLive(jti)
    await h.tokens.setExpiry(id, shortly)
    await h.release()
    expect((await h.tokens.get(id))?.expiresAt).toBe(shortly)
  })

  it('the touch still records the use', async () => {
    const h = await setup()
    const { id, jti } = await h.mint()
    await h.tokens.lookupLive(jti)
    await new Promise((r) => setTimeout(r, 0))
    expect((await h.tokens.get(id))?.lastUsedAt).toEqual(expect.any(Number))
  })
})
