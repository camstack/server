/**
 * D649 fix round: the image tower's single-flight is keyed by MODEL. The old
 * shared promise let two callers for a new model both dispose-and-build,
 * orphaning one Python process.
 */
import {
  EMBEDDING_REQUIREMENTS_FAILED,
  EMBEDDING_REQUIREMENTS_UNAVAILABLE,
  embeddingRefusalOf,
  isEmbeddingModelFailed,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { CrashBudget } from '../crash-budget.js'
import { ModelEngineSlot } from '../model-engine-slot.js'
import {
  PermanentRequirementsFailure,
  REQUIREMENTS_COOLDOWN_BASE_MS,
  RequirementsGate,
} from '../model-requirements.js'

interface FakeEngine {
  readonly id: string
  disposed: boolean
  crashed: boolean
  initialize(): Promise<void>
  dispose(): Promise<void>
  isAlive(): boolean
}

/** Which stage of the next build for a model fails — `build` spawns nothing. */
interface Failures {
  readonly build: Set<string>
  readonly permanent: Set<string>
  readonly load: Set<string>
}

function harness(
  onDead: (modelId: string) => void = () => {},
  budget?: CrashBudget,
  requirements?: RequirementsGate,
  onBuild: (modelId: string) => void = () => {},
): {
  slot: ModelEngineSlot<FakeEngine>
  built: FakeEngine[]
  release: (modelId: string) => void
  failures: Failures
} {
  const built: FakeEngine[] = []
  const gates = new Map<string, Array<() => void>>()
  const failures: Failures = { build: new Set(), permanent: new Set(), load: new Set() }
  const slot = new ModelEngineSlot<FakeEngine>(
    async (modelId) => {
      onBuild(modelId)
      await new Promise<void>((resolve) => {
        gates.set(modelId, [...(gates.get(modelId) ?? []), resolve])
      })
      if (failures.build.has(modelId)) {
        throw new Error(`ModelDownloadService: registry unreachable for "${modelId}"`)
      }
      if (failures.permanent.has(modelId)) {
        throw new PermanentRequirementsFailure(`HTTP 404 downloading https://x/${modelId}.onnx`)
      }
      const engine: FakeEngine = {
        id: modelId,
        disposed: false,
        crashed: false,
        initialize: async () => {
          if (failures.load.has(modelId)) throw new Error('python exited 1 before ready')
        },
        dispose: async () => {
          engine.disposed = true
        },
        isAlive: () => !engine.crashed && !engine.disposed,
      }
      built.push(engine)
      return engine
    },
    budget ??
      new CrashBudget({
        tower: 'image',
        nodeId: () => 'hub',
        logger: { info: () => {}, error: () => {} },
        maxCrashes: 100,
      }),
    requirements ??
      new RequirementsGate({
        tower: 'image',
        nodeId: () => 'hub',
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      }),
    onDead,
  )
  const release = (modelId: string): void => {
    for (const g of gates.get(modelId) ?? []) g()
    gates.delete(modelId)
  }
  return { slot, built, release, failures }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('ModelEngineSlot — one engine, single-flight per model', () => {
  it('concurrent callers for the same model share ONE build', async () => {
    const { slot, built, release } = harness()
    const a = slot.ensure('siglip2-b16-224')
    const b = slot.ensure('siglip2-b16-224')
    await tick()
    release('siglip2-b16-224')
    expect(await a).toBe(await b)
    expect(built).toHaveLength(1)
  })

  it('a switch while the old model is held disposes it once; concurrent new-model waiters share one build', async () => {
    const { slot, built, release } = harness()
    const first = slot.ensure('test-clip-a')
    await tick()
    release('test-clip-a')
    const mc = await first
    const x = slot.ensure('siglip2-b16-224')
    const y = slot.ensure('siglip2-b16-224')
    await tick()
    release('siglip2-b16-224')
    expect(await x).toBe(await y)
    expect(mc.disposed).toBe(true)
    expect(built.map((e) => e.id)).toEqual(['test-clip-a', 'siglip2-b16-224'])
    expect(slot.held()?.modelId).toBe('siglip2-b16-224')
  })

  it('a build superseded while in flight is disposed, never left running unheld', async () => {
    const { slot, built, release } = harness()
    const stale = slot.ensure('test-clip-a')
    const fresh = slot.ensure('siglip2-b16-224')
    await tick()
    release('test-clip-a')
    await expect(stale).rejects.toThrow(/superseded/)
    await tick()
    release('siglip2-b16-224')
    await fresh
    expect(built.find((e) => e.id === 'test-clip-a')?.disposed).toBe(true)
    expect(built.filter((e) => !e.disposed).map((e) => e.id)).toEqual(['siglip2-b16-224'])
  })

  it('a CRASHED engine is dropped (and reported) and the next ensure rebuilds it', async () => {
    const dead: string[] = []
    const { slot, built, release } = harness((m) => dead.push(m))
    const first = slot.ensure('siglip2-b16-224')
    await tick()
    release('siglip2-b16-224')
    ;(await first).crashed = true // OOM kill
    const again = slot.ensure('siglip2-b16-224')
    await tick()
    release('siglip2-b16-224')
    const rebuilt = await again
    expect(rebuilt).not.toBe(built[0])
    expect(built).toHaveLength(2)
    expect(dead).toEqual(['siglip2-b16-224'])
  })

  it('dispose() cancels a build in flight: it is disposed on arrival, nothing leaks after shutdown', async () => {
    const { slot, built, release } = harness()
    const building = slot.ensure('siglip2-b16-224')
    await tick()
    const shutdown = slot.dispose()
    release('siglip2-b16-224')
    await expect(building).rejects.toThrow(/cancelled/)
    await shutdown
    expect(built[0]?.disposed).toBe(true)
    expect(slot.held()).toBeNull()
  })

  it('N crashes of the IMAGE tower put it in FAILED: refused by name, no further build', async () => {
    const errors: string[] = []
    const budget = new CrashBudget({
      tower: 'image',
      nodeId: () => 'agent-b',
      logger: { info: () => {}, error: (m: string) => errors.push(m) },
      maxCrashes: 2,
    })
    const { slot, built, release } = harness(() => {}, budget)
    for (let i = 0; i < 2; i++) {
      const p = slot.ensure('siglip2-b16-224')
      await tick()
      release('siglip2-b16-224')
      ;(await p).crashed = true
    }
    const refused = await slot.ensure('siglip2-b16-224').then(
      () => null,
      (err: unknown) => err,
    )
    expect(isEmbeddingModelFailed(refused)).toBe(true)
    expect(String(refused)).toMatch(/siglip2-b16-224 \(image tower\) crashed 2 times/)
    expect(String(refused)).toContain('agent-b')
    expect(built).toHaveLength(2)
    expect(errors).toHaveLength(1)
    // Another model is unaffected; a reset (model change / operator) re-arms it.
    budget.reset(undefined, 'model-change')
    const again = slot.ensure('siglip2-b16-224')
    await tick()
    release('siglip2-b16-224')
    await again
    expect(built).toHaveLength(3)
  })

  it('a LOAD that fails (initialize throws) spends the budget: N of them make the model FAILED', async () => {
    const budget = new CrashBudget({
      tower: 'image',
      nodeId: () => 'hub',
      logger: { info: () => {}, error: () => {} },
      maxCrashes: 2,
    })
    const { slot, built, release, failures } = harness(() => {}, budget)
    failures.load.add('siglip2-b16-224')
    for (let i = 0; i < 2; i++) {
      const p = slot.ensure('siglip2-b16-224')
      await tick()
      release('siglip2-b16-224')
      await expect(p).rejects.toThrow(/before ready/)
    }
    expect(built).toHaveLength(2)
    await expect(slot.ensure('siglip2-b16-224')).rejects.toThrow(/crashed 2 times.*load failed/)
    expect(built).toHaveLength(2) // refused before anything was constructed
  })

  it('a REQUIREMENTS failure (build throws: download, python) is refused by ITS name and spends NO budget', async () => {
    const errors: string[] = []
    const warns: string[] = []
    const infos: string[] = []
    const budget = new CrashBudget({
      tower: 'image',
      nodeId: () => 'hub',
      logger: { info: () => {}, error: (m: string) => errors.push(m) },
      maxCrashes: 2,
    })
    let now = 0
    const requirements = new RequirementsGate({
      tower: 'image',
      nodeId: () => 'hub',
      now: () => now,
      logger: {
        info: (m: string) => infos.push(m),
        warn: (m: string) => warns.push(m),
        error: () => {},
      },
    })
    const { slot, built, release, failures } = harness(() => {}, budget, requirements)
    failures.build.add('siglip2-b16-224')
    // A registry outage longer than every cooldown: many more ATTEMPTS than the budget allows.
    for (let i = 0; i < 5; i++) {
      const p = slot.ensure('siglip2-b16-224')
      await tick()
      release('siglip2-b16-224')
      const err = await p.then(
        () => null,
        (e: unknown) => e,
      )
      expect(embeddingRefusalOf(err)?.code).toBe(EMBEDDING_REQUIREMENTS_UNAVAILABLE)
      expect(String(err)).toContain('siglip2-b16-224 (image tower) on hub')
      expect(String(err)).toContain('registry unreachable')
      expect(isEmbeddingModelFailed(err)).toBe(false)
      now += 10 * 60_000 // past any cooldown: the next request is a real attempt
    }
    expect(budget.failed()).toEqual([]) // never entered the budget
    expect(errors).toEqual([]) // no FAILED transition
    expect(warns).toHaveLength(1) // ONE line at the transition, not five
    expect(requirements.pending()).toEqual(['siglip2-b16-224'])
    expect(built).toHaveLength(0) // nothing was ever constructed, let alone spawned
    // The outage ends: the next REQUEST builds normally, and the recovery is logged once.
    failures.build.delete('siglip2-b16-224')
    const ok = slot.ensure('siglip2-b16-224')
    await tick()
    release('siglip2-b16-224')
    await ok
    expect(built).toHaveLength(1)
    expect(requirements.pending()).toEqual([])
    expect(infos).toHaveLength(1)
  })

  it('a requirements failure is paced by REQUESTS: concurrent callers share one attempt, no timer retries', async () => {
    const { slot, built, release, failures } = harness()
    failures.build.add('siglip2-b16-224')
    const a = slot.ensure('siglip2-b16-224')
    const b = slot.ensure('siglip2-b16-224')
    await tick()
    release('siglip2-b16-224')
    await expect(a).rejects.toThrow(EMBEDDING_REQUIREMENTS_UNAVAILABLE)
    await expect(b).rejects.toThrow(EMBEDDING_REQUIREMENTS_UNAVAILABLE)
    // Nothing happens on its own: with no new request there is no new attempt.
    vi.useFakeTimers()
    try {
      await vi.advanceTimersByTimeAsync(60 * 60_000)
    } finally {
      vi.useRealTimers()
    }
    expect(built).toHaveLength(0)
  })

  it('inside the cooldown after a failed attempt, a request is refused at once and build() is NOT called (no download)', async () => {
    let now = 0
    const requirements = new RequirementsGate({
      tower: 'image',
      nodeId: () => 'hub',
      now: () => now,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    let buildCalls = 0
    const { slot, built, release, failures } = harness(
      () => {},
      undefined,
      requirements,
      () => {
        buildCalls++
      },
    )
    failures.build.add('siglip2-b16-224')
    const first = slot.ensure('siglip2-b16-224')
    await tick()
    release('siglip2-b16-224')
    await expect(first).rejects.toThrow(EMBEDDING_REQUIREMENTS_UNAVAILABLE)
    expect(buildCalls).toBe(1)
    // Track rate: many requests, one attempt.
    for (let i = 0; i < 20; i++) {
      const err = await slot.ensure('siglip2-b16-224').then(
        () => null,
        (e: unknown) => e,
      )
      expect(embeddingRefusalOf(err)?.code).toBe(EMBEDDING_REQUIREMENTS_UNAVAILABLE)
      expect(String(err)).toMatch(/retry in \d+s/)
    }
    expect(buildCalls).toBe(1)
    // The cooldown elapses and the outage is over: the next request builds.
    now += REQUIREMENTS_COOLDOWN_BASE_MS
    failures.build.delete('siglip2-b16-224')
    const ok = slot.ensure('siglip2-b16-224')
    await tick()
    release('siglip2-b16-224')
    await ok
    expect(buildCalls).toBe(2)
    expect(built).toHaveLength(1)
  })

  it('a PERMANENT requirements failure (404, unknown id, missing sibling) is terminal after N attempts: refused by its own code, nothing built, listed', async () => {
    let now = 0
    const errors: string[] = []
    const requirements = new RequirementsGate({
      tower: 'image',
      nodeId: () => 'agent-b',
      now: () => now,
      maxAttempts: 3,
      logger: { info: () => {}, warn: () => {}, error: (m: string) => errors.push(m) },
    })
    let buildCalls = 0
    const { slot, built, release, failures } = harness(
      () => {},
      undefined,
      requirements,
      () => {
        buildCalls++
      },
    )
    failures.permanent.add('siglip2-b16-224')
    let last: unknown = null
    for (let i = 0; i < 3; i++) {
      const p = slot.ensure('siglip2-b16-224')
      await tick()
      release('siglip2-b16-224')
      last = await p.then(
        () => null,
        (e: unknown) => e,
      )
      now += 10 * 60_000
    }
    expect(embeddingRefusalOf(last)?.code).toBe(EMBEDDING_REQUIREMENTS_FAILED)
    expect(buildCalls).toBe(3)
    expect(errors).toHaveLength(1)
    expect(requirements.failed()).toEqual([
      expect.objectContaining({ modelId: 'siglip2-b16-224', nodeId: 'agent-b', attempts: 3 }),
    ])
    // Forever after, without a reset: refused before build, however long we wait.
    now += 7 * 24 * 3_600_000
    await expect(slot.ensure('siglip2-b16-224')).rejects.toThrow(EMBEDDING_REQUIREMENTS_FAILED)
    expect(buildCalls).toBe(3)
    expect(built).toHaveLength(0)
    // The operator fixes the catalog and resets: the next request attempts again.
    failures.permanent.delete('siglip2-b16-224')
    expect(requirements.reset('siglip2-b16-224')).toEqual(['siglip2-b16-224'])
    const ok = slot.ensure('siglip2-b16-224')
    await tick()
    release('siglip2-b16-224')
    await ok
    expect(built).toHaveLength(1)
  })
})
