/**
 * D649: the text encoder encodes in the CLUSTER ROW's CLIP space, with the
 * token window, tokenizer and dimension that model's metadata names — never in
 * its own config's, and never truncating a vector to fit a guess.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ModelCatalogEntry } from '@camstack/types'
import { buildClipModelRegistry } from '../../../shared/clip/clip-model-registry.js'
import { CLIP_IMAGE_MODELS, CLIP_TEXT_MODELS } from '../../catalogs/embedding-models.js'
import { ActiveClipModel, ENCODER_ROW_TTL_MS } from '../active-clip-model.js'
import { CrashBudget } from '../crash-budget.js'
import { RequirementsGate } from '../model-requirements.js'
import {
  type ClipTextEngine,
  type ClipTextEngineSpec,
  ClipTextEngines,
  TEXT_ENGINE_IDLE_MS,
} from '../clip-text-engines.js'

/**
 * The production catalog holds ONE CLIP model (SigLIP2), but the tower set, its
 * eviction and the cluster-row switch are about SEVERAL. These two synthetic
 * 512-d models share one index and a 77-token window, and are injected into the
 * registry and text catalog under test — they exist nowhere in production.
 */
const FAKE_A = 'test-clip-a'
const FAKE_C = 'test-clip-c'

function fakeClipModel(id: string): {
  image: ModelCatalogEntry
  text: ModelCatalogEntry
} {
  return {
    image: {
      id,
      name: id,
      description: 'synthetic CLIP image model for tower-set tests',
      inputSize: { width: 256, height: 256 },
      labels: [],
      formats: { openvino: { url: `https://example.invalid/${id}.xml`, sizeMB: 1 } },
      clip: {
        textModelId: `${id}-text`,
        embeddingDim: 512,
        vectorIndex: 'object-clip-test',
        tokenizerFile: 'test-tokenizer.json',
        contextLength: 77,
        padId: 0,
        searchMinScore: 0.2,
      },
    },
    text: {
      id: `${id}-text`,
      name: `${id}-text`,
      description: 'synthetic CLIP text model for tower-set tests',
      inputSize: { width: 0, height: 0 },
      labels: [],
      formats: {
        onnx: {
          url: `https://example.invalid/${id}-text.onnx`,
          sizeMB: 1,
          files: ['test-tokenizer.json'],
        },
      },
    },
  }
}

const FAKES = [fakeClipModel(FAKE_A), fakeClipModel(FAKE_C)]
const TEST_CLIP_MODELS = buildClipModelRegistry([
  ...CLIP_IMAGE_MODELS,
  ...FAKES.map((f) => f.image),
])
const TEST_TEXT_MODELS: readonly ModelCatalogEntry[] = [
  ...CLIP_TEXT_MODELS,
  ...FAKES.map((f) => f.text),
]

/** A roomy budget for tests that are not ABOUT the budget. */
function testBudget(): CrashBudget {
  return new CrashBudget({
    tower: 'text',
    nodeId: () => 'hub',
    logger: { info: vi.fn(), error: vi.fn() },
    maxCrashes: 100,
  })
}

function testRequirements(): RequirementsGate {
  return new RequirementsGate({
    tower: 'text',
    nodeId: () => 'hub',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  })
}

function logger(): { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn() }
}

/** A fake tower returning `dim` floats, recording every build and dispose. */
function fakeEngines(dimFor: (spec: ClipTextEngineSpec) => number): {
  built: ClipTextEngineSpec[]
  disposed: string[]
  engines: ClipTextEngines
} {
  const built: ClipTextEngineSpec[] = []
  const disposed: string[] = []
  const engines = new ClipTextEngines({
    activeModelId: () => null,
    budget: testBudget(),
    requirements: testRequirements(),
    logger: logger(),
    registry: TEST_CLIP_MODELS,
    textCatalog: TEST_TEXT_MODELS,
    build: async (spec) => {
      built.push(spec)
      const engine: ClipTextEngine = {
        encode: async () => new Float32Array(dimFor(spec)).fill(0.5),
        dispose: async () => {
          disposed.push(spec.model.modelId)
        },
        getPid: () => 1,
        initialize: async () => {},
        getRequestCount: () => 0,
        isAlive: () => true,
      }
      return engine
    },
  })
  return { built, disposed, engines }
}

describe('ActiveClipModel — the cluster row, not the addon config', () => {
  it('answers the cluster row', async () => {
    const active = new ActiveClipModel({
      readRow: async () => 'siglip2-b16-224',
      fallbackModelId: () => FAKE_A,
      now: () => 0,
      logger: logger(),
    })
    expect(await active.get()).toBe('siglip2-b16-224')
  })

  it('a read that fails keeps the LAST row read, and only before any read the config (D49)', async () => {
    let row: string | null = null
    let now = 0
    const log = logger()
    const active = new ActiveClipModel({
      readRow: async () => row,
      fallbackModelId: () => FAKE_A,
      now: () => now,
      logger: log,
    })
    expect(await active.get()).toBe(FAKE_A) // nothing read yet
    expect(log.warn).toHaveBeenCalledTimes(1)
    row = 'siglip2-b16-224'
    expect(await active.get()).toBe('siglip2-b16-224')
    row = null
    now += ENCODER_ROW_TTL_MS + 1
    // The failed read must NOT swap the encoder back to its config.
    expect(await active.get()).toBe('siglip2-b16-224')
  })

  it('follows a flip once the TTL has passed, and not before', async () => {
    let row = FAKE_A
    let now = 0
    const active = new ActiveClipModel({
      readRow: async () => row,
      fallbackModelId: () => FAKE_A,
      now: () => now,
      logger: logger(),
    })
    expect(await active.get()).toBe(FAKE_A)
    row = 'siglip2-b16-224'
    now += ENCODER_ROW_TTL_MS - 1
    expect(await active.get()).toBe(FAKE_A)
    now += 2
    expect(await active.get()).toBe('siglip2-b16-224')
  })
})

describe('ClipTextEngines — one tower per model, built from its metadata', () => {
  it('builds SigLIP2 with ITS text model, 64-token window, pad 0 and tokenizer; 768 dims out', async () => {
    const { built, engines } = fakeEngines((spec) => spec.meta.embeddingDim)
    const { vector, model } = await engines.encode('siglip2-b16-224', 'a cat')
    expect(built).toHaveLength(1)
    expect(built[0]!.textEntry.id).toBe('siglip2-b16-224-text')
    expect(built[0]!.meta).toMatchObject({
      contextLength: 64,
      padId: 0,
      tokenizerFile: 'camstack-siglip2-b16-224-tokenizer.json',
    })
    expect(vector).toHaveLength(768)
    expect(model.meta.vectorIndex).toBe('object-clip-siglip2-b16-224')
  })

  it('a 512-d model keeps ITS OWN window and tokenizer: 77, pad 0, 512 dims', async () => {
    const { built, engines } = fakeEngines((spec) => spec.meta.embeddingDim)
    const { vector } = await engines.encode(FAKE_A, 'a cat')
    expect(built[0]!.meta).toMatchObject({
      contextLength: 77,
      padId: 0,
      tokenizerFile: 'test-tokenizer.json',
    })
    expect(vector).toHaveLength(512)
  })

  it('REFUSES an output whose length is not the model dimension — never truncates it', async () => {
    // The old encoder sliced 768 → 512 under another model's fallback meta.
    const { engines } = fakeEngines(() => 1024)
    await expect(engines.encode('siglip2-b16-224', 'a cat')).rejects.toThrow(/1024 dims.*768/)
  })

  it('refuses a model id with no CLIP metadata instead of falling back to a default model', async () => {
    const { built, engines } = fakeEngines(() => 512)
    await expect(engines.encode('arcface-r100', 'a cat')).rejects.toThrow(/no CLIP metadata/)
    expect(built).toHaveLength(0)
  })

  it('keeps two towers (a switch keeps the old index searchable) and evicts the coldest third', async () => {
    const { built, disposed, engines } = fakeEngines((spec) => spec.meta.embeddingDim)
    await engines.encode(FAKE_A, 'a')
    await engines.encode('siglip2-b16-224', 'b')
    await engines.encode(FAKE_A, 'c') // hit — the first model is now the hottest
    expect(built.map((b) => b.model.modelId)).toEqual([FAKE_A, 'siglip2-b16-224'])
    await engines.encode(FAKE_C, 'd')
    expect(disposed).toEqual(['siglip2-b16-224'])
    expect([...engines.live().keys()].toSorted()).toEqual([FAKE_A, FAKE_C])
  })

  it('two concurrent first queries spawn ONE engine', async () => {
    const { built, engines } = fakeEngines((spec) => spec.meta.embeddingDim)
    await Promise.all([
      engines.encode('siglip2-b16-224', 'a'),
      engines.encode('siglip2-b16-224', 'b'),
    ])
    expect(built).toHaveLength(1)
  })

  it('never evicts an engine with an encode in flight; the set shrinks once it drains', async () => {
    // A gated tower: its encode resolves only when released, and dispose()
    // fails it the way the real engine now does.
    const gates = new Map<string, () => void>()
    const disposed: string[] = []
    const engines = new ClipTextEngines({
      activeModelId: () => null,
      budget: testBudget(),
      requirements: testRequirements(),
      logger: logger(),
      registry: TEST_CLIP_MODELS,
      textCatalog: TEST_TEXT_MODELS,
      maxEngines: 1,
      build: async (spec) => {
        let fail: ((e: Error) => void) | null = null
        const engine: ClipTextEngine = {
          encode: () =>
            new Promise<Float32Array>((resolve, reject) => {
              fail = reject
              gates.set(spec.model.modelId, () => resolve(new Float32Array(spec.meta.embeddingDim)))
            }),
          dispose: async () => {
            disposed.push(spec.model.modelId)
            fail?.(new Error('disposed'))
          },
          getPid: () => 1,
          initialize: async () => {},
          getRequestCount: () => 0,
          isAlive: () => true,
        }
        return engine
      },
    })
    const slow = engines.encode(FAKE_A, 'a')
    await vi.waitFor(() => expect(gates.has(FAKE_A)).toBe(true))
    // A second model with the limit at 1: the busy first tower must survive.
    const other = engines.encode('siglip2-b16-224', 'b')
    await vi.waitFor(() => expect(gates.has('siglip2-b16-224')).toBe(true))
    expect(disposed).toEqual([])
    expect(engines.inFlight(FAKE_A)).toBe(1)
    gates.get(FAKE_A)!()
    await expect(slow).resolves.toMatchObject({ vector: expect.any(Float32Array) })
    // Drained: now it may go — the over-limit set shrinks back to 1.
    expect(disposed).toEqual([FAKE_A])
    gates.get('siglip2-b16-224')!()
    await other
  })

  it('an encode whose engine is restarted mid-flight (memory watchdog) REJECTS, never hangs', async () => {
    let fail: ((e: Error) => void) | null = null
    let started = false
    const engines = new ClipTextEngines({
      activeModelId: () => null,
      budget: testBudget(),
      requirements: testRequirements(),
      logger: logger(),
      registry: TEST_CLIP_MODELS,
      textCatalog: TEST_TEXT_MODELS,
      build: async () => ({
        encode: () =>
          new Promise<Float32Array>((_resolve, reject) => {
            fail = reject
            started = true
          }),
        dispose: async () => {
          fail?.(new Error('PythonTextEncoderEngine: disposed'))
        },
        getPid: () => 1,
        initialize: async () => {},
        getRequestCount: () => 0,
        isAlive: () => true,
      }),
    })
    const inFlight = engines.encode('siglip2-b16-224', 'a')
    await vi.waitFor(() => expect(started).toBe(true))
    await engines.restart('siglip2-b16-224')
    await expect(inFlight).rejects.toThrow(/disposed/)
    expect(engines.inFlight('siglip2-b16-224')).toBe(0)
  })

  it('a CRASHED tower is dropped and rebuilt: the next query does not hit the dead pipe', async () => {
    const log = logger()
    let alive = true
    let builds = 0
    const engines = new ClipTextEngines({
      activeModelId: () => null,
      budget: testBudget(),
      requirements: testRequirements(),
      logger: log,
      registry: TEST_CLIP_MODELS,
      textCatalog: TEST_TEXT_MODELS,
      build: async (spec) => {
        builds += 1
        alive = true
        const engine: ClipTextEngine = {
          encode: async () => {
            if (!alive) throw new Error('PythonTextEncoderEngine: engine is dead — process exited')
            return new Float32Array(spec.meta.embeddingDim)
          },
          dispose: async () => {},
          getPid: () => 1,
          initialize: async () => {},
          getRequestCount: () => 0,
          isAlive: () => alive,
        }
        return engine
      },
    })
    await engines.encode('siglip2-b16-224', 'a')
    alive = false // OOM kill
    await expect(engines.encode('siglip2-b16-224', 'b')).resolves.toMatchObject({
      vector: expect.any(Float32Array),
    })
    expect(builds).toBe(2)
    expect(log.warn).toHaveBeenCalledWith(
      'CLIP text tower died — dropping it and rebuilding',
      expect.objectContaining({ meta: expect.objectContaining({ modelId: 'siglip2-b16-224' }) }),
    )
  })

  it('evicts a tower idle past the bound, never a busy one, and logs it', async () => {
    let now = 0
    const log = logger()
    const disposed: string[] = []
    let releaseMc: (() => void) | null = null
    const engines = new ClipTextEngines({
      activeModelId: () => FAKE_C, // active, but no tower held
      budget: testBudget(),
      requirements: testRequirements(),
      logger: log,
      now: () => now,
      registry: TEST_CLIP_MODELS,
      textCatalog: TEST_TEXT_MODELS,
      build: async (spec) => ({
        encode: () =>
          spec.model.modelId === FAKE_A && releaseMc === null
            ? new Promise<Float32Array>((resolve) => {
                releaseMc = () => resolve(new Float32Array(spec.meta.embeddingDim))
              })
            : Promise.resolve(new Float32Array(spec.meta.embeddingDim)),
        dispose: async () => {
          disposed.push(spec.model.modelId)
        },
        getPid: () => 1,
        initialize: async () => {},
        getRequestCount: () => 0,
        isAlive: () => true,
      }),
    })
    // Both towers loaded and both past the bound — but the first tower is BUSY.
    await engines.encode('siglip2-b16-224', 'a')
    const busy = engines.encode(FAKE_A, 'b')
    await vi.waitFor(() => expect(releaseMc).not.toBeNull())
    now += TEXT_ENGINE_IDLE_MS - 1
    expect(await engines.evictIdle()).toEqual([])
    now += TEXT_ENGINE_IDLE_MS + 2
    expect(await engines.evictIdle()).toEqual(['siglip2-b16-224'])
    expect(disposed).toEqual(['siglip2-b16-224'])
    expect(engines.inFlight(FAKE_A)).toBe(1)
    releaseMc!()
    await busy
    expect(log.info).toHaveBeenCalledWith(
      'CLIP text tower evicted — idle',
      expect.objectContaining({ meta: expect.objectContaining({ modelId: 'siglip2-b16-224' }) }),
    )
  })

  it('re-checks busy RIGHT before each eviction: a query that starts mid-sweep keeps its tower', async () => {
    let now = 0
    const disposed: string[] = []
    let unblockFirstDispose: (() => void) | null = null
    let sigBusy: (() => void) | null = null
    const engines = new ClipTextEngines({
      activeModelId: () => FAKE_C, // active, but no tower held
      budget: testBudget(),
      requirements: testRequirements(),
      logger: logger(),
      now: () => now,
      registry: TEST_CLIP_MODELS,
      textCatalog: TEST_TEXT_MODELS,
      build: async (spec) => ({
        encode: () =>
          spec.model.modelId === 'siglip2-b16-224' && now > 0
            ? new Promise<Float32Array>((resolve) => {
                sigBusy = () => resolve(new Float32Array(spec.meta.embeddingDim))
              })
            : Promise.resolve(new Float32Array(spec.meta.embeddingDim)),
        dispose: () =>
          spec.model.modelId === FAKE_A
            ? new Promise<void>((resolve) => {
                unblockFirstDispose = () => {
                  disposed.push(spec.model.modelId)
                  resolve()
                }
              })
            : Promise.resolve().then(() => {
                disposed.push(spec.model.modelId)
              }),
        getPid: () => 1,
        initialize: async () => {},
        getRequestCount: () => 0,
        isAlive: () => true,
      }),
    })
    await engines.encode(FAKE_A, 'a') // coldest
    await engines.encode('siglip2-b16-224', 'b')
    now += TEXT_ENGINE_IDLE_MS + 1
    const sweep = engines.evictIdle() // both idle when the sweep starts
    await vi.waitFor(() => expect(unblockFirstDispose).not.toBeNull())
    // While the first tower's dispose is in progress, a query starts on SigLIP2.
    const query = engines.encode('siglip2-b16-224', 'c')
    await vi.waitFor(() => expect(sigBusy).not.toBeNull())
    unblockFirstDispose!()
    expect(await sweep).toEqual([FAKE_A])
    expect(disposed).toEqual([FAKE_A])
    sigBusy!()
    await query
  })

  describe("the ACTIVE model's tower is never idle-evicted (steady state as before D649)", () => {
    function sweepable(active: () => string | null): {
      engines: ClipTextEngines
      disposed: string[]
      advance: (ms: number) => void
    } {
      let now = 0
      const disposed: string[] = []
      const engines = new ClipTextEngines({
        activeModelId: active,
        budget: testBudget(),
        requirements: testRequirements(),
        logger: logger(),
        now: () => now,
        registry: TEST_CLIP_MODELS,
        textCatalog: TEST_TEXT_MODELS,
        build: async (spec) => ({
          encode: async () => new Float32Array(spec.meta.embeddingDim),
          dispose: async () => {
            disposed.push(spec.model.modelId)
          },
          getPid: () => 1,
          initialize: async () => {},
          getRequestCount: () => 0,
          isAlive: () => true,
        }),
      })
      return { engines, disposed, advance: (ms) => (now += ms) }
    }

    it("keeps the active model's tower past the idle bound", async () => {
      const { engines, disposed, advance } = sweepable(() => FAKE_A)
      await engines.encode(FAKE_A, 'a')
      advance(TEXT_ENGINE_IDLE_MS * 10)
      expect(await engines.evictIdle()).toEqual([])
      expect(disposed).toEqual([])
      expect([...engines.live().keys()]).toEqual([FAKE_A])
    })

    it('evicts an idle tower of a model that is NOT active', async () => {
      const { engines, disposed, advance } = sweepable(() => FAKE_A)
      await engines.encode(FAKE_A, 'a')
      await engines.encode('siglip2-b16-224', 'b') // an admin comparison
      advance(TEXT_ENGINE_IDLE_MS + 1)
      expect(await engines.evictIdle()).toEqual(['siglip2-b16-224'])
      expect(disposed).toEqual(['siglip2-b16-224'])
      expect([...engines.live().keys()]).toEqual([FAKE_A])
    })

    it('an UNKNOWN active model evicts nothing', async () => {
      const { engines, disposed, advance } = sweepable(() => null)
      await engines.encode(FAKE_A, 'a')
      await engines.encode('siglip2-b16-224', 'b')
      advance(TEXT_ENGINE_IDLE_MS * 10)
      expect(await engines.evictIdle()).toEqual([])
      expect(disposed).toEqual([])
    })

    it('ActiveClipModel.known() is null until a read succeeds, then the last row read', async () => {
      let row: string | null = null
      let now = 0
      const active = new ActiveClipModel({
        readRow: async () => row,
        fallbackModelId: () => FAKE_A,
        now: () => now,
        logger: logger(),
      })
      await active.get() // falls back to the config — a guess, not known
      expect(active.known()).toBeNull()
      row = 'siglip2-b16-224'
      now += ENCODER_ROW_TTL_MS + 1
      await active.get()
      row = null
      now += ENCODER_ROW_TTL_MS + 1
      await active.get() // a failed read keeps the last value (D49)
      expect(active.known()).toBe('siglip2-b16-224')
    })
  })

  it('disposeAll cancels a tower build in flight: disposed on arrival, never held', async () => {
    let finish: (() => void) | null = null
    const disposed: string[] = []
    const engines = new ClipTextEngines({
      activeModelId: () => null,
      budget: testBudget(),
      requirements: testRequirements(),
      logger: logger(),
      registry: TEST_CLIP_MODELS,
      textCatalog: TEST_TEXT_MODELS,
      build: (spec) =>
        new Promise<ClipTextEngine>((resolve) => {
          finish = () =>
            resolve({
              encode: async () => new Float32Array(spec.meta.embeddingDim),
              dispose: async () => {
                disposed.push(spec.model.modelId)
              },
              getPid: () => 1,
              initialize: async () => {},
              getRequestCount: () => 0,
              isAlive: () => true,
            })
        }),
    })
    const query = engines.encode('siglip2-b16-224', 'a')
    await vi.waitFor(() => expect(finish).not.toBeNull())
    const shutdown = engines.disposeAll()
    finish!()
    await expect(query).rejects.toThrow(/cancelled/)
    await shutdown
    expect(disposed).toEqual(['siglip2-b16-224'])
    expect(engines.live().size).toBe(0)
  })

  it("a failing eviction never replaces the encode's own result", async () => {
    // The first tower is busy while SigLIP2 loads (limit 1, so the set goes over);
    // when it drains, ITS encode's cleanup evicts it — and that dispose
    // throws. The encode must still resolve with its vector.
    const log = logger()
    let releaseMc: (() => void) | null = null
    const engines = new ClipTextEngines({
      activeModelId: () => null,
      budget: testBudget(),
      requirements: testRequirements(),
      logger: log,
      maxEngines: 1,
      registry: TEST_CLIP_MODELS,
      textCatalog: TEST_TEXT_MODELS,
      build: async (spec) => ({
        encode: () =>
          spec.model.modelId === FAKE_A
            ? new Promise<Float32Array>((resolve) => {
                releaseMc = () => resolve(new Float32Array(spec.meta.embeddingDim))
              })
            : Promise.resolve(new Float32Array(spec.meta.embeddingDim)),
        dispose: async () => {
          throw new Error('dispose exploded')
        },
        getPid: () => 1,
        initialize: async () => {},
        getRequestCount: () => 0,
        isAlive: () => true,
      }),
    })
    const mc = engines.encode(FAKE_A, 'a')
    await vi.waitFor(() => expect(releaseMc).not.toBeNull())
    await engines.encode('siglip2-b16-224', 'b')
    releaseMc!()
    await expect(mc).resolves.toMatchObject({ vector: expect.any(Float32Array) })
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith('CLIP text tower eviction failed', expect.anything()),
    )
  })
})

describe('ClipTextEngines — a REQUIREMENTS failure is not a crash (D649 round 4, D6)', () => {
  it('a build that throws (download, python) is refused by ITS name, spends no budget, logs once, and recovers on the next request', async () => {
    const budgetErrors: string[] = []
    const budget = new CrashBudget({
      tower: 'text',
      nodeId: () => 'hub',
      logger: { info: vi.fn(), error: (m: string) => budgetErrors.push(m) },
      maxCrashes: 2,
    })
    const reqLog = { ...logger(), error: vi.fn() }
    let now = 0
    const requirements = new RequirementsGate({
      tower: 'text',
      nodeId: () => 'hub',
      now: () => now,
      logger: reqLog,
    })
    let outage = true
    const engines = new ClipTextEngines({
      activeModelId: () => null,
      budget,
      requirements,
      logger: logger(),
      registry: TEST_CLIP_MODELS,
      textCatalog: TEST_TEXT_MODELS,
      build: async (spec) => {
        if (outage) throw new Error('ModelDownloadService: hub unreachable')
        const engine: ClipTextEngine = {
          initialize: async () => {},
          encode: async () => new Float32Array(spec.meta.embeddingDim).fill(0.5),
          dispose: async () => {},
          getPid: () => 1,
          getRequestCount: () => 0,
          isAlive: () => true,
        }
        return engine
      },
    })
    for (let i = 0; i < 5; i++) {
      if (i > 0) now += 10 * 60_000 // past any cooldown: every request here is a real attempt
      await expect(engines.encode('siglip2-b16-224', 'a van')).rejects.toThrow(
        /\[embedding-requirements-unavailable model=siglip2-b16-224 tower=text node=hub\] siglip2-b16-224 \(text tower\) on hub: ModelDownloadService: hub unreachable/,
      )
    }
    expect(budget.failed()).toEqual([])
    expect(budgetErrors).toEqual([])
    expect(reqLog.warn).toHaveBeenCalledTimes(1)
    expect(engines.live().size).toBe(0)
    // The outage ends INSIDE the cooldown: still refused, and nothing is built.
    outage = false
    await expect(engines.encode('siglip2-b16-224', 'a van')).rejects.toThrow(/retry in \d+s/)
    expect(engines.live().size).toBe(0)
    now += 10 * 60_000
    await engines.encode('siglip2-b16-224', 'a van')
    expect(engines.live().size).toBe(1)
    expect(reqLog.info).toHaveBeenCalledWith(
      'CLIP model requirements available again',
      expect.objectContaining({
        meta: expect.objectContaining({ modelId: 'siglip2-b16-224', refused: 6, attempts: 5 }),
      }),
    )
  })
})
