/**
 * S3 — platform-probe `resolveHwAccel` consolidation.
 *
 * The cap is the SOLE cross-node-pinnable hwaccel surface (the `$hwaccel`
 * Moleculer service was retired). Contract under test:
 *   - the provider delegates to `ctx.kernel.hwaccel` and surfaces BOTH
 *     `preferred` AND `rationale` (previously it dropped the rationale);
 *   - it takes NO data `nodeId` (per-node targeting is transport-level
 *     `nodePin`, D4) — the input schema drops any stray `nodeId`;
 *   - a non-decode / EP-only `prefer` is narrowed to `null` (auto-probe)
 *     without a cast, and `'none'` passes through as the disable sentinel;
 *   - an unavailable kernel resolver degrades to an EXPLAINED empty list.
 */
import type { SystemEvent } from '@camstack/types'
import { platformProbeCapability } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../platform-scorer.js', () => ({
  PlatformScorer: class {
    async probe(): Promise<unknown> {
      return {
        hardware: {
          platform: 'linux',
          arch: 'x64',
          cpuModel: '',
          cpuCores: 1,
          totalRAM_MB: 1,
          availableRAM_MB: 1,
          gpu: null,
          npu: null,
        },
        scores: [],
        bestScore: {
          runtime: 'python',
          backend: 'onnx',
          format: 'onnx',
          score: 1,
          reason: '',
          available: true,
        },
      }
    }
  },
}))

// Import AFTER the mock so the addon binds the fake scorer.
import { PlatformProbeNativeAddon } from '../index.js'

type AddonCtx = Parameters<PlatformProbeNativeAddon['initialize']>[0]

interface HwAccelResult {
  readonly preferred: readonly string[]
  readonly rationale: string
}

interface ResolveHwAccelProvider {
  resolveHwAccel(input: { readonly prefer?: string | null }): Promise<HwAccelResult>
}

interface KernelHwAccelFake {
  resolve(prefer?: unknown): Promise<HwAccelResult>
}

function makeCtx(hwaccel: KernelHwAccelFake | undefined): AddonCtx {
  const noop = (): undefined => undefined
  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return {
    id: 'platform-probe-native',
    logger,
    kernel: { localNodeId: 'hub', hwaccel },
    eventBus: {
      emit: (_event: SystemEvent) => undefined,
      subscribe: () => () => undefined,
    },
    settings: {
      readAddonStore: async () => ({}),
      writeAddonStore: async () => undefined,
      getSection: async () => ({}),
    },
    deps: {
      ensurePython: async () => {
        throw new Error('no embedded python in tests')
      },
    },
  } as unknown as AddonCtx
}

async function bootProvider(
  hwaccel: KernelHwAccelFake | undefined,
): Promise<ResolveHwAccelProvider> {
  const addon = new PlatformProbeNativeAddon()
  const init = await addon.initialize(makeCtx(hwaccel))
  const provider = (
    init as unknown as {
      providers?: ReadonlyArray<{ provider: ResolveHwAccelProvider }>
    }
  ).providers?.[0]?.provider
  if (!provider) throw new Error('platform-probe provider not registered')
  return provider
}

describe('platform-probe — resolveHwAccel signature (S3 consolidation)', () => {
  it('surfaces { preferred, rationale } from the kernel resolver', async () => {
    const resolve = vi.fn(async (prefer?: unknown) => ({
      preferred: ['vaapi', 'qsv'],
      rationale: `explicit ${String(prefer)}`,
    }))
    const provider = await bootProvider({ resolve })

    const res = await provider.resolveHwAccel({ prefer: 'vaapi' })

    expect(res).toEqual({ preferred: ['vaapi', 'qsv'], rationale: 'explicit vaapi' })
    expect(resolve).toHaveBeenCalledWith('vaapi')
  })

  it('narrows an EP-only / non-decode prefer to null (auto-probe) — no cast', async () => {
    const resolve = vi.fn(async (prefer?: unknown) => ({
      preferred: [],
      rationale: String(prefer),
    }))
    const provider = await bootProvider({ resolve })

    await provider.resolveHwAccel({ prefer: 'openvino' })

    expect(resolve).toHaveBeenCalledWith(null)
  })

  it('passes the none sentinel straight through', async () => {
    const resolve = vi.fn(async () => ({ preferred: [], rationale: 'disabled' }))
    const provider = await bootProvider({ resolve })

    await provider.resolveHwAccel({ prefer: 'none' })

    expect(resolve).toHaveBeenCalledWith('none')
  })

  it('degrades to an explained empty list when the kernel hwaccel is unavailable', async () => {
    const provider = await bootProvider(undefined)

    const res = await provider.resolveHwAccel({ prefer: 'vaapi' })

    expect(res.preferred).toEqual([])
    expect(res.rationale).toContain('unavailable')
  })

  it('input schema drops a stray nodeId (per-node = transport nodePin only)', () => {
    const parsed = platformProbeCapability.methods.resolveHwAccel.input.parse({
      prefer: 'vaapi',
      nodeId: 'agent-x',
    })
    expect(parsed).not.toHaveProperty('nodeId')
    expect(parsed).toEqual({ prefer: 'vaapi' })
  })

  it('output schema carries the rationale', () => {
    const out = platformProbeCapability.methods.resolveHwAccel.output.parse({
      preferred: ['vaapi'],
      rationale: 'why',
    })
    expect(out.rationale).toBe('why')
  })
})
