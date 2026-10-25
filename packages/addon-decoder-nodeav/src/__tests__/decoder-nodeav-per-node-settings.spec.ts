/**
 * P2b — decoder-nodeav per-node settings via the BASE `perNode:true` marker
 * (settings-API migration).
 *
 * P2a moved per-node scoping into `BaseAddon` (`packages/types/src/addon/
 * base-addon.ts` + `per-node-store.ts`): any schema field marked
 * `perNode: true` is persisted node-scoped as `<key>@<nodeId>` — node-blind,
 * with NO bare-key fallback. P2b marks this addon's `probedBestHwaccel`
 * `perNode: true` and routes `reprobeHwaccel` through `updateGlobalSettings`
 * so the base class does the scoping. (The `backend` select field lives on
 * decoder-ffmpeg — the owner addon; this addon has none.)
 *
 * Fake-ctx style mirrors `packages/types/src/addon/__tests__/
 * base-addon-per-node.spec.ts`. `resolveDecoderBackend` now ignores owner
 * settings and always returns `nodeav`, so initialize proceeds on the
 * default backend. These tests still cover only the settings surface
 * (`probedBestHwaccel` scoping), not the decode path.
 */
import { BaseAddon, EventCategory } from '@camstack/types'
import type { ConfigFieldWithValue, ConfigUISchemaWithValues } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import DecoderNodeAvAddon from '../addon/index.js'

// ── Fakes ───────────────────────────────────────────────────────────────

type AddonCtx = Parameters<BaseAddon['initialize']>[0]

interface FakeHwaccelResolution {
  readonly preferred: readonly string[]
  readonly rationale: string
}

interface FakeHwaccelResolver {
  resolve(): Promise<FakeHwaccelResolution>
}

interface FakeCtxOptions {
  readonly localNodeId: string
  readonly seed?: Record<string, unknown>
  readonly hwaccel?: FakeHwaccelResolver
}

interface FakeCtxHandle {
  readonly ctx: AddonCtx
  readonly store: Record<string, unknown>
  readonly emit: ReturnType<typeof vi.fn>
}

function makeCtx(options: FakeCtxOptions): FakeCtxHandle {
  const store: Record<string, unknown> = { ...options.seed }
  const emit = vi.fn()
  const ctx = {
    id: 'decoder-nodeav',
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    kernel: { localNodeId: options.localNodeId, hwaccel: options.hwaccel },
    eventBus: { emit, subscribe: vi.fn(() => () => {}) },
    settings: {
      readAddonStore: async () => ({ ...store }),
      writeAddonStore: async (patch: Record<string, unknown>) => {
        Object.assign(store, patch)
      },
    },
    api: {
      addonSettings: {
        getGlobalSettings: {
          // Persisted owner backend is inert; initialize still defaults to nodeav.
          query: async () => ({
            sections: [{ fields: [{ key: 'backend', value: 'ffmpeg' }] }],
          }),
        },
      },
    },
  } as unknown as AddonCtx
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

async function makeAddon(
  options: FakeCtxOptions,
): Promise<FakeCtxHandle & { addon: DecoderNodeAvAddon }> {
  const handle = makeCtx(options)
  const addon = new DecoderNodeAvAddon()
  await addon.initialize(handle.ctx)
  return { ...handle, addon }
}

// ── reprobeHwaccel writes the node-scoped key, never the bare key ────────

describe('decoder-nodeav — reprobeHwaccel per-node persistence', () => {
  it('persists the probed backend under probedBestHwaccel@<node>, never the bare key', async () => {
    const { addon, store } = await makeAddon({
      localNodeId: 'hub',
      hwaccel: { resolve: async () => ({ preferred: ['vaapi'], rationale: 'test' }) },
    })
    const result = await addon.reprobeHwaccel()
    expect(result).toEqual({ backend: 'vaapi' })
    expect(store['probedBestHwaccel@hub']).toBe('vaapi')
    expect(Object.prototype.hasOwnProperty.call(store, 'probedBestHwaccel')).toBe(false)
  })

  it('no kernel resolver: writes none under the node-scoped key, never the bare key', async () => {
    const { addon, store } = await makeAddon({ localNodeId: 'hub' })
    const result = await addon.reprobeHwaccel()
    expect(result).toEqual({ backend: 'none' })
    expect(store['probedBestHwaccel@hub']).toBe('none')
    expect(Object.prototype.hasOwnProperty.call(store, 'probedBestHwaccel')).toBe(false)
  })

  it('a child-process localNodeId (hub/decoder-nodeav) normalizes to the parent node', async () => {
    const { addon, store } = await makeAddon({
      localNodeId: 'hub/decoder-nodeav',
      hwaccel: { resolve: async () => ({ preferred: ['vaapi'], rationale: 'test' }) },
    })
    await addon.reprobeHwaccel()
    expect(store['probedBestHwaccel@hub']).toBe('vaapi')
    expect(Object.prototype.hasOwnProperty.call(store, 'probedBestHwaccel')).toBe(false)
  })
})

// ── getGlobalSettings is per-node independent ────────────────────────────

describe('decoder-nodeav — getGlobalSettings per-node projection', () => {
  it('each node reads its OWN scoped probedBestHwaccel; absent scoped key ⇒ schema default, never a bare legacy key', async () => {
    const { addon } = await makeAddon({
      localNodeId: 'hub',
      seed: {
        'probedBestHwaccel@hub': 'vaapi',
        'probedBestHwaccel@agent-1': 'qsv',
        // Bare legacy key MUST be invisible to every node.
        probedBestHwaccel: 'stale-bare-probe',
      },
    })
    const hub = await addon.getGlobalSettings(undefined, undefined, 'hub')
    expect(fieldValue(hub, 'probedBestHwaccel')).toBe('vaapi')
    const agent1 = await addon.getGlobalSettings(undefined, undefined, 'agent-1')
    expect(fieldValue(agent1, 'probedBestHwaccel')).toBe('qsv')
    // Node with NO scoped key: schema default, NOT the bare key.
    const agent99 = await addon.getGlobalSettings(undefined, undefined, 'agent-99')
    expect(fieldValue(agent99, 'probedBestHwaccel')).toBe('')
  })

  it('node-blind read (no nodeId) resolves the LOCAL node scoped value', async () => {
    const { addon } = await makeAddon({
      localNodeId: 'hub',
      seed: { 'probedBestHwaccel@hub': 'vaapi', 'probedBestHwaccel@agent-1': 'qsv' },
    })
    const view = await addon.getGlobalSettings()
    expect(fieldValue(view, 'probedBestHwaccel')).toBe('vaapi')
  })
})

// ── updateGlobalSettings for a sibling node ──────────────────────────────

describe('decoder-nodeav — updateGlobalSettings sibling-node write', () => {
  it('writes ONLY the scoped key, no bare key, no local side effects', async () => {
    const { addon, store, emit } = await makeAddon({ localNodeId: 'hub' })
    // Init now stays on the nodeav default (persisted backend@* is inert), so
    // drain the fire-and-forget auto-reprobe before asserting a sibling write.
    await addon.reprobeHwaccel()
    const localAfterInit = addon.config.probedBestHwaccel
    emit.mockClear()
    await addon.updateGlobalSettings({ probedBestHwaccel: 'qsv' }, 'agent-1')
    expect(store['probedBestHwaccel@agent-1']).toBe('qsv')
    expect(Object.prototype.hasOwnProperty.call(store, 'probedBestHwaccel')).toBe(false)
    expect(addon.config.probedBestHwaccel).toBe(localAfterInit)
    expect(emittedCategories(emit)).not.toContain(EventCategory.AddonUpdated)
  })
})

// ── The decoder cap surface is per-node hwaccel only (D763) ──────────────

const REMOVED_SESSION_METHODS = [
  'supportsCodec',
  'createSession',
  'destroySession',
  'pushPacket',
  'openStream',
  'pullFrames',
  'pullHandles',
  'getFrame',
  'getShmStats',
  'updateConfig',
  'getStats',
  'listActiveSessions',
] as const

describe('decoder-nodeav — decoder cap surface (D763)', () => {
  it('answers getInfo with its identity and hwaccel, and no session mode or priority', async () => {
    const { addon } = await makeAddon({ localNodeId: 'hub' })
    const info = await addon.getInfo()
    expect(info).toMatchObject({ id: 'decoder-nodeav', name: 'Decoder (node-av)', hwaccel: 'auto' })
    expect(Object.keys(info)).not.toContain('isPullMode')
    expect(Object.keys(info)).not.toContain('priority')
  })

  it('has no decoder session method left to call', async () => {
    const { addon } = await makeAddon({ localNodeId: 'hub' })
    const present = REMOVED_SESSION_METHODS.filter((m) => m in addon)
    expect(present).toEqual([])
  })
})
