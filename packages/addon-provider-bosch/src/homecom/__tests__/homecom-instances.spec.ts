import { describe, expect, it } from 'vitest'
import { boschWorld } from '../../shared/__tests__/bosch-world.js'
import { buildHomeComTokenPersister } from '../homecom-token-persist.js'
import {
  buildHomeComInstances,
  HOMECOM_MIGRATIONS,
  HOMECOM_ROWS_TO_RECORD_ID,
  homeComConnectionOf,
  homeComRecordKinds,
  homeComRowsPorts,
  homeComStoredOf,
} from '../homecom-instances.js'

const TOKEN = 'access-CANARY-1'
const REFRESH = 'refresh-CANARY-1'
const EMAIL = 'me-CANARY@example.com'
const INTEGRATION = { id: 'int_0001', addonId: 'bosch-homecom', name: 'Home account' }

const world = () =>
  boschWorld({
    addonId: 'bosch-homecom',
    declare: (records) => records.declare(homeComRecordKinds),
    migrations: HOMECOM_MIGRATIONS,
    ports: homeComRowsPorts,
    integration: INTEGRATION,
    rows: {
      username: EMAIL,
      token: TOKEN,
      refresh: REFRESH,
      brand: 'buderus',
      region: 'us',
      gatewayId: 'gw-77',
      accountLabel: 'Me',
      gatewayCount: 2,
      stale: 'x',
    },
  })

const tester = {
  testSettings: async () => ({ outcome: 'validated' as const }),
}

describe('bosch-homecom integration rows move to a record', () => {
  it('the record holds the account, the choices and the three secrets; the rows are gone; a rerun is a no-op', async () => {
    const w = await world()
    expect(HOMECOM_MIGRATIONS.map((m) => m.meta.id)).toEqual([HOMECOM_ROWS_TO_RECORD_ID])
    await w.run()

    const handle = w.mem.records.kind(homeComRecordKinds.connections)
    expect((await handle.getResolved(INTEGRATION.id))?.data).toEqual({
      name: 'Home account',
      username: EMAIL,
      token: TOKEN,
      refresh: REFRESH,
      brand: 'buderus',
      region: 'us',
      gatewayId: 'gw-77',
      accountLabel: 'Me',
      gatewayCount: 2,
    })
    expect(w.rows.get(INTEGRATION.id)).toEqual({})
    expect(w.warnings.join(' ')).toContain('stale')
    const stored = JSON.stringify([...(w.mem.tables.get('connections')?.values() ?? [])])
    for (const secret of [EMAIL, TOKEN, REFRESH]) expect(stored).not.toContain(secret)

    expect(JSON.stringify(await w.run())).not.toContain('"done"')
  })

  it('the runtime reads the account from the record, and a rotated token is patched back', async () => {
    const w = await world()
    await w.run()
    const built = buildHomeComInstances(w.mem.records, { onChanged: async () => undefined, tester })
    expect(await homeComConnectionOf(built.instances, INTEGRATION.id)).toMatchObject({
      token: TOKEN,
      refresh: REFRESH,
      brand: 'buderus',
      gatewayId: 'gw-77',
    })
    expect(await homeComConnectionOf(built.instances, 'int_9999')).toBeNull()

    const persist = buildHomeComTokenPersister({
      read: (id) => homeComStoredOf(built.instances, id),
      patch: (id, patch) => built.handle.patch(id, patch),
      logger: { warn: () => undefined },
    })
    await persist(INTEGRATION.id, { token: 'access-ROTATED', refresh: 'refresh-ROTATED' })
    expect(await homeComConnectionOf(built.instances, INTEGRATION.id)).toMatchObject({
      token: 'access-ROTATED',
      refresh: 'refresh-ROTATED',
    })
  })
})
