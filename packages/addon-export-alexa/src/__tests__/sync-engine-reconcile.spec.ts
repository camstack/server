/**
 * `SyncEngine.reconcileDevice` — the repair for the failure that ate a real
 * doorbell press on 2026-08-07.
 *
 * Camera 101 was exposed to Alexa BEFORE its `doorbell` cap was bound (then
 * by a wrapper; today a composed doorbell, D671, gains the cap the same way).
 * Every push trigger the engine had (expose, unexpose, account link, manual
 * button) had already fired, so Alexa's cloud copy of endpoint
 * 101 kept the capability list from before the binding: no
 * `Alexa.DoorbellEventSource`, `displayCategories: ['CAMERA']`. The press
 * reached the Event Gateway, the gateway answered 2xx, and the cloud dropped
 * it because the endpoint does not declare the interface. The log said
 * "doorbell press posted" and the Echo said nothing.
 *
 * The reconcile compares the endpoint set we WOULD build now against the
 * signature we last pushed, and re-pushes when they disagree. It is safe to
 * run on every bindings-change and at boot precisely because an unchanged
 * shape costs zero gateway calls.
 */
import { describe, it, expect } from 'vitest'
import { SyncEngine, type SyncEngineDeps } from '../sync-engine.js'
import { endpointsSignature } from '../endpoint-signature.js'
import type { AlexaCapability, AlexaEndpoint } from '../endpoints/types.js'

const BASE: AlexaCapability = { type: 'AlexaInterface', interface: 'Alexa', version: '3' }
const DOORBELL: AlexaCapability = {
  type: 'AlexaInterface',
  interface: 'Alexa.DoorbellEventSource',
  version: '3',
  proactivelyReported: true,
}

function ep(id: string, capabilities: readonly AlexaCapability[] = [BASE]): AlexaEndpoint {
  return {
    endpointId: id,
    friendlyName: id,
    description: 'd',
    manufacturerName: 'camstack',
    displayCategories: capabilities.includes(DOORBELL) ? ['CAMERA', 'DOORBELL'] : ['CAMERA'],
    capabilities,
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
  readonly exposed?: readonly number[]
  readonly accounts?: readonly string[]
  readonly endpoints?: Readonly<Record<number, readonly AlexaEndpoint[]>>
  readonly hasCredentials?: boolean
}

function makeHarness(opts: HarnessOpts = {}) {
  const exported: Record<number, readonly string[]> = {}
  const signatures: Record<number, string> = {}
  const addCalls: Array<{ userId: string; ids: string[] }> = []
  let buildCalls = 0
  const pushedHook: Array<{ userId: string; ids: string[] }> = []
  const deps: SyncEngineDeps = {
    logger: noopLogger,
    listExposed: () => (opts.exposed ?? []).map((deviceId) => ({ deviceId, exposedAt: 0 })),
    listLinkedAccounts: () =>
      (opts.accounts ?? []).map((userId) => ({ userId, username: userId, linkedAt: 0 })),
    hasProactiveCredentials: () => opts.hasCredentials ?? true,
    buildEndpoints: async (deviceId) => {
      buildCalls += 1
      return opts.endpoints?.[deviceId] ?? []
    },
    mayRetire: (id) => id.includes('__det_'),
    afterPush: (userId, endpoints) => {
      pushedHook.push({ userId, ids: endpoints.map((e) => e.endpointId) })
    },
    filterForAccount: async (_userId, endpoints) => endpoints,
    postAddOrUpdate: async (userId, endpoints) => {
      addCalls.push({ userId, ids: endpoints.map((e) => e.endpointId) })
      return true
    },
    postDelete: async () => true,
    getExportedEndpoints: () => exported,
    setExportedEndpoints: async (next) => {
      for (const k of Object.keys(exported)) delete exported[Number(k)]
      Object.assign(exported, next)
    },
    getExportedSignatures: () => signatures,
    setExportedSignatures: async (next) => {
      for (const k of Object.keys(signatures)) delete signatures[Number(k)]
      Object.assign(signatures, next)
    },
  }
  return { deps, exported, signatures, addCalls, buildCalls: () => buildCalls }
}

describe('SyncEngine.reconcileDevice', () => {
  it('RE-PUSHES a device whose endpoint gained Alexa.DoorbellEventSource — the live 101 case', async () => {
    const h = makeHarness({
      exposed: [101],
      accounts: ['userA'],
      endpoints: { 101: [ep('101', [BASE, DOORBELL])] },
    })
    // Alexa's copy is the pre-binding shape.
    await h.deps.setExportedSignatures({ 101: endpointsSignature([ep('101', [BASE])]) })

    const result = await new SyncEngine(h.deps).reconcileDevice(101)

    expect(result.pushed).toBe(true)
    expect(h.addCalls.length).toBe(1)
    expect(h.signatures[101]).toBe(endpointsSignature([ep('101', [BASE, DOORBELL])]))
  })

  it('does NOT push when the shape is unchanged — an unchanged reconcile costs no gateway call', async () => {
    const h = makeHarness({
      exposed: [101],
      accounts: ['userA'],
      endpoints: { 101: [ep('101', [BASE, DOORBELL])] },
    })
    await h.deps.setExportedSignatures({
      101: endpointsSignature([ep('101', [BASE, DOORBELL])]),
    })

    const result = await new SyncEngine(h.deps).reconcileDevice(101)

    expect(result.pushed).toBe(false)
    expect(h.addCalls).toEqual([])
  })

  it('pushes a device that has NO recorded signature yet (first reconcile after the upgrade)', async () => {
    const h = makeHarness({
      exposed: [101],
      accounts: ['userA'],
      endpoints: { 101: [ep('101', [BASE, DOORBELL])] },
    })
    const result = await new SyncEngine(h.deps).reconcileDevice(101)
    expect(result.pushed).toBe(true)
    expect(h.addCalls.length).toBe(1)
  })

  it('never pushes an EMPTY endpoint set, and never destroys a recorded signature on one', async () => {
    // A transient registry miss builds zero endpoints. Posting that is an
    // Alexa protocol error, and forgetting the signature would make the NEXT
    // reconcile re-push a shape Alexa already has.
    const h = makeHarness({ exposed: [101], accounts: ['userA'], endpoints: { 101: [] } })
    const known = endpointsSignature([ep('101', [BASE, DOORBELL])])
    await h.deps.setExportedSignatures({ 101: known })

    const result = await new SyncEngine(h.deps).reconcileDevice(101)

    expect(result.pushed).toBe(false)
    expect(h.addCalls).toEqual([])
    expect(h.signatures[101]).toBe(known)
  })

  it('no-ops without linked accounts or credentials — and does not build', async () => {
    const h = makeHarness({
      exposed: [101],
      accounts: [],
      endpoints: { 101: [ep('101', [BASE, DOORBELL])] },
    })
    const result = await new SyncEngine(h.deps).reconcileDevice(101)
    expect(result.pushed).toBe(false)
    expect(h.buildCalls()).toBe(0)
  })

  it('is a no-op for a device that is not exposed', async () => {
    const h = makeHarness({
      exposed: [587],
      accounts: ['userA'],
      endpoints: { 101: [ep('101', [BASE, DOORBELL])] },
    })
    const result = await new SyncEngine(h.deps).reconcileDevice(101)
    expect(result.pushed).toBe(false)
    expect(h.addCalls).toEqual([])
  })
})

describe('SyncEngine.reconcileAllExposed', () => {
  it('re-pushes only the devices whose shape drifted', async () => {
    const h = makeHarness({
      exposed: [101, 587],
      accounts: ['userA'],
      endpoints: {
        101: [ep('101', [BASE, DOORBELL])],
        587: [ep('587', [BASE])],
      },
    })
    await h.deps.setExportedSignatures({
      101: endpointsSignature([ep('101', [BASE])]), // drifted
      587: endpointsSignature([ep('587', [BASE])]), // current
    })

    const result = await new SyncEngine(h.deps).reconcileAllExposed()

    expect(result.pushedDeviceIds).toEqual([101])
    expect(h.addCalls.length).toBe(1)
    expect(h.addCalls[0]!.ids).toEqual(['101'])
  })
})

describe('SyncEngine push operations record the signature', () => {
  it('pushDevice records the signature so the next reconcile is a no-op', async () => {
    const h = makeHarness({
      exposed: [101],
      accounts: ['userA'],
      endpoints: { 101: [ep('101', [BASE, DOORBELL])] },
    })
    const engine = new SyncEngine(h.deps)
    await engine.pushDevice(101)
    expect(h.signatures[101]).toBe(endpointsSignature([ep('101', [BASE, DOORBELL])]))

    const again = await engine.reconcileDevice(101)
    expect(again.pushed).toBe(false)
  })

  it('removeDevice drops the signature along with the endpoint ids', async () => {
    const h = makeHarness({ exposed: [], accounts: ['userA'] })
    await h.deps.setExportedEndpoints({ 101: ['101'] })
    await h.deps.setExportedSignatures({ 101: 'whatever' })
    await new SyncEngine(h.deps).removeDevice(101)
    expect(h.signatures[101]).toBeUndefined()
  })
})
