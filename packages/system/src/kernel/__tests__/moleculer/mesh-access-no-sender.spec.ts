/**
 * The mesh access middleware never takes a call or event with NO sender for an in-process one
 * (D857). An in-process call carries the broker's own node id; a null sender means a packet
 * arrived over transit with it stripped, and it is refused before it reaches the action.
 */
import { Context, ServiceBroker } from 'moleculer'
import { afterEach, describe, expect, it } from 'vitest'
import { createMeshAccessMiddleware } from '../../moleculer/mesh-access-middleware.js'
import { MESH_NODE_UNAUTHENTICATED_TYPE, MeshIdentityGate } from '../../moleculer/mesh-identity.js'

const brokers: ServiceBroker[] = []
afterEach(async () => {
  for (const b of brokers.splice(0)) await b.stop()
})

async function rig() {
  const ran: string[] = []
  const broker = new ServiceBroker({
    nodeID: 'hub',
    logger: false,
    middlewares: [
      createMeshAccessMiddleware({
        ownNodeId: 'hub',
        gate: new MeshIdentityGate({ ownNodeId: 'hub', isVerifiedPeer: (id) => id === 'agent-1' }),
      }),
    ],
  })
  brokers.push(broker)
  broker.createService({
    name: '$process',
    actions: {
      spawnRunner() {
        ran.push('spawnRunner')
        return true
      },
    },
  })
  broker.createService({
    name: 'sink',
    events: {
      'camstack.evt.**'() {
        ran.push('event')
      },
    },
  })
  await broker.start()
  return { broker, ran }
}

function actionHandler(broker: ServiceBroker, name: string) {
  const endpoint = broker.registry.getActionEndpoints(name)?.endpoints[0]
  if (endpoint === undefined) throw new Error(`no endpoint for ${name}`)
  return { endpoint, handler: endpoint.action.handler }
}

describe('a call with no sender is not an in-process call', () => {
  it('runs a genuinely local call (the broker is the sender)', async () => {
    const { broker, ran } = await rig()
    await broker.call('$process.spawnRunner')
    expect(ran).toEqual(['spawnRunner'])
  })

  it.each([undefined, null, '', 7])('refuses a transit call whose sender is %s', async (sender) => {
    const { broker, ran } = await rig()
    const { endpoint, handler } = actionHandler(broker, '$process.spawnRunner')
    if (handler === undefined) throw new Error('no handler')
    const ctx = new Context(broker, endpoint)
    Reflect.set(ctx, 'nodeID', sender)
    let thrown: unknown = null
    try {
      await Reflect.apply(handler, undefined, [ctx])
    } catch (err) {
      thrown = err
    }
    expect(Reflect.get(thrown ?? {}, 'type')).toBe(MESH_NODE_UNAUTHENTICATED_TYPE)
    expect(ran).toEqual([])
  })

  it('drops a transit event whose sender is missing', async () => {
    const { broker, ran } = await rig()
    const endpoint = broker.registry.events.getAllEndpoints('camstack.evt.x')[0]
    if (endpoint === undefined) throw new Error('no event endpoint')
    const ctx = new Context(broker, endpoint)
    Reflect.set(ctx, 'nodeID', undefined)
    const eventHandler = endpoint.event.handler
    if (eventHandler === undefined) throw new Error('no event handler')
    await Promise.resolve(Reflect.apply(eventHandler, undefined, [ctx]))
    expect(ran).toEqual([])
  })
})
