import { describe, expect, it, vi } from 'vitest'
import { RelayPool } from '../relay-pool.js'
import { RELAY_DEFAULT_BODY, type SmtpRelayBody } from '../relay-record-kinds.js'
import { fakeFactory } from './support.js'

const log = { info: vi.fn(), warn: vi.fn() }
const relay = (name: string, host: string, extra: Partial<SmtpRelayBody> = {}): SmtpRelayBody => ({
  ...RELAY_DEFAULT_BODY,
  name,
  host,
  fromAddress: `${name}@example.com`,
  ...extra,
})
const mail = { to: 'ops@example.com', subject: 's', text: 't' }

describe('RelayPool', () => {
  it('a caller that names a relay reaches that relay and no other', async () => {
    const { factory, built } = fakeFactory()
    const pool = new RelayPool(factory, log)
    pool.apply('int_0001', relay('a', 'smtp.a.test'))
    pool.apply('int_0002', relay('b', 'smtp.b.test'))
    await pool.sendEmail('int_0002', mail)
    expect(built.map((t) => t.sent.length)).toEqual([0, 1])
    expect(built[1]?.sent[0]?.from).toBe('b@example.com')
  })

  it('a caller that names none gets the first configured relay (every legacy caller)', async () => {
    const { factory, built } = fakeFactory()
    const pool = new RelayPool(factory, log)
    pool.apply('int_0001', relay('empty', ''))
    pool.apply('int_0002', relay('b', 'smtp.b.test'))
    await pool.sendEmail(undefined, mail)
    expect(built).toHaveLength(1)
    expect(built[0]?.sent).toHaveLength(1)
    expect(pool.status(undefined).host).toBe('smtp.b.test')
  })

  it('an unknown relay is refused by name, never answered by another relay', async () => {
    const { factory, built } = fakeFactory()
    const pool = new RelayPool(factory, log)
    pool.apply('int_0001', relay('a', 'smtp.a.test'))
    await expect(pool.sendEmail('int_9999', mail)).rejects.toThrow('unknown relay "int_9999"')
    expect(pool.status('int_9999')).toMatchObject({ ready: false, host: '' })
    expect(built[0]?.sent).toHaveLength(0)
  })

  it('a change rebuilds that relay only; an unchanged body keeps its verified state', async () => {
    const { factory, built } = fakeFactory()
    const pool = new RelayPool(factory, log)
    pool.apply('int_0001', relay('a', 'smtp.a.test'))
    pool.apply('int_0002', relay('b', 'smtp.b.test'))
    await pool.verify('int_0001')
    await pool.verify('int_0002')
    pool.apply('int_0002', relay('b', 'smtp.b2.test'))
    pool.apply('int_0001', relay('a', 'smtp.a.test'))
    expect(pool.status('int_0001').ready).toBe(true)
    expect(pool.status('int_0002')).toMatchObject({ ready: false, host: 'smtp.b2.test' })
    expect(built).toHaveLength(3)
    expect(built[1]?.closed).toBe(true)
    expect(built[0]?.closed).toBe(false)
  })

  it('retainOnly closes the relays whose record is gone', () => {
    const { factory, built } = fakeFactory()
    const pool = new RelayPool(factory, log)
    pool.apply('int_0001', relay('a', 'smtp.a.test'))
    pool.apply('int_0002', relay('b', 'smtp.b.test'))
    pool.retainOnly(new Set(['int_0001']))
    expect(built.map((t) => t.closed)).toEqual([false, true])
    expect(pool.has('int_0002')).toBe(false)
  })

  describe('an instance that is switched off (D996)', () => {
    it('the default pick skips a relay that is off', async () => {
      const { factory, built } = fakeFactory()
      const pool = new RelayPool(factory, log)
      pool.apply('int_0001', relay('a', 'smtp.a.test', { enabled: false }))
      pool.apply('int_0002', relay('b', 'smtp.b.test'))
      await pool.sendEmail(undefined, mail)
      expect(built.map((t) => t.sent.length)).toEqual([0, 1])
      expect(pool.status(undefined).host).toBe('smtp.b.test')
    })

    it('with every relay off a default send is refused, not answered by an off relay', async () => {
      const { factory, built } = fakeFactory()
      const pool = new RelayPool(factory, log)
      pool.apply('int_0001', relay('a', 'smtp.a.test', { enabled: false }))
      await expect(pool.sendEmail(undefined, mail)).rejects.toThrow()
      expect(built[0]?.sent).toHaveLength(0)
    })

    it('a pinned relay that is off throws smtp.relay-disabled, is logged and is not substituted', async () => {
      const warn = vi.fn()
      const { factory, built } = fakeFactory()
      const pool = new RelayPool(factory, { info: vi.fn(), warn })
      pool.apply('int_0001', relay('a', 'smtp.a.test', { enabled: false }))
      pool.apply('int_0002', relay('b', 'smtp.b.test'))
      const err: unknown = await pool.sendEmail('int_0001', mail).catch((e: unknown) => e)
      expect(err).toMatchObject({
        i18nCode: 'smtp.relay-disabled',
        i18nParams: { id: 'int_0001', name: 'a' },
        message: 'smtp-nodemailer: relay "a" is switched off',
      })
      expect(built.map((t) => t.sent.length)).toEqual([0, 0])
      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ tags: expect.objectContaining({ phase: 'relay-disabled' }) }),
      )
    })

    it('verify still probes a disabled relay, and status reports not ready without an error', async () => {
      const { factory } = fakeFactory()
      const pool = new RelayPool(factory, log)
      pool.apply('int_0001', relay('a', 'smtp.a.test', { enabled: false }))
      expect(pool.status('int_0001')).toEqual({ ready: false, host: 'smtp.a.test' })
      const verified = await pool.verify('int_0001')
      expect(verified.ready).toBe(false)
      expect(verified.lastVerifiedAt).toBeDefined()
      expect(verified.error).toBeUndefined()
    })

    it('the toggle survives an apply of the same relay: it is not dropped as unchanged', async () => {
      const { factory } = fakeFactory()
      const pool = new RelayPool(factory, log)
      pool.apply('int_0001', relay('a', 'smtp.a.test'))
      pool.apply('int_0001', relay('a', 'smtp.a.test', { enabled: false }))
      await expect(pool.sendEmail('int_0001', mail)).rejects.toMatchObject({
        i18nCode: 'smtp.relay-disabled',
      })
      pool.apply('int_0001', relay('a', 'smtp.a.test'))
      await expect(pool.sendEmail('int_0001', mail)).resolves.toMatchObject({ accepted: [] })
    })
  })
})
