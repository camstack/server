import { describe, expect, it, vi } from 'vitest'
import { EventCategory } from '../../enums/event-category.js'
import type { ConfigFieldWithValue, ConfigUISchemaWithValues } from '../../interfaces/config-ui.js'
import { BaseAddon } from '../base-addon.js'

// ── Fakes ───────────────────────────────────────────────────────────────

interface FakeCtxHandle {
  readonly ctx: Parameters<BaseAddon['initialize']>[0]
  readonly store: Record<string, unknown>
  readonly emit: ReturnType<typeof vi.fn>
}

function makeCtx(localNodeId: string, seed?: Record<string, unknown>): FakeCtxHandle {
  const store: Record<string, unknown> = { ...seed }
  const emit = vi.fn()
  const ctx = {
    id: 'test-addon',
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    kernel: { localNodeId },
    eventBus: { emit, subscribe: vi.fn(() => () => {}) },
    settings: {
      readAddonStore: async () => ({ ...store }),
      writeAddonStore: async (patch: Record<string, unknown>) => {
        Object.assign(store, patch)
      },
    },
  } as unknown as Parameters<BaseAddon['initialize']>[0]
  return { ctx, store, emit }
}

function fieldValue(schema: ConfigUISchemaWithValues | null, key: string): unknown {
  for (const section of schema?.sections ?? []) {
    for (const field of section.fields as readonly ConfigFieldWithValue[]) {
      if ('key' in field && field.key === key && 'value' in field) return field.value
    }
  }
  return undefined
}

function emittedCategories(emit: ReturnType<typeof vi.fn>): string[] {
  return emit.mock.calls.map((call) => {
    const event = call[0] as { readonly category?: unknown }
    return typeof event?.category === 'string' ? event.category : ''
  })
}

// ── Addon WITHOUT any perNode field (the P2a steady state) ──────────────

interface PlainConfig {
  shared: string
  count: number
}

class PlainAddon extends BaseAddon<PlainConfig> {
  configChanges = 0
  constructor() {
    super({ shared: 'default-shared', count: 1 })
  }
  /** Test-only surface over the protected base seam. */
  async resolveStoreFor(nodeId?: string): Promise<Record<string, unknown>> {
    return this.resolveGlobalStore(nodeId)
  }
  protected globalSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'main',
          title: 'Main',
          fields: [
            this.field({ type: 'text', key: 'shared', label: 'Shared', default: 'default-shared' }),
            this.field({ type: 'number', key: 'count', label: 'Count', default: 1 }),
          ],
        },
      ],
    })
  }
  protected async onInitialize() {
    return []
  }
  protected async onConfigChanged() {
    this.configChanges++
  }
}

// ── Addon WITH a perNode:true field ─────────────────────────────────────

interface NodeScopedConfig {
  backend: string
  shared: string
}

class PerNodeAddon extends BaseAddon<NodeScopedConfig> {
  configChanges = 0
  constructor() {
    super({ backend: 'ffmpeg', shared: 'default-shared' })
  }
  /** Test-only surface over the protected base seam. */
  async resolveStoreFor(nodeId?: string): Promise<Record<string, unknown>> {
    return this.resolveGlobalStore(nodeId)
  }
  protected globalSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'main',
          title: 'Main',
          fields: [
            this.field({
              type: 'select',
              key: 'backend',
              label: 'Backend',
              default: 'ffmpeg',
              perNode: true,
              options: [
                { value: 'ffmpeg', label: 'FFmpeg' },
                { value: 'nodeav', label: 'NodeAV' },
              ],
            }),
            this.field({ type: 'text', key: 'shared', label: 'Shared', default: 'default-shared' }),
          ],
        },
      ],
    })
  }
  protected async onInitialize() {
    return []
  }
  protected async onConfigChanged() {
    this.configChanges++
  }
}

// ── No-op guarantee: NO field is perNode ⇒ byte-identical behavior ──────

describe('BaseAddon settings — no perNode fields (no-op guarantee)', () => {
  it('getGlobalSettings hydrates from the raw store verbatim', async () => {
    const { ctx } = makeCtx('hub', { shared: 'from-store' })
    const addon = new PlainAddon()
    await addon.initialize(ctx)
    const view = await addon.getGlobalSettings()
    expect(fieldValue(view, 'shared')).toBe('from-store')
    expect(fieldValue(view, 'count')).toBe(1) // schema default
  })

  it('getGlobalSettings with an explicit foreign nodeId still reads the raw store (projection bypassed)', async () => {
    const { ctx } = makeCtx('hub', { shared: 'from-store' })
    const addon = new PlainAddon()
    await addon.initialize(ctx)
    const view = await addon.getGlobalSettings(undefined, undefined, 'agent-1')
    expect(fieldValue(view, 'shared')).toBe('from-store')
  })

  it('updateGlobalSettings writes the bare patch and runs the full local-apply tail', async () => {
    const { ctx, store, emit } = makeCtx('hub')
    const addon = new PlainAddon()
    await addon.initialize(ctx)
    await addon.updateGlobalSettings({ shared: 'updated', count: 5 })
    expect(store).toEqual({ shared: 'updated', count: 5 })
    expect(Object.keys(store).some((k) => k.includes('@'))).toBe(false)
    expect(addon.config.shared).toBe('updated')
    expect(addon.config.count).toBe(5)
    expect(addon.configChanges).toBe(1)
    expect(emittedCategories(emit)).toContain(EventCategory.AddonUpdated)
  })

  it('updateGlobalSettings with an explicit SELF nodeId behaves identically', async () => {
    const { ctx, store } = makeCtx('hub')
    const addon = new PlainAddon()
    await addon.initialize(ctx)
    await addon.updateGlobalSettings({ shared: 'self-updated' }, 'hub')
    expect(store).toEqual({ shared: 'self-updated' })
    expect(addon.config.shared).toBe('self-updated')
    expect(addon.configChanges).toBe(1)
  })
})

// ── perNode:true field behavior ─────────────────────────────────────────

describe('BaseAddon settings — with a perNode:true field', () => {
  it('update (node-blind, local node from ctx) writes <key>@<node>, never the bare key', async () => {
    // child-process node id — must be normalized to the parent node 'hub'
    const { ctx, store } = makeCtx('hub/decoder-ffmpeg')
    const addon = new PerNodeAddon()
    await addon.initialize(ctx)
    await addon.updateGlobalSettings({ backend: 'nodeav', shared: 'cluster' })
    expect(store['backend@hub']).toBe('nodeav')
    expect(Object.prototype.hasOwnProperty.call(store, 'backend')).toBe(false)
    expect(store['shared']).toBe('cluster')
    // local apply ran: config resolved THIS node's scoped value
    expect(addon.config.backend).toBe('nodeav')
    expect(addon.configChanges).toBe(1)
  })

  it('get projects the scoped value back onto the bare schema key', async () => {
    const { ctx } = makeCtx('hub', { 'backend@hub': 'nodeav' })
    const addon = new PerNodeAddon()
    await addon.initialize(ctx)
    const view = await addon.getGlobalSettings()
    expect(fieldValue(view, 'backend')).toBe('nodeav')
  })

  it('a different node reads its own value / schema default — no cross-node leak', async () => {
    const { ctx } = makeCtx('hub', {
      'backend@hub': 'nodeav',
      'backend@agent-1': 'ffmpeg',
      backend: 'stale-bare',
    })
    const addon = new PerNodeAddon()
    await addon.initialize(ctx)
    const agent1 = await addon.getGlobalSettings(undefined, undefined, 'agent-1')
    expect(fieldValue(agent1, 'backend')).toBe('ffmpeg')
    // node with NO scoped key: schema default, NOT the hub's value, NOT the bare key
    const agent99 = await addon.getGlobalSettings(undefined, undefined, 'agent-99')
    expect(fieldValue(agent99, 'backend')).toBe('ffmpeg')
    const hub = await addon.getGlobalSettings()
    expect(fieldValue(hub, 'backend')).toBe('nodeav')
  })

  it('sibling-target update writes the scoped key WITHOUT local side effects', async () => {
    const { ctx, store, emit } = makeCtx('hub')
    const addon = new PerNodeAddon()
    await addon.initialize(ctx)
    emit.mockClear()
    await addon.updateGlobalSettings({ backend: 'nodeav' }, 'agent-1')
    expect(store['backend@agent-1']).toBe('nodeav')
    expect(Object.prototype.hasOwnProperty.call(store, 'backend')).toBe(false)
    // no local apply: config untouched, no onConfigChanged, no lifecycle emit
    expect(addon.config.backend).toBe('ffmpeg')
    expect(addon.configChanges).toBe(0)
    expect(emittedCategories(emit)).not.toContain(EventCategory.AddonUpdated)
  })

  it('resolveConfig at boot reads THIS node scoped key', async () => {
    const { ctx } = makeCtx('hub', { 'backend@hub': 'nodeav' })
    const addon = new PerNodeAddon()
    await addon.initialize(ctx)
    expect(addon.config.backend).toBe('nodeav')
  })

  it('resolveConfig at boot ignores a bare legacy key (NO bare fallback)', async () => {
    const { ctx } = makeCtx('hub', { backend: 'nodeav' })
    const addon = new PerNodeAddon()
    await addon.initialize(ctx)
    expect(addon.config.backend).toBe('ffmpeg') // constructor default wins
  })
})

// ── resolveGlobalStore — projected raw store for getGlobalSettings overrides ─

describe('BaseAddon.resolveGlobalStore — per-node projected store seam', () => {
  const seed = {
    'backend@hub': 'nodeav',
    'backend@agent-1': 'ffmpeg',
    backend: 'stale-bare',
    shared: 'x',
  }

  it('returns THIS node scoped value on the bare key; other nodes and stale-bare dropped', async () => {
    const { ctx } = makeCtx('hub', seed)
    const addon = new PerNodeAddon()
    await addon.initialize(ctx)
    const projected = await addon.resolveStoreFor('hub')
    expect(projected).toEqual({ backend: 'nodeav', shared: 'x' })
  })

  it('a node with NO scoped key omits the bare key entirely (schema-default territory)', async () => {
    const { ctx } = makeCtx('hub', seed)
    const addon = new PerNodeAddon()
    await addon.initialize(ctx)
    const projected = await addon.resolveStoreFor('agent-99')
    expect(projected).toEqual({ shared: 'x' })
    expect(Object.prototype.hasOwnProperty.call(projected, 'backend')).toBe(false)
  })

  it('node-blind call resolves the LOCAL node (child-process id normalized)', async () => {
    const { ctx } = makeCtx('hub/decoder-ffmpeg', seed)
    const addon = new PerNodeAddon()
    await addon.initialize(ctx)
    const projected = await addon.resolveStoreFor()
    expect(projected).toEqual({ backend: 'nodeav', shared: 'x' })
  })

  it('addon with NO perNode field returns the raw store verbatim (projection bypassed)', async () => {
    const raw = { shared: 'from-store', count: 7, 'weird@key': 'kept' }
    const { ctx } = makeCtx('hub', raw)
    const addon = new PlainAddon()
    await addon.initialize(ctx)
    const projected = await addon.resolveStoreFor('agent-1')
    expect(projected).toEqual(raw)
  })
})
