import { describe, expect, it } from 'vitest'
import { boschWorld } from '../../shared/__tests__/bosch-world.js'
import {
  buildShcInstances,
  SHC_MIGRATIONS,
  SHC_ROWS_TO_RECORD_ID,
  shcConnectionOf,
  shcRecordKinds,
  shcRowsPorts,
} from '../shc-instances.js'

const CERT = '-----BEGIN CERTIFICATE-----CANARY-cert'
const KEY = '-----BEGIN PRIVATE KEY-----CANARY-key'
const TOKEN = 'shc-token-CANARY'
const INTEGRATION = { id: 'int_0001', addonId: 'bosch-shc', name: 'Hall controller' }

const world = () =>
  boschWorld({
    addonId: 'bosch-shc',
    declare: (records) => records.declare(shcRecordKinds),
    migrations: SHC_MIGRATIONS,
    ports: shcRowsPorts,
    integration: INTEGRATION,
    rows: {
      host: '192.0.2.20',
      sslCertificate: CERT,
      sslKey: KEY,
      token: TOKEN,
      systemPassword: 'x',
    },
  })

describe('bosch-shc integration rows move to a record', () => {
  it('the record holds the host and the three secrets; the rows are gone; a rerun is a no-op', async () => {
    const w = await world()
    expect(SHC_MIGRATIONS.map((m) => m.meta.id)).toEqual([SHC_ROWS_TO_RECORD_ID])
    await w.run()

    const handle = w.mem.records.kind(shcRecordKinds.connections)
    expect((await handle.getResolved(INTEGRATION.id))?.data).toEqual({
      name: 'Hall controller',
      host: '192.0.2.20',
      sslCertificate: CERT,
      sslKey: KEY,
      token: TOKEN,
    })
    expect(w.rows.get(INTEGRATION.id)).toEqual({})
    expect(w.warnings.join(' ')).toContain('systemPassword')
    const stored = JSON.stringify([...(w.mem.tables.get('connections')?.values() ?? [])])
    for (const secret of [CERT, KEY, TOKEN]) expect(stored).not.toContain(secret)

    expect(JSON.stringify(await w.run())).not.toContain('"done"')
  })

  it('the runtime reads the connection from the record, certificate and key included', async () => {
    const w = await world()
    await w.run()
    const { instances } = buildShcInstances(w.mem.records, {
      onChanged: async () => undefined,
      tester: {
        testSettings: async () => ({ outcome: 'validated' }),
      },
    })
    expect(await shcConnectionOf(instances, INTEGRATION.id)).toEqual({
      host: '192.0.2.20',
      sslCertificate: CERT,
      sslKey: KEY,
      token: TOKEN,
    })
    expect(await shcConnectionOf(instances, 'int_9999')).toBeNull()
  })

  it('an edit never writes a form-only value (the pairing password) into the record', async () => {
    const w = await world()
    await w.run()
    const { provider } = buildShcInstances(w.mem.records, {
      onChanged: async () => undefined,
      tester: {
        testSettings: async () => ({ outcome: 'validated' }),
      },
    })
    await provider.updateInstance({
      id: INTEGRATION.id,
      values: { host: '192.0.2.99', systemPassword: 'typed-PASSWORD-CANARY' },
    })
    const stored = JSON.stringify([...(w.mem.tables.get('connections')?.values() ?? [])])
    expect(stored).toContain('192.0.2.99')
    expect(stored).not.toContain('typed-PASSWORD-CANARY')
  })
})
