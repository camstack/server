/**
 * The Notification Center integration keeps a name-only instance record under its registry id
 * (epic #440), over a REAL records engine on SQLite: the alarm panel's declaration pass writes it,
 * a later pass never overwrites it, and it carries no switch (the registry flag is the one store
 * of a fixed builtin).
 */
import { RecordsEngine } from '@camstack/server/system'
import {
  type AddonContext,
  createRecordsAccess,
  type IIntegrationInstancesProvider,
  type RecordsAccess,
  type RecordsTransport,
} from '@camstack/types'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NC_INTEGRATION_NAME } from '../../notification-center/alarm/alarm-panel-declaration.js'
import {
  alarmPanelConnectionsEntryKind,
  alarmPanelInstanceRecordKinds,
  buildAlarmPanelInstances,
} from '../alarm-panel-instances.js'
import { BuildAlarmPanel } from '../boot/build-alarm-panel.js'
import type { AnalyticsApi } from '../boot/boot-types.js'
import { makeSilentLogger } from './test-helpers.js'

const OWNER = 'pipeline-analytics'
const INTEGRATION_ID = 'int_0018'

function engineTransport(engine: RecordsEngine): RecordsTransport {
  const as = <I extends object>(input: I): I & { readonly owner: string } =>
    Object.assign({}, input, { owner: OWNER })
  return {
    declareKinds: (i) => engine.declareKinds(as(i)),
    get: (i) => engine.get(as(i)),
    getMany: (i) => engine.getMany(as(i)),
    secretRefs: (i) => engine.secretRefs(as(i)),
    put: (i) => engine.put(as(i)),
    putMany: (i) => engine.putMany(as(i)),
    patch: (i) => engine.patch(as(i)),
    delete: (i) => engine.delete(as(i)),
    deleteMany: (i) => engine.deleteMany(as(i)),
    query: (i) => engine.query(as(i)),
    count: (i) => engine.count(as(i)),
    histogram: (i) => engine.histogram(as(i)),
    aggregate: (i) => engine.aggregate(as(i)),
    deleteWhere: (i) => engine.deleteWhere(as(i)),
    transact: (i) => engine.transact(as(i)),
    deleteDevice: (i) => engine.deleteDevice(as(i)),
    allocateId: (i) => engine.allocateId(as(i)),
  }
}

interface Kit {
  readonly records: RecordsAccess
  readonly instances: IIntegrationInstancesProvider
  /** Runs the alarm panel's declaration pass against a registry row named `rowName`. */
  readonly declarePass: (rowName: string | null) => Promise<void>
  readonly warn: ReturnType<typeof vi.fn>
  readonly info: ReturnType<typeof vi.fn>
  /** Makes the next reads of the records fail (or work again). */
  readonly recordsDown: { value: boolean }
}

async function makeKit(localNodeId = 'hub'): Promise<Kit> {
  const engine = new RecordsEngine(new Database(':memory:'), {
    databaseId: 'settings',
    logger: makeSilentLogger(),
  })
  const records = createRecordsAccess({
    owner: OWNER,
    transport: engineTransport(engine),
    secrets: null,
  })
  await records.declare(alarmPanelInstanceRecordKinds)
  const instances = buildAlarmPanelInstances(records).toProvider()

  const devices = {
    create: vi.fn(async () => ({ id: 42, stableId: 'nc-alarm-panel' })),
    remove: vi.fn(async () => undefined),
    getAll: vi.fn(async () => []),
  }
  // Documented type boundary: the pass reads `logger`, `kernel` and `records` of the context and
  // `integrations` / `deviceManager` of the api; nothing else of either is touched.
  const warn = vi.fn()
  const info = vi.fn()
  const recordsDown = { value: false }
  const logger = { ...makeSilentLogger(), warn, info }
  const ctx = {
    logger,
    kernel: { devices, localNodeId },
    get records() {
      return recordsDown.value ? undefined : records
    },
  } as unknown as AddonContext<Record<string, unknown>>
  const boot = new BuildAlarmPanel({
    ctx: () => ctx,
    shuttingDown: () => false,
    alarmPanelConvergence: () => null,
    setAlarmPanelConvergence: () => undefined,
    alarmPanelDevice: () => null,
    setAlarmPanelDevice: () => undefined,
    notificationCenter: () => null,
    alarmPanelWired: () => false,
    setAlarmPanelWired: () => undefined,
  })
  const declarePass = async (rowName: string | null): Promise<void> => {
    const api = {
      integrations: {
        getByAddonId: {
          query: async () =>
            rowName === null ? null : { id: INTEGRATION_ID, name: rowName, info: { fixed: true } },
        },
        create: { mutate: async () => ({ id: INTEGRATION_ID }) },
        update: { mutate: async () => undefined },
      },
      deviceManager: { listAll: { query: async () => [] } },
    } as unknown as AnalyticsApi
    await boot.attemptAlarmPanelDeclaration(api)
  }
  return { records, instances, declarePass, warn, info, recordsDown }
}

describe('the Notification Center integration instance record', () => {
  let kit: Kit
  beforeEach(async () => {
    kit = await makeKit()
  })

  it('is written under the registry id on the pass that mints the row', async () => {
    await kit.declarePass(null)
    expect(await kit.instances.getInstance({ id: INTEGRATION_ID })).toMatchObject({
      id: INTEGRATION_ID,
      name: NC_INTEGRATION_NAME,
    })
  })

  it('is written for a row that predates it, under the name the row carries now', async () => {
    await kit.declarePass('My notifications')
    expect(await kit.instances.getInstance({ id: INTEGRATION_ID })).toMatchObject({
      name: 'My notifications',
    })
  })

  it('is never overwritten by a later pass', async () => {
    await kit.declarePass(NC_INTEGRATION_NAME)
    await kit.records.kind(alarmPanelConnectionsEntryKind).patch(INTEGRATION_ID, {
      name: 'Renamed in the record',
    })
    await kit.declarePass(NC_INTEGRATION_NAME)
    expect(await kit.instances.getInstance({ id: INTEGRATION_ID })).toMatchObject({
      name: 'Renamed in the record',
    })
    expect(await kit.instances.listInstances()).toHaveLength(1)
  })

  it('reports a seed failure once while it lasts, not on every pass', async () => {
    kit.recordsDown.value = true
    await kit.declarePass(null)
    await kit.declarePass(null)
    await kit.declarePass(null)
    const seedWarnings = kit.warn.mock.calls.filter(([m]) => String(m).includes('could not seed'))
    expect(seedWarnings).toHaveLength(1)
    expect(seedWarnings[0]?.[1]).toMatchObject({ tags: { integrationId: INTEGRATION_ID } })
    kit.recordsDown.value = false
    await kit.declarePass(null)
    expect(await kit.instances.getInstance({ id: INTEGRATION_ID })).not.toBeNull()
  })

  it('leaves the record unwritten and logs no warning on a node that is not the hub', async () => {
    const agent = await makeKit('little-unraid')
    agent.recordsDown.value = true
    await agent.declarePass(null)
    await agent.declarePass(null)
    agent.recordsDown.value = false
    await agent.declarePass(null)
    expect(await agent.instances.getInstance({ id: INTEGRATION_ID })).toBeNull()
    expect(agent.warn.mock.calls.filter(([m]) => String(m).includes('seed'))).toHaveLength(0)
  })

  it('logs the recovery exactly once when the failure clears', async () => {
    kit.recordsDown.value = true
    await kit.declarePass(null)
    kit.recordsDown.value = false
    await kit.declarePass(null)
    await kit.declarePass(null)
    const recovered = kit.info.mock.calls.filter(([m]) => String(m).includes('is seeded'))
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.[1]).toMatchObject({ tags: { integrationId: INTEGRATION_ID } })
  })

  it('carries no switch of its own', async () => {
    await kit.declarePass(NC_INTEGRATION_NAME)
    const instance = await kit.instances.getInstance({ id: INTEGRATION_ID })
    expect(instance?.formValues).not.toHaveProperty('enabled')
    expect(await kit.instances.describe()).toMatchObject({
      role: 'devices',
      instanceMode: 'single',
    })
  })
})
