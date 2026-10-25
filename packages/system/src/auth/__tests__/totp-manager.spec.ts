import { describe, it, expect, beforeEach } from 'vitest'
import { generateSync } from 'otplib'
import { TotpManager } from '../totp-manager.js'
import { isSecretMarker, type SettingsStoreClient } from '@camstack/types'
import { TotpSecretStorageUnavailableError, TotpSecretUnavailableError } from '../totp-manager.js'
import { makeFakeKeychain, type FakeKeychain } from './fake-keychain.js'

/**
 * TotpManager covers the full 2FA lifecycle on a single user record:
 * setup → confirm → verify → disable. All state lives in an in-memory
 * fake of the `user_totp` settings-store collection so the suite is
 * fast and deterministic.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a TOTP code as if the clock were offset by `offsetMs`. otplib
 * v13's functional API takes the epoch per call (in SECONDS), so this is
 * stateless — no shared singleton to mutate or restore. The manager's
 * subsequent verify runs against the real clock.
 */
function generateAtSkew(secret: string, offsetMs: number): string {
  return generateSync({ secret, epoch: Math.floor((Date.now() + offsetMs) / 1000) })
}

// ---------------------------------------------------------------------------
// In-memory settings-store fake — just enough to satisfy TotpManager
// ---------------------------------------------------------------------------

interface Row {
  id: string
  data: Record<string, unknown>
}

function makeFakeStore(): { store: SettingsStoreClient; rows: Map<string, Row> } {
  const rows = new Map<string, Row>()
  const store = {
    insert: {
      mutate: async (args: { collection: string; record: Row }) => {
        rows.set(args.record.id, { id: args.record.id, data: { ...args.record.data } })
      },
    },
    update: {
      mutate: async (args: { collection: string; id: string; data: Record<string, unknown> }) => {
        rows.set(args.id, { id: args.id, data: { ...args.data } })
      },
    },
    delete: {
      mutate: async (args: { collection: string; key: string }) => {
        rows.delete(args.key)
      },
    },
    query: {
      query: async (args: { collection: string; filter?: { where?: Record<string, unknown> } }) => {
        const where = args.filter?.where ?? {}
        return Array.from(rows.values()).filter((row) => {
          for (const [k, v] of Object.entries(where)) {
            if (row.data[k] !== v) return false
          }
          return true
        })
      },
    },
  } as unknown as SettingsStoreClient
  return { store, rows }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TotpManager', () => {
  let store: SettingsStoreClient
  let rows: Map<string, Row>
  let mgr: TotpManager
  let keychain: FakeKeychain

  beforeEach(() => {
    // otplib v13's functional API is stateless (epoch passed per call), so
    // there is no shared option singleton to reset between tests.
    const fake = makeFakeStore()
    store = fake.store
    rows = fake.rows
    keychain = makeFakeKeychain()
    mgr = new TotpManager(store, { secrets: keychain.access })
  })

  describe('setup', () => {
    it('returns a base32 secret + otpauth:// URL', async () => {
      const { secret, otpauthUrl } = await mgr.setup('u-1', 'alice')
      expect(secret).toMatch(/^[A-Z2-7]+$/) // RFC 4648 base32
      expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\/CamStack:alice\?/)
      expect(otpauthUrl).toContain(`secret=${secret}`)
      expect(otpauthUrl).toContain('issuer=CamStack')
    })

    it('persists a pending row (confirmedAt = null)', async () => {
      await mgr.setup('u-1', 'alice')
      const row = rows.get('u-1')!
      expect(row.data['confirmedAt']).toBeNull()
      expect(typeof row.data['createdAt']).toBe('number')
    })

    it('replaces a prior pending row on re-setup (fresh secret)', async () => {
      const a = await mgr.setup('u-1', 'alice')
      const b = await mgr.setup('u-1', 'alice')
      expect(a.secret).not.toBe(b.secret)
      // The keychain holds the LAST setup's seed; the row holds only a marker
      expect([...keychain.values.values()]).toEqual([b.secret])
      expect(JSON.stringify(rows.get('u-1')!.data)).not.toContain(b.secret)
    })
  })

  describe('confirm', () => {
    it('flips confirmedAt when the code matches the pending secret', async () => {
      const { secret } = await mgr.setup('u-1', 'alice')
      const code = generateSync({ secret })
      const ok = await mgr.confirm('u-1', code)
      expect(ok).toBe(true)
      expect(rows.get('u-1')!.data['confirmedAt']).toEqual(expect.any(Number))
    })

    it('returns false on wrong code (row stays pending)', async () => {
      await mgr.setup('u-1', 'alice')
      const ok = await mgr.confirm('u-1', '000000')
      expect(ok).toBe(false)
      expect(rows.get('u-1')!.data['confirmedAt']).toBeNull()
    })

    it('returns false when the user has no pending row', async () => {
      const ok = await mgr.confirm('u-nobody', '123456')
      expect(ok).toBe(false)
    })

    it('is idempotent on already-confirmed rows (re-confirm succeeds, no state change)', async () => {
      const { secret } = await mgr.setup('u-1', 'alice')
      const code = generateSync({ secret })
      await mgr.confirm('u-1', code)
      const confirmedAt = rows.get('u-1')!.data['confirmedAt']
      // wait a tick so any new Date.now() would differ
      await new Promise((r) => setTimeout(r, 5))
      const ok = await mgr.confirm('u-1', generateSync({ secret }))
      expect(ok).toBe(true)
      expect(rows.get('u-1')!.data['confirmedAt']).toBe(confirmedAt)
    })
  })

  describe('verify', () => {
    it('returns true for a valid code against a CONFIRMED secret', async () => {
      const { secret } = await mgr.setup('u-1', 'alice')
      await mgr.confirm('u-1', generateSync({ secret }))
      const valid = await mgr.verify('u-1', generateSync({ secret }))
      expect(valid).toBe(true)
    })

    it('returns false against a PENDING (unconfirmed) secret — even with a valid code', async () => {
      const { secret } = await mgr.setup('u-1', 'alice')
      const valid = await mgr.verify('u-1', generateSync({ secret }))
      expect(valid).toBe(false)
    })

    it('returns false on wrong code', async () => {
      const { secret } = await mgr.setup('u-1', 'alice')
      await mgr.confirm('u-1', generateSync({ secret }))
      const valid = await mgr.verify('u-1', '000000')
      expect(valid).toBe(false)
    })

    it('returns false for users with no row', async () => {
      const valid = await mgr.verify('u-nobody', '123456')
      expect(valid).toBe(false)
    })

    it('tolerates clock skew within the configured window (default ±30s)', async () => {
      const { secret } = await mgr.setup('u-1', 'alice')
      await mgr.confirm('u-1', generateSync({ secret }))
      // Generate a code from a 30-second-earlier counter — should still match
      // because the manager's default window=1 maps to ±30 s epochTolerance.
      const skewed = generateAtSkew(secret, -30_000)
      const valid = await mgr.verify('u-1', skewed)
      expect(valid).toBe(true)
    })

    it('rejects codes outside the configured window (±90s and beyond)', async () => {
      const { secret } = await mgr.setup('u-1', 'alice')
      await mgr.confirm('u-1', generateSync({ secret }))
      // Three steps in the past (90s) — beyond window=1 (which is ±30s).
      const stale = generateAtSkew(secret, -90_000)
      const valid = await mgr.verify('u-1', stale)
      expect(valid).toBe(false)
    })
  })

  describe('disable', () => {
    it('removes the row (next setup starts fresh)', async () => {
      await mgr.setup('u-1', 'alice')
      await mgr.disable('u-1')
      expect(rows.has('u-1')).toBe(false)
    })

    it('is idempotent — no-op when the user has no row', async () => {
      await expect(mgr.disable('u-nobody')).resolves.toBeUndefined()
    })

    it('disable + setup yields a different secret (no reuse on rotation)', async () => {
      const a = await mgr.setup('u-1', 'alice')
      await mgr.confirm('u-1', generateSync({ secret: a.secret }))
      await mgr.disable('u-1')
      const b = await mgr.setup('u-1', 'alice')
      expect(b.secret).not.toBe(a.secret)
      expect(rows.get('u-1')!.data['confirmedAt']).toBeNull()
    })
  })

  describe('getStatus', () => {
    it('reports `enabled: false` + `confirmedAt: null` when no row exists', async () => {
      const status = await mgr.getStatus('u-nobody')
      expect(status).toEqual({ enabled: false, confirmedAt: null })
    })

    it('reports `enabled: false` for pending half-enrollments', async () => {
      await mgr.setup('u-1', 'alice')
      const status = await mgr.getStatus('u-1')
      expect(status).toEqual({ enabled: false, confirmedAt: null })
    })

    it('reports `enabled: true` + numeric confirmedAt for active enrollment', async () => {
      const { secret } = await mgr.setup('u-1', 'alice')
      await mgr.confirm('u-1', generateSync({ secret }))
      const status = await mgr.getStatus('u-1')
      expect(status.enabled).toBe(true)
      expect(typeof status.confirmedAt).toBe('number')
    })
  })

  describe('multi-user isolation', () => {
    it('keeps secrets and confirmations independent across users', async () => {
      const a = await mgr.setup('u-a', 'alice')
      const b = await mgr.setup('u-b', 'bob')
      expect(a.secret).not.toBe(b.secret)
      // Confirm only A
      await mgr.confirm('u-a', generateSync({ secret: a.secret }))
      expect((await mgr.getStatus('u-a')).enabled).toBe(true)
      expect((await mgr.getStatus('u-b')).enabled).toBe(false)
      // A's code shouldn't verify against B's secret
      const aCode = generateSync({ secret: a.secret })
      expect(await mgr.verify('u-b', aCode)).toBe(false)
    })
  })

  describe('configurable window', () => {
    it('honors a tighter window=0 (no skew tolerance)', async () => {
      const tight = new TotpManager(store, { window: 0, secrets: keychain.access })
      const { secret } = await tight.setup('u-1', 'alice')
      await tight.confirm('u-1', generateSync({ secret }))
      // ±30s code outside the tight window — with window=0, a 30s skew
      // is rejected.
      const skewed = generateAtSkew(secret, -30_000)
      const valid = await tight.verify('u-1', skewed)
      expect(valid).toBe(false)
    })
  })
})

describe('TotpManager - the seed lives in the keychain (D878)', () => {
  function build() {
    const { store, rows } = makeFakeStore()
    const keychain = makeFakeKeychain()
    const mgr = new TotpManager(store, { secrets: keychain.access })
    return { store, rows, keychain, mgr }
  }

  it('the row holds a keychain marker, never the seed', async () => {
    const { rows, keychain, mgr } = build()
    const { secret } = await mgr.setup('u-1', 'alice')
    const column = rows.get('u-1')!.data['secret']
    expect(typeof column).toBe('string')
    expect(isSecretMarker(JSON.parse(String(column)))).toBe(true)
    expect(String(column)).not.toContain(secret)
    expect(keychain.values.size).toBe(1)
  })

  it('an enrolled user keeps verifying through the keychain', async () => {
    const { mgr } = build()
    const { secret } = await mgr.setup('u-1', 'alice')
    await mgr.confirm('u-1', generateSync({ secret }))
    expect(await mgr.verify('u-1', generateSync({ secret }))).toBe(true)
    expect(await mgr.verify('u-1', '000000')).toBe(false)
  })

  it('a locked keychain FAILS CLOSED: verify and confirm throw, never accept', async () => {
    const { keychain, mgr } = build()
    const { secret } = await mgr.setup('u-1', 'alice')
    await mgr.confirm('u-1', generateSync({ secret }))
    keychain.setLocked(true)
    await expect(mgr.verify('u-1', generateSync({ secret }))).rejects.toBeInstanceOf(
      TotpSecretUnavailableError,
    )
    await expect(mgr.confirm('u-1', generateSync({ secret }))).rejects.toBeInstanceOf(
      TotpSecretUnavailableError,
    )
    // status needs no seed: the user still reads as enrolled, not "not set up"
    expect((await mgr.getStatus('u-1')).enabled).toBe(true)
  })

  it('a seed missing from the keychain also fails closed', async () => {
    const { keychain, mgr } = build()
    const { secret } = await mgr.setup('u-1', 'alice')
    await mgr.confirm('u-1', generateSync({ secret }))
    keychain.values.clear()
    await expect(mgr.verify('u-1', generateSync({ secret }))).rejects.toBeInstanceOf(
      TotpSecretUnavailableError,
    )
  })

  it('setup is refused while locked, before the previous enrolment is touched', async () => {
    const { rows, keychain, mgr } = build()
    const first = await mgr.setup('u-1', 'alice')
    await mgr.confirm('u-1', generateSync({ secret: first.secret }))
    keychain.setLocked(true)
    await expect(mgr.setup('u-1', 'alice')).rejects.toBeInstanceOf(
      TotpSecretStorageUnavailableError,
    )
    expect(rows.get('u-1')!.data['confirmedAt']).toEqual(expect.any(Number))
  })

  it('setup without a keychain door is refused, never stored inline', async () => {
    const { store, rows } = makeFakeStore()
    const mgr = new TotpManager(store)
    await expect(mgr.setup('u-1', 'alice')).rejects.toBeInstanceOf(
      TotpSecretStorageUnavailableError,
    )
    expect(rows.size).toBe(0)
  })

  it('disable removes the seed from the keychain', async () => {
    const { keychain, mgr } = build()
    await mgr.setup('u-1', 'alice')
    await mgr.disable('u-1')
    expect(keychain.values.size).toBe(0)
  })

  describe('migrateRawSecrets', () => {
    const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
    function seedInline(rows: Map<string, Row>, userId: string): void {
      rows.set(userId, {
        id: userId,
        data: { userId, secret: SEED, confirmedAt: 1, createdAt: 1 },
      })
    }

    it('an enrolment from before D878 still verifies (inline seed)', async () => {
      const { rows, mgr } = build()
      seedInline(rows, 'legacy')
      expect(await mgr.verify('legacy', generateSync({ secret: SEED }))).toBe(true)
    })

    it('a dry run counts and changes nothing', async () => {
      const { rows, mgr } = build()
      seedInline(rows, 'legacy')
      const report = await mgr.migrateRawSecrets(false)
      expect(report).toMatchObject({
        rows: 1,
        raw: 1,
        migrated: 0,
        remainingRaw: 1,
        verified: false,
      })
      expect(rows.get('legacy')!.data['secret']).toBe(SEED)
    })

    it('apply moves the seed, the user still verifies, a second run is a no-op', async () => {
      const { rows, mgr } = build()
      seedInline(rows, 'legacy')
      const report = await mgr.migrateRawSecrets(true)
      expect(report).toMatchObject({
        raw: 1,
        migrated: 1,
        failed: 0,
        remainingRaw: 0,
        verified: true,
      })
      expect(String(rows.get('legacy')!.data['secret'])).not.toContain(SEED)
      expect(await mgr.verify('legacy', generateSync({ secret: SEED }))).toBe(true)
      expect(await mgr.migrateRawSecrets(true)).toMatchObject({
        raw: 0,
        migrated: 0,
        verified: true,
      })
    })

    it('a locked keychain keeps the inline seed and reports the failure', async () => {
      const { rows, keychain, mgr } = build()
      seedInline(rows, 'legacy')
      keychain.setLocked(true)
      const report = await mgr.migrateRawSecrets(true)
      expect(report).toMatchObject({ migrated: 0, failed: 1, remainingRaw: 1, verified: false })
      expect(rows.get('legacy')!.data['secret']).toBe(SEED)
    })

    it('the report never carries a seed', async () => {
      const { rows, mgr } = build()
      seedInline(rows, 'legacy')
      expect(JSON.stringify(await mgr.migrateRawSecrets(true))).not.toContain(SEED)
    })
  })

  describe('review hardening', () => {
    const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'

    it('M1: a marker pointing at another ref is refused and never resolved', async () => {
      const { rows, keychain, mgr } = build()
      const victim = await mgr.setup('victim', 'v')
      await mgr.confirm('victim', generateSync({ secret: victim.secret }))
      const victimRef = [...keychain.values.keys()][0]!
      const attacker = await mgr.setup('attacker', 'a')
      await mgr.confirm('attacker', generateSync({ secret: attacker.secret }))
      const row = rows.get('attacker')!
      rows.set('attacker', {
        id: 'attacker',
        data: { ...row.data, secret: JSON.stringify({ $secret: victimRef, v: 1 }) },
      })
      await expect(
        mgr.verify('attacker', generateSync({ secret: victim.secret })),
      ).rejects.toBeInstanceOf(TotpSecretUnavailableError)
    })

    it('L3: a malformed or empty column fails closed, never read as an inline seed', async () => {
      const { rows, mgr } = build()
      for (const secret of ['{not json', '{"x":1}', '']) {
        rows.set('u', { id: 'u', data: { userId: 'u', secret, confirmedAt: 1, createdAt: 1 } })
        await expect(mgr.verify('u', '123456')).rejects.toBeInstanceOf(TotpSecretUnavailableError)
      }
    })

    it('L4: the caller sees a generic message; the keychain reason goes to the log', async () => {
      const { store } = makeFakeStore()
      const keychain = makeFakeKeychain()
      const warns: unknown[] = []
      const logger = { warn: (...a: unknown[]) => warns.push(a) } as never
      const mgr = new TotpManager(store, { secrets: keychain.access, logger })
      const { secret } = await mgr.setup('u-1', 'alice')
      await mgr.confirm('u-1', generateSync({ secret }))
      keychain.setLocked(true)
      const err = await mgr.verify('u-1', '000000').catch((e: unknown) => e)
      expect(String((err as Error).message)).not.toMatch(/keychain|key-missing|secret/i)
      expect(JSON.stringify(warns)).toContain('key-missing')
    })

    it('L5: setup drops the old row before the seed under the same ref changes', async () => {
      const { rows, keychain, mgr } = build()
      const first = await mgr.setup('u-1', 'alice')
      await mgr.confirm('u-1', generateSync({ secret: first.secret }))
      const put = keychain.access.put
      let rowAtPut: boolean | null = null
      keychain.access.put = async (ref, value) => {
        rowAtPut = rows.has('u-1')
        return put(ref, value)
      }
      await mgr.setup('u-1', 'alice')
      expect(rowAtPut).toBe(false)
    })

    it('L5: a migration racing a setup never overwrites the new seed', async () => {
      const { rows, mgr } = build()
      rows.set('u-1', {
        id: 'u-1',
        data: { userId: 'u-1', secret: SEED, confirmedAt: 1, createdAt: 1 },
      })
      const [, fresh] = await Promise.all([mgr.migrateRawSecrets(true), mgr.setup('u-1', 'alice')])
      await mgr.confirm('u-1', generateSync({ secret: fresh.secret }))
      expect(await mgr.verify('u-1', generateSync({ secret: fresh.secret }))).toBe(true)
    })
  })
})
