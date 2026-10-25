/**
 * The registry's half of the per-action census (D456).
 *
 * The channel owns the bytes; the registry owns the two things the channel
 * cannot see — WHICH peer a channel belongs to, and whether the parent read
 * a call's args or forwarded them opaquely. `socketFwd=` answers the second
 * question for the whole plane and for no single method, which is precisely
 * the gap this closes: after D448, 85.7 % of sibling calls cross hub-main
 * unread, so the bytes on the line stopped being a proxy for what hub-main
 * PAYS. Per voce: quanto inoltrato, quanto decodificato.
 */
import { describe, expect, it } from 'vitest'
import {
  LocalChildRegistry,
  type LocalChildRegistryOptions,
} from '../../transport/local-child-registry.js'
import type {
  LocalChannel,
  LocalTransportServer,
  RequestHandler,
} from '../../transport/local-transport.js'
import type { CapActionChannelObserver } from '../../transport/cap-action-census.js'

/** A channel that records the observer and replays frames through it. */
class FakeChannel implements LocalChannel {
  handler: RequestHandler = async () => undefined
  observer: CapActionChannelObserver | null = null
  closeHandler: () => void = () => {}
  async request(): Promise<unknown> {
    return undefined
  }
  emit(): void {}
  onRequest(h: RequestHandler): void {
    this.handler = h
  }
  onEvent(): void {}
  onClose(h: () => void): void {
    this.closeHandler = h
  }
  close(): void {}
  observeActions(o: CapActionChannelObserver): void {
    this.observer = o
  }
}

class FakeServer implements LocalTransportServer {
  private handler: ((c: LocalChannel) => void) | null = null
  async listen(): Promise<void> {}
  onConnection(h: (c: LocalChannel) => void): void {
    this.handler = h
  }
  async close(): Promise<void> {}
  connect(channel: LocalChannel): void {
    this.handler?.(channel)
  }
}

async function registryWith(
  extra: Partial<LocalChildRegistryOptions> = {},
): Promise<{ registry: LocalChildRegistry; server: FakeServer }> {
  const server = new FakeServer()
  const registry = new LocalChildRegistry({ server, ...extra })
  await registry.start()
  return { registry, server }
}

const register = async (ch: FakeChannel, childId: string, caps: string[]): Promise<void> => {
  await ch.handler({
    kind: 'register',
    childId,
    caps: caps.map((capName) => ({ capName, mode: 'singleton' as const })),
    rawForward: true,
  })
}

describe('the registry wires the census onto every channel', () => {
  it('charges a served cap call to <peer, cap.method>', async () => {
    const { registry, server } = await registryWith()
    const ch = new FakeChannel()
    server.connect(ch)
    await register(ch, 'analytics', [])

    ch.observer?.record(
      ch.observer.label({ kind: 'cap-call-out', capName: 'ds', method: 'all' }),
      100,
      90_000,
    )

    expect(registry.readActionCensus().get('analytics')?.get('ds.all')).toMatchObject({
      calls: 1,
      reqBytes: 100,
      resBytes: 90_000,
    })
  })

  it('keeps unlabelled bytes under the peer too, so coverage is readable', async () => {
    const { registry, server } = await registryWith()
    const ch = new FakeChannel()
    server.connect(ch)
    await register(ch, 'recorder', [])

    ch.observer?.record(null, 10, 500)

    const peer = registry.readActionCensus().get('recorder')
    expect(peer?.get('(unlabelled)')?.resBytes).toBe(510)
  })
})

describe('per action, how much was forwarded and how much decoded', () => {
  it('charges a raw forward to the CALLER and to that call method', async () => {
    const { registry, server } = await registryWith()
    const caller = new FakeChannel()
    const provider = new FakeChannel()
    server.connect(caller)
    server.connect(provider)
    await register(caller, 'orchestrator', [])
    await register(provider, 'broker', ['audio-chunks'])

    await caller.handler(
      { kind: 'cap-call-out', capName: 'audio-chunks', method: 'push' },
      new Uint8Array([1, 2, 3]),
    )

    expect(registry.readActionCensus().get('orchestrator')?.get('audio-chunks.push')).toMatchObject(
      { raw: 1, decoded: 0 },
    )
  })

  it('charges a parent-routed call as decoded, on the same key', async () => {
    const { registry, server } = await registryWith({
      onUnownedCall: async () => 'served-by-parent',
    })
    const caller = new FakeChannel()
    server.connect(caller)
    await register(caller, 'analytics', [])

    await caller.handler({ kind: 'cap-call-out', capName: 'device-state', method: 'getAll' })

    expect(registry.readActionCensus().get('analytics')?.get('device-state.getAll')).toMatchObject({
      raw: 0,
      decoded: 1,
    })
  })
})

describe('the census and the channel agree on the peer', () => {
  it('forgets a peer whose channel closed, so a respawn does not inherit its bytes', async () => {
    const { registry, server } = await registryWith()
    const ch = new FakeChannel()
    server.connect(ch)
    await register(ch, 'gone', [])
    ch.observer?.record('a.b', 1, 1)
    expect(registry.readActionCensus().has('gone')).toBe(true)

    ch.closeHandler()
    expect(registry.readActionCensus().has('gone')).toBe(false)
  })
})
