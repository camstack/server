/**
 * A forked runner has no Moleculer broker (Phase F), so `$node.connected` never
 * fires for it and `agent-registry.service.ts` never emitted `WorkerOnline` /
 * `WorkerOffline` for one: every consumer of those events was dead for every
 * forked runner (fix round 1, review C1). The UDS child registry is what sees a
 * runner come and go, so it says so — on the kernel bus it is handed, with the
 * enum, keyed `<parent>/<childId>` exactly as the Moleculer path keyed it.
 *
 * `WorkerOnline` fires at a new incarnation's FIRST register: the pre-init frame
 * `LocalChildClient.start()` sends before any addon module is loaded, so before
 * `initialize()` and before any device restore (review H1). The parent emits it
 * synchronously, then yields one event-loop turn, before it acks that frame —
 * so a UDS consumer already holding the frame can close its gate first.
 */
import { EventCategory, type SystemEvent } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildClient } from '../../transport/local-child-client.js'
import {
  afterWorkerOnlineAnnounce,
  LocalChildRegistry,
} from '../../transport/local-child-registry.js'

const nid = () => `hub-test-${process.pid}-${Math.random().toString(36).slice(2)}`

interface Seen {
  readonly category: string
  readonly workerId: unknown
  /** Was the child's `start()` already resolved (its register acked) when this was emitted? */
  readonly afterAck: boolean
}

function workerIdOf(event: SystemEvent): unknown {
  const data = event.data
  return typeof data === 'object' && data !== null ? Reflect.get(data, 'workerId') : null
}

function child(nodeId: string, childId = 'provider-hikvision'): LocalChildClient {
  return new LocalChildClient({ nodeId, childId, caps: [], dispatch: async () => 'ok' })
}

describe('LocalChildRegistry — runner lifecycle on the kernel bus (WorkerOnline / WorkerOffline)', () => {
  const open: LocalChildClient[] = []
  let registry: LocalChildRegistry | null = null
  afterEach(async () => {
    for (const c of open.splice(0)) await c.close()
    await registry?.close()
    registry = null
  })

  it('the FIRST register of a runner is WorkerOnline <parent>/<childId>, emitted before the parent acks it', async () => {
    const nodeId = nid()
    const seen: Seen[] = []
    let ackedYet = false
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      lifecycleEvents: {
        parentNodeId: () => 'hub',
        emit: (event) => {
          seen.push({ category: event.category, workerId: workerIdOf(event), afterAck: ackedYet })
        },
      },
    })
    await registry.start()
    const c = child(nodeId)
    open.push(c)
    await c.start()
    ackedYet = true
    expect(seen).toEqual([
      { category: EventCategory.WorkerOnline, workerId: 'hub/provider-hikvision', afterAck: false },
    ])
    // The post-init re-register (same incarnation) says nothing more.
    await c.updateCaps([])
    expect(seen).toHaveLength(1)
  })

  it('WorkerOnline is emitted, then one event-loop turn elapses, before the register ack returns', async () => {
    const nodeId = nid()
    let yieldedBeforeAck = false
    let acked = false
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      lifecycleEvents: {
        parentNodeId: () => 'hub',
        emit: () => undefined,
        // The production default is {@link afterWorkerOnlineAnnounce}; this seam
        // proves the register handler awaits it before acking (disarm: drop the await).
        afterOnlineAnnounce: async () => {
          expect(acked).toBe(false)
          yieldedBeforeAck = true
        },
      },
    })
    await registry.start()
    const c = child(nodeId)
    open.push(c)
    await c.start()
    acked = true
    expect(yieldedBeforeAck).toBe(true)
  })

  it('afterWorkerOnlineAnnounce yields one setImmediate turn (the production default)', async () => {
    let ran = false
    setImmediate(() => {
      ran = true
    })
    expect(ran).toBe(false)
    await afterWorkerOnlineAnnounce()
    expect(ran).toBe(true)
  })

  it('the live connection closing is WorkerOffline; a new incarnation of the same runner is WorkerOnline again', async () => {
    const nodeId = nid()
    const events: SystemEvent[] = []
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      lifecycleEvents: { parentNodeId: () => 'hub', emit: (e) => events.push(e) },
    })
    await registry.start()
    const first = child(nodeId)
    await first.start()
    await first.close()
    await waitFor(() => events.length >= 2)
    const second = child(nodeId)
    open.push(second)
    await second.start()
    expect(events.map((e) => [e.category, workerIdOf(e)])).toEqual([
      [EventCategory.WorkerOnline, 'hub/provider-hikvision'],
      [EventCategory.WorkerOffline, 'hub/provider-hikvision'],
      [EventCategory.WorkerOnline, 'hub/provider-hikvision'],
    ])
    expect(events[0]?.source).toEqual({ type: 'core', id: 'local-child-registry' })
  })

  it('a successor that connects before its predecessor`s close is WorkerOnline; the superseded close is no WorkerOffline', async () => {
    const nodeId = nid()
    const events: SystemEvent[] = []
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      lifecycleEvents: { parentNodeId: () => 'hub', emit: (e) => events.push(e) },
    })
    await registry.start()
    const old = child(nodeId)
    await old.start()
    const successor = child(nodeId)
    open.push(successor)
    await successor.start()
    await old.close()
    await new Promise((r) => setTimeout(r, 30))
    expect(events.map((e) => e.category)).toEqual([
      EventCategory.WorkerOnline,
      EventCategory.WorkerOnline,
    ])
  })
})

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 5))
}
