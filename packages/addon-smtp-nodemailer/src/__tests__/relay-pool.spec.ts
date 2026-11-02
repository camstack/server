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
})
