/**
 * `LocalChildRegistry`'s cap index — what invalidates it, and that it is
 * actually cached (D457).
 *
 * The index is the win the profile named: `resolveChildId` was 7.1 % of
 * hub-main's busy main thread, a linear scan of 39 children × their cap
 * manifests on every `cap-call-out` (D456). The reason it did not exist is
 * that the thing it indexes CHANGES — a runner is replaced on every update, a
 * crash respawns one, a child re-registers with a different manifest after
 * init — and **an index that names a dead child is worse than a slow scan**.
 *
 * So the whole design is invalidation, and this file is that design's guard:
 * every mutation of the `children` map drops the index, and nothing else may
 * build one. Each case below is a mutation that really happens on this hub.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCapChildIndex } from '../../transport/cap-child-index.js'
import type { CapCallMessage, ChildCapDescriptor } from '../../transport/child-cap-protocol.js'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'
import type { LocalChannel, LocalTransportClient } from '../../transport/local-transport.js'

vi.mock('../../transport/cap-child-index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../transport/cap-child-index.js')>()
  return { ...actual, buildCapChildIndex: vi.fn(actual.buildCapChildIndex) }
})

const buildSpy = vi.mocked(buildCapChildIndex)

const nid = (): string => `hub-capidx-${process.pid}-${Math.random().toString(36).slice(2)}`

interface FakeChild {
  readonly client: LocalTransportClient
  readonly channel: LocalChannel
}

async function connectChild(nodeId: string): Promise<FakeChild> {
  const client = createLocalTransport().createClient(nodeId)
  const channel = await client.connect()
  channel.onRequest(async (body) => {
    const msg = body as CapCallMessage // wire-boundary: trusted local UDS channel
    if (msg.kind === 'cap-call') return { served: msg.method }
    throw new Error(`unexpected request kind ${(msg as { kind: string }).kind}`)
  })
  return { client, channel }
}

async function register(
  child: FakeChild,
  childId: string,
  caps: readonly ChildCapDescriptor[],
): Promise<void> {
  await child.channel.request({ kind: 'register', childId, caps })
}

const singleton = (capName: string): ChildCapDescriptor => ({ capName, mode: 'singleton' })
const forDevice = (capName: string, deviceId: number): ChildCapDescriptor => ({
  capName,
  mode: 'collection',
  deviceId,
})

/** Wait for the parent to observe a socket close — `onClose` is not synchronous. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise((r) => setImmediate(r))
}

describe('LocalChildRegistry cap index — invalidation', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalTransportClient[] = []

  afterEach(async () => {
    for (const c of clients) await c.close()
    clients.length = 0
    await registry?.close()
    registry = null
    buildSpy.mockClear()
  })

  async function startRegistry(): Promise<string> {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()
    return nodeId
  }

  it('sees a child that registered AFTER an earlier resolution', async () => {
    const nodeId = await startRegistry()
    const first = await connectChild(nodeId)
    clients.push(first.client)
    await register(first, 'child-a', [singleton('ptz')])

    // Resolve once — this is what builds an index that must not outlive the
    // next register.
    expect(registry!.resolveChildId('snapshot')).toBeNull()

    const second = await connectChild(nodeId)
    clients.push(second.client)
    await register(second, 'child-b', [singleton('snapshot')])

    expect(registry!.resolveChildId('snapshot')).toBe('child-b')
  })

  it('reflects a re-register that REPLACES the same child’s manifest', async () => {
    const nodeId = await startRegistry()
    const child = await connectChild(nodeId)
    clients.push(child.client)

    // The pre-init register: a bare manifest, which the post-init one replaces
    // wholesale on the same connection.
    await register(child, 'pipeline', [singleton('pipeline-runner')])
    expect(registry!.resolveChildId('pipeline-runner')).toBe('pipeline')
    expect(registry!.resolveChildId('snapshot', 7)).toBeNull()

    await register(child, 'pipeline', [singleton('pipeline-runner'), forDevice('snapshot', 7)])

    expect(registry!.resolveChildId('snapshot', 7)).toBe('pipeline')
  })

  it('stops naming a child once its socket closes', async () => {
    const nodeId = await startRegistry()
    const child = await connectChild(nodeId)
    await register(child, 'recording', [singleton('recording')])
    expect(registry!.resolveChildId('recording')).toBe('recording')

    await child.client.close()
    await settle()

    // The index must not outlive the child. This is the failure mode the scan
    // could not have: routing a call to a runner that is gone.
    expect(registry!.resolveChildId('recording')).toBeNull()
  })

  it('keeps naming the LIVE child when a superseded connection closes (D188)', async () => {
    const nodeId = await startRegistry()
    const predecessor = await connectChild(nodeId)
    await register(predecessor, 'recording', [singleton('recording')])

    // An update: the successor connects under the SAME childId before the
    // predecessor's close is observed.
    const successor = await connectChild(nodeId)
    clients.push(successor.client)
    await register(successor, 'recording', [singleton('recording'), singleton('recording-export')])

    await predecessor.client.close()
    await settle()

    // The predecessor's close is ignored, so the index must still carry the
    // successor's manifest — including the cap only the successor declared.
    expect(registry!.resolveChildId('recording')).toBe('recording')
    expect(registry!.resolveChildId('recording-export')).toBe('recording')
  })
})

describe('LocalChildRegistry cap index — it is cached, not rebuilt per call', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalTransportClient[] = []

  afterEach(async () => {
    for (const c of clients) await c.close()
    clients.length = 0
    await registry?.close()
    registry = null
    buildSpy.mockClear()
  })

  it('builds the index ONCE across many resolutions with no mutation between', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const child = await connectChild(nodeId)
    clients.push(child.client)
    await register(child, 'provider', [
      singleton('vendor'),
      forDevice('ptz', 1),
      forDevice('ptz', 2),
    ])

    buildSpy.mockClear()
    for (let i = 0; i < 200; i += 1) {
      expect(registry.resolveChildId('vendor')).toBe('provider')
      expect(registry.resolveChildId('ptz', 1)).toBe('provider')
      expect(registry.resolveChildId('ptz', 99)).toBeNull()
    }

    // A linear scan calls this zero times; a per-call rebuild calls it 600.
    // Either is red, and both are the defect.
    expect(buildSpy).toHaveBeenCalledTimes(1)
  })

  it('resolves a DECODED sibling call once, not twice', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const provider = await connectChild(nodeId)
    clients.push(provider.client)
    await register(provider, 'prov', [singleton('ptz')])

    // A legacy caller: inline args, no raw-forward, so the parent takes the
    // DECODED branch — the one that used to resolve the target and then hand
    // the call to `callCap`, which resolved it all over again.
    const legacy = createLocalTransport().createClient(nodeId)
    const channel = await legacy.connect()
    clients.push(legacy)
    await channel.request({ kind: 'register', childId: 'old-caller', caps: [] })

    const resolve = vi.spyOn(registry, 'resolveChildId')
    await expect(
      channel.request({ kind: 'cap-call-out', capName: 'ptz', method: 'move', args: { pan: 1 } }),
    ).resolves.toEqual({ served: 'move' })

    expect(resolve).toHaveBeenCalledTimes(1)
  })
})
