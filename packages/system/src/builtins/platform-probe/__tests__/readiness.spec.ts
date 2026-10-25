/**
 * S2 — platform-probe async-ready readiness.
 *
 * The provider registers synchronously from `onInitialize`, but the REAL
 * hardware + embedded-Python EP scoring is the async `probePromise`. The
 * BaseAddon auto-emit (and the hub's provider-registered emit) flipped
 * `ready` at registration time — before the probe finished — so consumers
 * (detection-pipeline engine auto-pick) read accelerator-blind results.
 *
 * Contract under test:
 *   - `autoEmitReadiness` is FALSE (no premature base emit, incl. postBrokerStart).
 *   - onInitialize emits `starting` on `{type:'node', nodeId:<bare local>}`.
 *   - `ready` is emitted ONLY once the probe promise resolves (the single
 *     post-Python accelerator-visible flip), on the same node scope.
 *   - onShutdown emits `down`.
 */
import type { SystemEvent } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => {
  let resolveProbe: (caps: unknown) => void = () => undefined
  let rejectProbe: (err: unknown) => void = () => undefined
  const state = {
    probePromise: Promise.resolve<unknown>(null),
    resolve: (caps: unknown) => resolveProbe(caps),
    reject: (err: unknown) => rejectProbe(err),
    reset() {
      state.probePromise = new Promise((res, rej) => {
        resolveProbe = res
        rejectProbe = rej
      })
    },
  }
  return state
})

vi.mock('../platform-scorer.js', () => ({
  PlatformScorer: class {
    async probe(): Promise<unknown> {
      return hoisted.probePromise
    }
  },
}))

// Import AFTER the mock so the addon binds the fake scorer.
import { PlatformProbeNativeAddon } from '../index.js'

type AddonCtx = Parameters<PlatformProbeNativeAddon['initialize']>[0]

const FAKE_CAPS = {
  hardware: {
    platform: 'linux',
    arch: 'x64',
    cpuModel: 'Intel(R) N100',
    cpuCores: 4,
    totalRAM_MB: 8000,
    availableRAM_MB: 4000,
    gpu: { type: 'intel', name: 'iGPU' },
    npu: null,
  },
  scores: [],
  bestScore: {
    runtime: 'python',
    backend: 'openvino',
    format: 'openvino',
    score: 90,
    reason: 'Intel OpenVINO',
    available: true,
  },
}

interface Harness {
  readonly addon: PlatformProbeNativeAddon
  readonly events: SystemEvent[]
  readonly ctx: AddonCtx
}

function makeHarness(localNodeId: string): Harness {
  const events: SystemEvent[] = []
  const noop = (): void => undefined
  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  const ctx = {
    id: 'platform-probe-native',
    logger,
    kernel: { localNodeId },
    eventBus: {
      emit: (event: SystemEvent) => {
        events.push(event)
      },
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
  return { addon: new PlatformProbeNativeAddon(), events, ctx }
}

interface ReadinessEventView {
  readonly state: string
  readonly scope: { readonly type: string; readonly nodeId?: string }
  readonly capName: string
}

function readinessEvents(events: readonly SystemEvent[]): ReadinessEventView[] {
  return events
    .filter((e) => e.category === 'system.ready-state')
    .map((e) => e.data as unknown as ReadinessEventView)
    .filter((d) => d.capName === 'platform-probe')
}

async function flush(): Promise<void> {
  // Let the probePromise .then chain run.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  hoisted.reset()
})

describe('platform-probe — async-ready readiness protocol', () => {
  it('opts out of the BaseAddon auto emission (autoEmitReadiness=false)', () => {
    const { addon } = makeHarness('hub')
    const flag = (addon as unknown as { autoEmitReadiness: boolean }).autoEmitReadiness
    expect(flag).toBe(false)
  })

  it('emits starting on init, and ready ONLY once the probe resolves (node scope)', async () => {
    const { addon, events, ctx } = makeHarness('dev-agent-0')
    await addon.initialize(ctx)

    let seen = readinessEvents(events)
    expect(seen.map((e) => e.state)).toEqual(['starting'])
    expect(seen[0]?.scope).toEqual({ type: 'node', nodeId: 'dev-agent-0' })

    // postBrokerStart (forked-runner re-emit) must NOT flip ready either.
    addon.postBrokerStart()
    seen = readinessEvents(events)
    expect(seen.map((e) => e.state)).toEqual(['starting'])

    hoisted.resolve(FAKE_CAPS)
    await flush()

    seen = readinessEvents(events)
    expect(seen.map((e) => e.state)).toEqual(['starting', 'ready'])
    expect(seen[1]?.scope).toEqual({ type: 'node', nodeId: 'dev-agent-0' })
  })

  it('never emits ready when the probe FAILS', async () => {
    const { addon, events, ctx } = makeHarness('hub')
    const init = await addon.initialize(ctx)
    // Attach a consumer to the probe promise BEFORE rejecting so the stored
    // rejection is handled (mirrors a real getCapabilities caller).
    const provider = (
      init as unknown as {
        providers?: ReadonlyArray<{ provider: { getCapabilities(): Promise<unknown> } }>
      }
    )?.providers?.[0]?.provider
    const pending = provider?.getCapabilities().catch(() => undefined) ?? Promise.resolve()

    hoisted.reject(new Error('probe blew up'))
    await pending
    await flush()

    const seen = readinessEvents(events)
    expect(seen.map((e) => e.state)).toEqual(['starting'])
  })

  it('strips a forked child suffix from the node scope', async () => {
    const { addon, events, ctx } = makeHarness('dev-agent-0/platform-probe-native')
    await addon.initialize(ctx)
    hoisted.resolve(FAKE_CAPS)
    await flush()

    const seen = readinessEvents(events)
    expect(seen.every((e) => e.scope.nodeId === 'dev-agent-0')).toBe(true)
  })

  it('emits down on shutdown', async () => {
    const { addon, events, ctx } = makeHarness('hub')
    await addon.initialize(ctx)
    hoisted.resolve(FAKE_CAPS)
    await flush()

    await addon.shutdown()

    const seen = readinessEvents(events)
    expect(seen.map((e) => e.state)).toEqual(['starting', 'ready', 'down'])
    expect(seen[2]?.scope).toEqual({ type: 'node', nodeId: 'hub' })
  })
})
