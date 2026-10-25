/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/consistent-type-assertions */
/**
 * Tests that `BaseAddon.initialize()` auto-emits `system.ready-state`
 * `ready` for every provider it registers, and matching `down` events
 * on `shutdown()`. The opt-out toggle via `autoEmitReadiness=false` is
 * also exercised.
 *
 * This is the seam that lets any addon — from any package — participate
 * in the readiness protocol without knowing the event category exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BaseAddon } from '../../addon/base-addon.js'
import type { CapabilityDefinition } from '../../capabilities/capability-definition.js'
import type { AddonContext, ProviderRegistration } from '../../interfaces/addon.js'
import type {
  IEventBus,
  SystemEvent,
  EventFilter,
  KnownEventCategory,
  TypedEventFilter,
  TypedSystemEvent,
} from '../../interfaces/event-bus.js'
import type { IScopedLogger } from '../../interfaces/logging.js'
import { ReadinessRegistry } from '../../readiness/readiness-registry.js'

// ── Test bus — synchronous, same as in readiness-registry.spec.ts ────

class TestEventBus implements IEventBus {
  private subs: Array<{ filter: EventFilter; handler: (event: SystemEvent) => void }> = []
  emitted: SystemEvent[] = []
  emit(event: SystemEvent): void {
    this.emitted.push(event)
    for (const s of this.subs) {
      if (!matchesFilter(event, s.filter)) continue
      s.handler(event)
    }
  }
  subscribe<C extends KnownEventCategory>(
    filter: TypedEventFilter<C>,
    handler: (event: TypedSystemEvent<C>) => void,
  ): () => void
  subscribe(filter: EventFilter, handler: (event: SystemEvent) => void): () => void
  subscribe(filter: EventFilter, handler: (event: SystemEvent) => void): () => void {
    const entry = { filter, handler }
    this.subs.push(entry)
    return () => {
      this.subs = this.subs.filter((s) => s !== entry)
    }
  }
  getRecent(): readonly SystemEvent[] {
    return this.emitted
  }
}
function matchesFilter(event: SystemEvent, filter: EventFilter): boolean {
  if (!filter.category) return true
  const cats = Array.isArray(filter.category) ? filter.category : [filter.category]
  return cats.some((c) => c === event.category)
}

// ── Fake capability + provider + context ─────────────────────────────

const fakeCap: CapabilityDefinition = {
  name: 'fake-cap',
  scope: 'node',
  mode: 'singleton',
  methods: {},
} as unknown as CapabilityDefinition

const otherCap: CapabilityDefinition = {
  name: 'other-cap',
  scope: 'node',
  mode: 'singleton',
  methods: {},
} as unknown as CapabilityDefinition

function makeLogger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

function makeContext(bus: IEventBus, overrides: Partial<AddonContext> = {}): AddonContext {
  return {
    id: 'test-addon',
    logger: makeLogger(),
    eventBus: bus,
    addonConfig: {},
    dataDir: '/tmp/fake',
    kernel: { localNodeId: 'hub' } as AddonContext['kernel'],
    ...overrides,
  } as AddonContext
}

// ── Addon fixtures ───────────────────────────────────────────────────

class OneProviderAddon extends BaseAddon {
  constructor(private readonly provider: object) {
    super({})
  }
  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    return [{ capability: fakeCap, provider: this.provider }]
  }
}

class MultiProviderAddon extends BaseAddon {
  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    return [
      { capability: fakeCap, provider: {} },
      { capability: otherCap, provider: {} },
    ]
  }
}

class OptOutAddon extends BaseAddon {
  protected override get autoEmitReadiness(): boolean {
    return false
  }
  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    return [{ capability: fakeCap, provider: {} }]
  }
}

class NoProviderAddon extends BaseAddon {
  protected override async onInitialize(): Promise<void> {
    /* pure consumer */
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('BaseAddon auto-emit readiness', () => {
  let bus: TestEventBus
  let consumer: ReadinessRegistry

  beforeEach(() => {
    bus = new TestEventBus()
    consumer = new ReadinessRegistry({
      eventBus: bus,
      sourceNodeId: 'hub-consumer',
      generation: 'gen-CONS',
    })
  })
  afterEach(() => {
    consumer.close()
  })

  it('emits ready for the single registered cap on initialize', async () => {
    const handler = vi.fn()
    consumer.onReadyState('fake-cap', { type: 'node', nodeId: 'hub' }, handler)
    const addon = new OneProviderAddon({})
    await addon.initialize(makeContext(bus))
    addon.postBrokerStart()
    expect(handler).toHaveBeenCalledTimes(1)
    const call = handler.mock.calls[0]![0]
    expect(call.state).toBe('ready')
    expect(call.epoch).toBe(1)
    expect(call.scope).toEqual({ type: 'node', nodeId: 'hub' })
  })

  it('emits down for the cap on shutdown with the same generation', async () => {
    const transitions: Array<{ state: string; generation: string }> = []
    consumer.onReadyState('fake-cap', { type: 'node', nodeId: 'hub' }, (t) => {
      transitions.push({ state: t.state, generation: t.generation })
    })
    const addon = new OneProviderAddon({})
    await addon.initialize(makeContext(bus))
    addon.postBrokerStart()
    await addon.shutdown()

    expect(transitions.map((t) => t.state)).toEqual(['ready', 'down'])
    expect(transitions[0]!.generation).toBe(transitions[1]!.generation)
  })

  it('emits ready once per registered provider', async () => {
    const fakeHandler = vi.fn()
    const otherHandler = vi.fn()
    consumer.onReadyState('fake-cap', { type: 'node', nodeId: 'hub' }, fakeHandler)
    consumer.onReadyState('other-cap', { type: 'node', nodeId: 'hub' }, otherHandler)
    const addon = new MultiProviderAddon({})
    await addon.initialize(makeContext(bus))
    addon.postBrokerStart()
    expect(fakeHandler).toHaveBeenCalledTimes(1)
    expect(otherHandler).toHaveBeenCalledTimes(1)
  })

  it('respects autoEmitReadiness=false override', async () => {
    const handler = vi.fn()
    consumer.onReadyState('fake-cap', { type: 'node', nodeId: 'hub' }, handler)
    const addon = new OptOutAddon({})
    await addon.initialize(makeContext(bus))
    await addon.shutdown()
    expect(handler).not.toHaveBeenCalled()
  })

  it('skips emission when the addon registered no providers', async () => {
    const spy = vi.fn()
    bus.subscribe({ category: 'system.ready-state' }, spy)
    const addon = new NoProviderAddon({})
    await addon.initialize(makeContext(bus))
    expect(spy).not.toHaveBeenCalled()
  })

  it('uses ctx.kernel.localNodeId for the scope nodeId', async () => {
    const handler = vi.fn()
    consumer.onReadyState('fake-cap', { type: 'node', nodeId: 'dev-agent-0' }, handler)
    const addon = new OneProviderAddon({})
    await addon.initialize(
      makeContext(bus, {
        kernel: { localNodeId: 'dev-agent-0' } as AddonContext['kernel'],
      }),
    )
    addon.postBrokerStart()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0].scope).toEqual({ type: 'node', nodeId: 'dev-agent-0' })
  })

  it('two instances of the same addon class get different generations', async () => {
    const a1 = new OneProviderAddon({})
    const a2 = new OneProviderAddon({})
    await a1.initialize(makeContext(bus))
    a1.postBrokerStart()
    await a2.initialize(makeContext(bus))
    a2.postBrokerStart()
    const payloads = bus
      .getRecent()
      .filter((e) => e.category === 'system.ready-state')
      .map((e) => (e.data as { generation: string }).generation)
    expect(new Set(payloads).size).toBe(2)
  })
})
