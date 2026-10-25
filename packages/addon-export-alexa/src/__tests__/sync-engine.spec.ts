import { describe, it, expect } from 'vitest'
import { SyncEngine, type SyncEngineDeps } from '../sync-engine.js'
import type { AlexaEndpoint } from '../endpoints/types.js'

function ep(id: string): AlexaEndpoint {
  return {
    endpointId: id,
    friendlyName: id,
    description: 'd',
    manufacturerName: 'CamStack',
    displayCategories: ['CAMERA'],
    capabilities: [{ type: 'AlexaInterface', interface: 'Alexa', version: '3' }],
  }
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  withTags: () => noopLogger,
} as unknown as SyncEngineDeps['logger']

interface HarnessOpts {
  exposed?: number[]
  accounts?: string[]
  endpoints?: Record<number, AlexaEndpoint[]>
  failAddFor?: Set<string> // `${userId}:${deviceId}`
  /** Accounts whose DeleteReport the gateway refuses. */
  failDeleteFor?: Set<string>
  hasCredentials?: boolean
  /** Per-user endpoint filter (S1). Absent = the user sees everything;
   *  `null` = the user's grants are unreadable. */
  visibleFor?: Record<string, ((endpointId: string) => boolean) | null>
}

function makeHarness(opts: HarnessOpts = {}) {
  const exported: Record<number, readonly string[]> = {}
  const signatures: Record<number, string> = {}
  const addCalls: Array<{ userId: string; ids: string[] }> = []
  const delCalls: Array<{ userId: string; ids: string[] }> = []
  let setExportedCalls = 0
  const pushedHook: Array<{ userId: string; ids: string[] }> = []
  const deps: SyncEngineDeps = {
    logger: noopLogger,
    listExposed: () =>
      (opts.exposed ?? []).map((deviceId) => ({ deviceId, exposedAt: 0, capabilities: [] })),
    listLinkedAccounts: () =>
      (opts.accounts ?? []).map((userId) => ({ userId, username: userId, linkedAt: 0 })),
    hasProactiveCredentials: () => opts.hasCredentials ?? true,
    buildEndpoints: async (deviceId) => opts.endpoints?.[deviceId] ?? [],
    mayRetire: (id) => id.includes('__det_'),
    afterPush: (userId, endpoints) => {
      pushedHook.push({ userId, ids: endpoints.map((e) => e.endpointId) })
    },
    filterForAccount: async (userId, endpoints) => {
      const rule = opts.visibleFor?.[userId]
      if (rule === null) return null
      return rule === undefined ? endpoints : endpoints.filter((e) => rule(e.endpointId))
    },
    postAddOrUpdate: async (userId, endpoints) => {
      const dev = endpoints[0]?.endpointId.split('__')[0] ?? '?'
      addCalls.push({ userId, ids: endpoints.map((e) => e.endpointId) })
      return !opts.failAddFor?.has(`${userId}:${dev}`)
    },
    postDelete: async (userId, ids) => {
      delCalls.push({ userId, ids: [...ids] })
      return !opts.failDeleteFor?.has(userId)
    },
    getExportedEndpoints: () => exported,
    setExportedEndpoints: async (next) => {
      setExportedCalls += 1
      for (const k of Object.keys(exported)) delete exported[Number(k)]
      Object.assign(exported, next)
    },
    getExportedSignatures: () => signatures,
    setExportedSignatures: async (next) => {
      for (const k of Object.keys(signatures)) delete signatures[Number(k)]
      Object.assign(signatures, next)
    },
  }
  return {
    deps,
    exported,
    signatures,
    addCalls,
    delCalls,
    pushedHook,
    setExportedCalls: () => setExportedCalls,
  }
}

describe('SyncEngine.pushDevice', () => {
  it('builds the device once and posts AddOrUpdate to every linked account, recording its endpoint ids', async () => {
    const h = makeHarness({
      exposed: [15],
      accounts: ['userA', 'userB'],
      endpoints: { 15: [ep('15'), ep('15__privacy')] },
    })
    const engine = new SyncEngine(h.deps)
    const result = await engine.pushDevice(15)

    expect(h.addCalls.map((c) => c.userId).toSorted()).toEqual(['userA', 'userB'])
    expect(h.addCalls[0]!.ids).toEqual(['15', '15__privacy'])
    expect(h.exported[15]).toEqual(['15', '15__privacy'])
    expect(result.accountCount).toBe(2)
    expect(result.endpointCount).toBe(2)
    expect(result.failures).toEqual([])
  })

  it('no-ops (no posts) when there are no linked accounts', async () => {
    const h = makeHarness({ exposed: [15], accounts: [], endpoints: { 15: [ep('15')] } })
    const engine = new SyncEngine(h.deps)
    const result = await engine.pushDevice(15)
    expect(h.addCalls).toEqual([])
    expect(result.accountCount).toBe(0)
  })

  it('does not post and clears stale ids when buildEndpoints returns []', async () => {
    const h = makeHarness({ exposed: [15], accounts: ['userA'], endpoints: { 15: [] } })
    await h.deps.setExportedEndpoints({ 15: ['15', '15__privacy'] }) // stale
    const engine = new SyncEngine(h.deps)
    const result = await engine.pushDevice(15)
    expect(h.addCalls).toEqual([])
    expect(h.exported[15]).toBeUndefined() // stale ids cleared
    expect(result.deviceCount).toBe(0)
    expect(result.endpointCount).toBe(0)
    expect(result.accountCount).toBe(1)
  })

  it('still records endpoint ids and reports a failure when one account post fails', async () => {
    const h = makeHarness({
      exposed: [15],
      accounts: ['userA'],
      endpoints: { 15: [ep('15')] },
      failAddFor: new Set(['userA:15']),
    })
    const engine = new SyncEngine(h.deps)
    const result = await engine.pushDevice(15)
    expect(result.failures).toEqual(['userA:15'])
    expect(h.exported[15]).toEqual(['15']) // ids recorded so DeleteReport can clean up later
  })
})

describe('SyncEngine.pushAllExposed', () => {
  it('pushes every exposed device to every account and records all endpoint ids', async () => {
    const h = makeHarness({
      exposed: [15, 54],
      accounts: ['userA'],
      endpoints: { 15: [ep('15')], 54: [ep('54'), ep('54__98')] },
    })
    const engine = new SyncEngine(h.deps)
    const result = await engine.pushAllExposed()
    expect(result.deviceCount).toBe(2)
    expect(result.endpointCount).toBe(3)
    expect(h.exported[15]).toEqual(['15'])
    expect(h.exported[54]).toEqual(['54', '54__98'])
  })
})

describe('SyncEngine.pushAllToAccount', () => {
  it('pushes every exposed device to ONE account only', async () => {
    const h = makeHarness({
      exposed: [15, 54],
      accounts: ['userA', 'userB'],
      endpoints: { 15: [ep('15')], 54: [ep('54')] },
    })
    const engine = new SyncEngine(h.deps)
    await engine.pushAllToAccount('userB')
    expect(h.addCalls.every((c) => c.userId === 'userB')).toBe(true)
    expect(h.addCalls.length).toBe(2)
  })

  it('no-ops (no posts, all-zero result) when proactive credentials are missing', async () => {
    const h = makeHarness({
      exposed: [15, 54],
      accounts: ['userA'],
      endpoints: { 15: [ep('15')], 54: [ep('54')] },
      hasCredentials: false,
    })
    const engine = new SyncEngine(h.deps)
    const result = await engine.pushAllToAccount('userA')
    expect(h.addCalls).toEqual([])
    expect(result.deviceCount).toBe(0)
    expect(result.endpointCount).toBe(0)
    expect(result.accountCount).toBe(0)
    expect(result.failures).toEqual([])
  })
})

describe('SyncEngine.removeDevice', () => {
  it('sends DeleteReport for the stored endpoint ids to every account and clears state', async () => {
    const h = makeHarness({ exposed: [], accounts: ['userA', 'userB'] })
    await h.deps.setExportedEndpoints({ 15: ['15', '15__privacy', '15__133'] })
    const engine = new SyncEngine(h.deps)
    const result = await engine.removeDevice(15)
    expect(h.delCalls.map((c) => c.userId).toSorted()).toEqual(['userA', 'userB'])
    expect(h.delCalls[0]!.ids).toEqual(['15', '15__privacy', '15__133'])
    expect(h.exported[15]).toBeUndefined()
    expect(result.endpointCount).toBe(3)
  })

  it('is a no-op when the device was never exported (no DeleteReport, no persist write)', async () => {
    const h = makeHarness({ accounts: ['userA'] })
    const engine = new SyncEngine(h.deps)
    const before = h.setExportedCalls()
    const result = await engine.removeDevice(999)
    expect(h.delCalls).toEqual([])
    expect(result.endpointCount).toBe(0)
    expect(h.setExportedCalls()).toBe(before) // nothing tracked → no persist write
  })

  it('keeps tracking the ids when a DeleteReport failed, so a later Re-sync can retry them', async () => {
    const h = makeHarness({
      exposed: [],
      accounts: ['userA', 'userB'],
      failDeleteFor: new Set(['userB']),
    })
    await h.deps.setExportedEndpoints({ 15: ['15', '15__privacy'] })
    const engine = new SyncEngine(h.deps)
    const result = await engine.removeDevice(15)
    expect(result.failures).toEqual(['userB:15'])
    expect(h.exported[15]).toEqual(['15', '15__privacy'])
  })
})

describe('SyncEngine.resync — the one Re-sync button', () => {
  it('force-pushes every exposed device AND deletes the tracked ids of devices no longer exposed', async () => {
    const h = makeHarness({
      exposed: [5],
      accounts: ['a', 'b'],
      endpoints: { 5: [ep('5'), ep('5__privacy')] },
    })
    await h.deps.setExportedEndpoints({ 5: ['5', '5__privacy'], 9: ['9', '9__98'] })
    await h.deps.setExportedSignatures({ 5: 'same-as-before', 9: 'gone' })
    const engine = new SyncEngine(h.deps)

    const r = await engine.resync()

    // A forced push: sent even though nothing drifted.
    expect(h.addCalls.map((c) => c.userId)).toEqual(['a', 'b'])
    expect(h.delCalls).toEqual([
      { userId: 'a', ids: ['9', '9__98'] },
      { userId: 'b', ids: ['9', '9__98'] },
    ])
    expect(h.exported[9]).toBeUndefined()
    expect(h.signatures[9]).toBeUndefined()
    expect(h.exported[5]).toEqual(['5', '5__privacy'])
    expect(r).toEqual({
      deviceCount: 1,
      endpointCount: 2,
      accountCount: 2,
      removedEndpointCount: 2,
      retainedEndpointCount: 0,
      failedCount: 0,
    })
  })

  it('keeps an unexposed device tracked when any account refused its DeleteReport', async () => {
    const h = makeHarness({ exposed: [], accounts: ['a', 'b'], failDeleteFor: new Set(['b']) })
    await h.deps.setExportedEndpoints({ 9: ['9'] })
    const engine = new SyncEngine(h.deps)
    const r = await engine.resync()
    expect(h.exported[9]).toEqual(['9'])
    expect(r.removedEndpointCount).toBe(0)
    expect(r.retainedEndpointCount).toBe(1)
    expect(r.failedCount).toBe(1)
  })

  it('never deletes what an exposed device did not build this time (a failed read is not a removal)', async () => {
    const h = makeHarness({ exposed: [5], accounts: ['a'], endpoints: { 5: [ep('5')] } })
    await h.deps.setExportedEndpoints({ 5: ['5', '5__98'] })
    const engine = new SyncEngine(h.deps)
    await engine.resync()
    expect(h.delCalls).toEqual([])
  })

  it('deletes nothing and forgets nothing without a linked account with a push grant', async () => {
    const h = makeHarness({ exposed: [], accounts: ['a'], hasCredentials: false })
    await h.deps.setExportedEndpoints({ 9: ['9'] })
    const engine = new SyncEngine(h.deps)
    const r = await engine.resync()
    expect(h.delCalls).toEqual([])
    expect(h.exported[9]).toEqual(['9'])
    expect(r.accountCount).toBe(1)
    expect(r.retainedEndpointCount).toBe(1)
  })
})

describe('SyncEngine — S1 per-account filtering', () => {
  it('sends each account only what its user may see, and nothing to a user who may see none', async () => {
    const h = makeHarness({
      exposed: [5],
      accounts: ['admin', 'viewer', 'stranger'],
      endpoints: { 5: [ep('5'), ep('5__privacy')] },
      visibleFor: { viewer: (id) => id === '5', stranger: () => false },
    })
    const engine = new SyncEngine(h.deps)
    const r = await engine.pushDevice(5)
    expect(h.addCalls).toEqual([
      { userId: 'admin', ids: ['5', '5__privacy'] },
      { userId: 'viewer', ids: ['5'] },
    ])
    expect(r.failures).toEqual([])
  })

  it('reports each accepted push to the initial-connectivity hook with what was sent (D770)', async () => {
    const h = makeHarness({
      exposed: [5],
      accounts: ['viewer'],
      endpoints: { 5: [ep('5'), ep('5__privacy')] },
      visibleFor: { viewer: (id) => id === '5' },
    })
    await new SyncEngine(h.deps).pushDevice(5)
    expect(h.pushedHook).toEqual([{ userId: 'viewer', ids: ['5'] }])
  })

  it('withholds an endpoint that breaks an Amazon rule and still sends its valid siblings (D769)', async () => {
    const broken: AlexaEndpoint = {
      ...ep('5__privacy'),
      capabilities: [
        ...ep('x').capabilities,
        { type: 'AlexaInterface', interface: 'Alexa.BatteryLevelSensor', version: '3' },
      ],
    }
    const h = makeHarness({ exposed: [5], accounts: ['a'], endpoints: { 5: [ep('5'), broken] } })
    await new SyncEngine(h.deps).pushDevice(5)
    expect(h.addCalls).toEqual([{ userId: 'a', ids: ['5'] }])
  })

  it('never sends the unfiltered set to an account whose grants cannot be read', async () => {
    const h = makeHarness({
      exposed: [5],
      accounts: ['viewer'],
      endpoints: { 5: [ep('5')] },
      visibleFor: { viewer: null },
    })
    const r = await new SyncEngine(h.deps).pushDevice(5)
    expect(h.addCalls).toEqual([])
    expect(r.failures).toEqual(['viewer:5'])
  })

  it('removeDeviceFromAccount deletes the recorded ids from that one account only', async () => {
    const h = makeHarness({
      exposed: [5],
      accounts: ['a', 'b'],
      endpoints: { 5: [ep('5'), ep('5__privacy')] },
    })
    const engine = new SyncEngine(h.deps)
    await engine.pushDevice(5)
    await engine.removeDeviceFromAccount('b', 5)
    expect(h.delCalls).toEqual([{ userId: 'b', ids: ['5', '5__privacy'] }])
  })
})

describe('SyncEngine — endpoints a device no longer builds', () => {
  it('a push DELETES the ids the device used to publish and no longer builds', async () => {
    const endpoints: Record<number, AlexaEndpoint[]> = {
      5: [ep('5'), ep('5__det_person'), ep('5__det_vehicle')],
    }
    const h = makeHarness({ exposed: [5], accounts: ['a', 'b'], endpoints })
    const engine = new SyncEngine(h.deps)
    await engine.pushDevice(5)
    endpoints[5] = [ep('5')]
    await engine.pushDevice(5)
    expect(h.delCalls).toEqual([
      { userId: 'a', ids: ['5__det_person', '5__det_vehicle'] },
      { userId: 'b', ids: ['5__det_person', '5__det_vehicle'] },
    ])
  })

  it('never deletes an accessory that one build did not return (a failed read is not a removal)', async () => {
    const endpoints: Record<number, AlexaEndpoint[]> = { 5: [ep('5'), ep('5__98')] }
    const h = makeHarness({ exposed: [5], accounts: ['a'], endpoints })
    const engine = new SyncEngine(h.deps)
    await engine.pushDevice(5)
    endpoints[5] = [ep('5')]
    await engine.pushDevice(5)
    expect(h.delCalls).toEqual([])
  })

  it('an unchanged set deletes nothing', async () => {
    const h = makeHarness({ exposed: [5], accounts: ['a'], endpoints: { 5: [ep('5')] } })
    const engine = new SyncEngine(h.deps)
    await engine.pushDevice(5)
    await engine.pushDevice(5)
    expect(h.delCalls).toEqual([])
  })
})

/**
 * R4 (D779): a camera that declares `Alexa.SmartVision.ObjectDetectionSensor`
 * goes to Alexa in its OWN AddOrUpdateReport. An earlier SmartVision
 * declaration made Alexa reject the camera AND every child sent beside it;
 * isolated, a rejection costs the experiment's endpoint only, and the gateway's
 * answer for it is its own log line.
 */
describe('SmartVision cameras are pushed in their own report', () => {
  function visionCamera(id: string): AlexaEndpoint {
    return {
      ...ep(id),
      capabilities: [
        ...ep(id).capabilities,
        { type: 'AlexaInterface', interface: 'Alexa.EndpointHealth', version: '3.1' },
        {
          type: 'AlexaInterface',
          interface: 'Alexa.SmartVision.ObjectDetectionSensor',
          version: '1.0',
          configuration: { objectDetectionConfiguration: [{ imageNetClass: 'person' }] },
        },
      ],
    }
  }

  it('splits the camera from its children; both still recorded', async () => {
    const h = makeHarness({
      exposed: [1],
      accounts: ['u'],
      endpoints: { 1: [visionCamera('1'), ep('1__2'), ep('1__privacy')] },
    })
    const r = await new SyncEngine(h.deps).pushDevice(1)
    expect(h.addCalls).toEqual([
      { userId: 'u', ids: ['1'] },
      { userId: 'u', ids: ['1__2', '1__privacy'] },
    ])
    expect(r.failures).toEqual([])
    expect(h.exported[1]).toEqual(['1', '1__2', '1__privacy'])
  })

  it('a camera without SmartVision keeps the single report', async () => {
    const h = makeHarness({
      exposed: [1],
      accounts: ['u'],
      endpoints: { 1: [ep('1'), ep('1__2')] },
    })
    await new SyncEngine(h.deps).pushDevice(1)
    expect(h.addCalls).toEqual([{ userId: 'u', ids: ['1', '1__2'] }])
  })
})
