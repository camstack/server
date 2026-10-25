import { describe, it, expect, afterEach, vi } from 'vitest'
import { ServiceBroker } from 'moleculer'
import {
  createCoreCapService,
  CORE_CAP_SERVICE_NAME,
  type CoreCapAction,
} from '../../moleculer/core-cap-service.js'
import { brokerTransportLink } from '../../moleculer/trpc-links.js'

/** Drive a single op through `brokerTransportLink` (mirrors trpc-links-discovery.spec). */
function runOp(broker: ServiceBroker, path: string, input: unknown): Promise<unknown> {
  const link = brokerTransportLink(broker)({} as never)
  return new Promise((resolve, reject) => {
    link({
      op: { id: 1, type: 'query', path, input, context: {}, signal: null } as never,
      next: () => {
        throw new Error('brokerTransportLink should be terminal')
      },
    } as never).subscribe({
      next: (env: unknown) => resolve((env as { result: { data: unknown } }).result.data),
      error: (err: unknown) => reject(err as Error),
      complete: () => {
        /* resolved via next */
      },
    })
  })
}

describe('createCoreCapService', () => {
  let broker: ServiceBroker

  afterEach(async () => {
    if (broker) await broker.stop()
  })

  it('creates a Moleculer service schema with one action per core-cap action', () => {
    const actions: CoreCapAction[] = [
      { actionName: 'system.info', invoke: vi.fn() },
      { actionName: 'addon-settings-raw.getGlobal', invoke: vi.fn() },
    ]
    const schema = createCoreCapService({ actions })

    expect(schema.name).toBe(CORE_CAP_SERVICE_NAME)
    expect(schema.actions?.['system.info']).toBeDefined()
    expect(schema.actions?.['addon-settings-raw.getGlobal']).toBeDefined()
  })

  it('honours a custom service name', () => {
    const schema = createCoreCapService({ serviceName: '$custom', actions: [] })
    expect(schema.name).toBe('$custom')
  })

  it('routes an action call to its invoke handler and returns the result', async () => {
    const invoke = vi.fn().mockResolvedValue({ version: '1.2.3' })
    broker = new ServiceBroker({ nodeID: 'test', transporter: 'Fake', logger: false })
    broker.createService(createCoreCapService({ actions: [{ actionName: 'system.info', invoke }] }))
    await broker.start()

    const result = await broker.call(`${CORE_CAP_SERVICE_NAME}.system.info`, { nodeId: 'hub' })

    // The second argument is the call's ORIGIN — diagnostics only, read by the
    // transport census to name the caller of an in-process call. Asserted
    // explicitly rather than with `expect.anything()`: an origin that arrived
    // blank would make every mesh row read `mesh:unknown` and nobody would
    // notice, because a blank principal looks exactly like a quiet plane.
    expect(invoke).toHaveBeenCalledWith({ nodeId: 'hub' }, { nodeId: 'test', caller: null })
    expect(result).toEqual({ version: '1.2.3' })
  })

  it('normalizes an empty params object to undefined for void-input procedures', async () => {
    const invoke = vi.fn().mockResolvedValue('ok')
    broker = new ServiceBroker({ nodeID: 'test', transporter: 'Fake', logger: false })
    broker.createService(
      createCoreCapService({ actions: [{ actionName: 'capabilities.listProviders', invoke }] }),
    )
    await broker.start()

    await broker.call(`${CORE_CAP_SERVICE_NAME}.capabilities.listProviders`)

    expect(invoke).toHaveBeenCalledWith(undefined, { nodeId: 'test', caller: null })
  })

  it('propagates errors thrown by the invoke handler', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('boom'))
    broker = new ServiceBroker({ nodeID: 'test', transporter: 'Fake', logger: false })
    broker.createService(createCoreCapService({ actions: [{ actionName: 'system.info', invoke }] }))
    await broker.start()

    await expect(broker.call(`${CORE_CAP_SERVICE_NAME}.system.info`)).rejects.toThrow('boom')
  })
})

/**
 * End-to-end #56 coverage: a forked worker calling `ctx.api.system.info`
 * resolves through `brokerTransportLink` → the hub's `$core-caps`
 * service. Before the bridge existed, this hung forever in
 * `awaitServiceCandidates` because no Moleculer service exposed the
 * hub's core (non-addon) routers.
 */
describe('core-cap bridge — cross-node resolution via brokerTransportLink', () => {
  const brokers: ServiceBroker[] = []

  afterEach(async () => {
    for (const b of brokers.splice(0)) {
      try {
        await b.stop()
      } catch {
        /* ignore */
      }
    }
  })

  async function makeBroker(nodeID: string): Promise<ServiceBroker> {
    const b = new ServiceBroker({ nodeID, transporter: 'Fake', logger: false })
    await b.start()
    brokers.push(b)
    return b
  }

  it('resolves a hub core cap from a worker node', async () => {
    const hub = await makeBroker('hub')
    hub.createService(
      createCoreCapService({
        actions: [
          { actionName: 'system.info', invoke: () => Promise.resolve({ version: '9.9.9' }) },
        ],
      }),
    )
    const worker = await makeBroker('hub/worker-group')

    // `ctx.api.system.info.query()` → op.path 'system.info'.
    const result = await runOp(worker, 'system.info', undefined)
    expect(result).toEqual({ version: '9.9.9' })
  })

  it('resolves a kebab-cased core cap (addonSettingsRaw → addon-settings-raw)', async () => {
    const hub = await makeBroker('hub')
    hub.createService(
      createCoreCapService({
        actions: [
          { actionName: 'addon-settings-raw.getGlobal', invoke: (input) => Promise.resolve(input) },
        ],
      }),
    )
    const worker = await makeBroker('hub/worker-group')

    // `ctx.api.addonSettingsRaw.getGlobal.query({ addonId })` → op.path
    // 'addonSettingsRaw.getGlobal' → kebab capName 'addon-settings-raw'.
    const result = await runOp(worker, 'addonSettingsRaw.getGlobal', { addonId: 'demo' })
    expect(result).toEqual({ addonId: 'demo' })
  })
})
