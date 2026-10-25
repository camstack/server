/**
 * The mesh gate's EVENT hook must hand Moleculer a promise on every path.
 * Moleculer's error-handler middleware wraps the hook's result with
 * `.catch(...)`; a hook that returned `undefined` for a refused event made
 * that wrap throw `Cannot read properties of undefined (reading 'catch')` once
 * per dropped event (~8,700 lines/min on an agent whose neighbour node was
 * has no certificate).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context, ServiceBroker } from 'moleculer'
import { createMeshAccessMiddleware } from '../../moleculer/mesh-access-middleware.js'
import type { MeshCallVerdict } from '../../moleculer/mesh-identity.js'

const brokers: ServiceBroker[] = []
afterEach(async () => {
  for (const b of brokers.splice(0)) await b.stop()
})

interface Rig {
  readonly broker: ServiceBroker
  readonly seen: string[]
  readonly warnings: string[]
  emitFrom(sender: string, tag: string): Promise<unknown>
}

async function rig(
  verdict: MeshCallVerdict,
  handler: (tag: string) => void | Promise<void> = () => undefined,
): Promise<Rig> {
  const seen: string[] = []
  const warnings: string[] = []
  const broker = new ServiceBroker({
    nodeID: 'agent-a',
    logger: false,
    middlewares: [
      createMeshAccessMiddleware({
        ownNodeId: 'agent-a',
        gate: { admitCall: () => verdict, admitEvent: () => verdict },
        logger: { warn: (m) => warnings.push(m) },
      }),
    ],
  })
  brokers.push(broker)
  broker.createService({
    name: 'sink',
    events: {
      'camstack.evt.**': {
        handler(ctx: Context<{ tag: string }>) {
          seen.push(ctx.params.tag)
          return handler(ctx.params.tag)
        },
      },
    },
  })
  await broker.start()
  const emitFrom = (sender: string, tag: string) => {
    const ctx = new Context<{ tag: string }>(broker)
    ctx.params = { tag }
    ctx.nodeID = sender
    ctx.eventName = 'camstack.evt.pipeline.trace'
    ctx.eventType = 'broadcast'
    return broker.emitLocalServices(ctx)
  }
  return { broker, seen, warnings, emitFrom }
}

describe('mesh access middleware — localEvent', () => {
  it('a refused event does not throw and is not delivered', async () => {
    const r = await rig({ verdict: 'deny', errorType: 'X', message: 'no' })
    await expect(r.emitFrom('mac', 'dropped')).resolves.toBeDefined()
    expect(r.seen).toEqual([])
  })

  it('a refused event is reported (rate-limited), never silent', async () => {
    const r = await rig({ verdict: 'deny', errorType: 'X', message: 'no' })
    await r.emitFrom('mac', 'a')
    await r.emitFrom('mac', 'b')
    expect(r.warnings).toHaveLength(1)
  })

  it('an admitted event is delivered, also when the handler returns synchronously', async () => {
    const r = await rig({ verdict: 'allow' })
    await r.emitFrom('mac', 'ok')
    expect(r.seen).toEqual(['ok'])
  })

  it('a rejecting handler still surfaces its error', async () => {
    const r = await rig({ verdict: 'allow' }, () => Promise.reject(new Error('boom')))
    await expect(r.emitFrom('mac', 'x')).rejects.toThrow('boom')
  })
})
