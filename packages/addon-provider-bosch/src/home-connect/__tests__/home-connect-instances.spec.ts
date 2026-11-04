import { describe, expect, it } from 'vitest'
import { boschWorld } from '../../shared/__tests__/bosch-world.js'
import { buildHomeConnectConnectionPersister } from '../home-connect-connection-persist.js'
import {
  buildHomeConnectInstances,
  HOME_CONNECT_MIGRATIONS,
  HOME_CONNECT_ROWS_TO_RECORD_ID,
  homeConnectConnectionOf,
  homeConnectRecordKinds,
  homeConnectRowsPorts,
  homeConnectStoredOf,
} from '../home-connect-instances.js'

const TOKEN = 'access-CANARY-1'
const REFRESH = 'refresh-CANARY-1'
const PSK = 'psk-CANARY-AAAA'
const IV = 'iv64-CANARY-BBBB'
const INTEGRATION = { id: 'int_0001', addonId: 'bosch-home-connect', name: 'Home account' }

/** A row from before the keychain move: the pairing key sits inline, beside a marked label. */
const legacyRow = {
  haId: 'HAI-1',
  name: 'Kitchen',
  type: 'Dishwasher',
  host: 'BOSCH-Dishwasher-HAI-1',
  mode: 'TLS',
  psk: PSK,
  iv64: IV,
}

const world = () =>
  boschWorld({
    addonId: 'bosch-home-connect',
    declare: (records) => records.declare(homeConnectRecordKinds),
    migrations: HOME_CONNECT_MIGRATIONS,
    ports: homeConnectRowsPorts,
    integration: INTEGRATION,
    rows: {
      token: TOKEN,
      refresh: REFRESH,
      accountLabel: 'me@example.com',
      appliances: [
        legacyRow,
        { haId: 'HAI-BAD', name: 'Broken', type: 'Oven', host: '', mode: 'TLS', psk: PSK },
      ],
      accountPassword: 'never-stored',
      stale: 'x',
    },
  })

const tester = {
  describeTest: async () => ({ label: 'x' }),
  testSettings: async () => ({ outcome: 'validated' as const }),
}

describe('bosch-home-connect integration rows move to a record', () => {
  it('the record holds the account, the rows without keys and the pairing keys as secrets; the rows are gone; a rerun is a no-op', async () => {
    const w = await world()
    expect(HOME_CONNECT_MIGRATIONS.map((m) => m.meta.id)).toEqual([HOME_CONNECT_ROWS_TO_RECORD_ID])
    await w.run()

    const handle = w.mem.records.kind(homeConnectRecordKinds.connections)
    const data = (await handle.getResolved(INTEGRATION.id))?.data
    expect(data).toMatchObject({
      name: 'Home account',
      token: TOKEN,
      refresh: REFRESH,
      accountLabel: 'me@example.com',
    })
    expect(JSON.parse(data?.applianceSecrets ?? '{}')).toEqual({
      'HAI-1': { psk: PSK, iv64: IV },
    })
    expect(data?.appliances?.map((a) => a.haId)).toEqual(['HAI-1'])
    expect(JSON.stringify(data?.appliances)).not.toContain(PSK)
    expect(w.rows.get(INTEGRATION.id)).toEqual({})
    expect(w.warnings.join(' ')).toContain('stale')
    // the dropped row is named by its appliance id and the failing field, never a value
    expect(w.warnings.join(' ')).toContain("appliance row 'HAI-BAD'")
    expect(w.warnings.join(' ')).toContain('invalid: host')
    expect(w.warnings.join(' ')).not.toContain(PSK)
    expect(w.warnings.join(' ')).not.toContain('accountPassword')
    const stored = JSON.stringify([...(w.mem.tables.get('connections')?.values() ?? [])])
    for (const secret of [TOKEN, REFRESH, PSK, IV]) expect(stored).not.toContain(secret)

    expect(JSON.stringify(await w.run())).not.toContain('"done"')
  })

  it('the runtime reads the account and the appliance keys from the record', async () => {
    const w = await world()
    await w.run()
    const { instances } = buildHomeConnectInstances(w.mem.records, {
      onChanged: async () => undefined,
      tester,
    })
    const connection = await homeConnectConnectionOf(instances, INTEGRATION.id)
    expect(connection?.token).toBe(TOKEN)
    expect(connection?.appliances?.[0]).toMatchObject({ haId: 'HAI-1', psk: PSK, iv64: IV })
    expect(await homeConnectConnectionOf(instances, 'int_9999')).toBeNull()
  })

  it('what a connection learns is patched into the record, the pairing key staying a secret', async () => {
    const w = await world()
    await w.run()
    const built = buildHomeConnectInstances(w.mem.records, {
      onChanged: async () => undefined,
      tester,
    })
    const persist = buildHomeConnectConnectionPersister({
      read: (id) => homeConnectStoredOf(built.instances, id),
      patch: (id, patch) => built.handle.patch(id, patch),
      logger: { warn: () => undefined },
    })
    const connection = await homeConnectConnectionOf(built.instances, INTEGRATION.id)
    if (connection === null) throw new Error('the connection must be readable')
    await persist(INTEGRATION.id, {
      ...connection,
      token: 'access-ROTATED',
      refresh: 'ref-ROTATED',
    })

    const after = await homeConnectConnectionOf(built.instances, INTEGRATION.id)
    expect(after?.token).toBe('access-ROTATED')
    expect(after?.refresh).toBe('ref-ROTATED')
    expect(after?.appliances?.[0]?.psk).toBe(PSK)
    const stored = JSON.stringify([...(w.mem.tables.get('connections')?.values() ?? [])])
    for (const secret of ['access-ROTATED', PSK]) expect(stored).not.toContain(secret)
  })
})
