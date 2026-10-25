import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  IAddonModelManager,
  IEmbeddingEncoderProvider,
  ModelCatalogEntry,
  PoolMemoryTelemetry,
  ProviderRegistration,
} from '@camstack/types'
import {
  BaseAddon,
  PoolMemoryWatchdog,
  embeddingEncoderCapability,
  normalizeNodeId,
  resolvePoolMemoryPolicy,
} from '@camstack/types'
import { readProcessMemory } from '../shared/process-memory.js'

type EmbeddingEncodeOutput = Awaited<ReturnType<IEmbeddingEncoderProvider['encode']>>
type EmbeddingInfoOutput = Awaited<ReturnType<IEmbeddingEncoderProvider['getInfo']>>

// eslint-disable-next-line no-restricted-imports -- ModelDownloadService is a build-time dep, not a runtime addon coupling
import { ModelDownloadService } from '@camstack/system/addon-utils'
import {
  CLIP_EMBEDDING_STEP_ID,
  resolveClusterModelPin,
} from '../../pipeline-analytics/cluster-model-pin.js'
import { BUILTIN_CLIP_MODELS, DEFAULT_CLIP_MODEL } from '../../shared/clip/clip-model-registry.js'
import { CLIP_IMAGE_MODELS, CLIP_TEXT_MODELS } from '../catalogs/embedding-models.js'
import { PythonRawTensorEngine } from '../shared/python-raw-tensor-engine.js'
import { PythonTextEncoderEngine } from '../shared/python-text-encoder-engine.js'
import { ActiveClipModel } from './active-clip-model.js'
import { CrashBudget } from './crash-budget.js'
import {
  clearFailedOnModelChange,
  type EncoderTowers,
  type FailedModelsReset,
  reportFailedModels,
  reportFailedRequirements,
  resetFailedModelsOn,
} from './failed-models-report.js'
import { ModelEngineSlot } from './model-engine-slot.js'
import { PermanentRequirementsFailure, RequirementsGate } from './model-requirements.js'
import { l2Normalize, preprocessForClip } from './clip-preprocessing.js'
import {
  type ClipTextEngine,
  type ClipTextEngineSpec,
  ClipTextEngines,
} from './clip-text-engines.js'

/**
 * Embedding encoder uses two separate engines (image + text) with custom
 * CLIP preprocessing — cannot use BaseVisionAddon which assumes single engine + JPEG input.
 *
 * Uses IRawTensorEngine for ONNX (custom tensor preprocessing). The ONNX
 * inference runs in the embedded portable Python (PythonRawTensorEngine) — the
 * platform ships no Node ONNX runtime.
 */
/**
 * The addon's only operator setting.
 *
 * There is no runtime or backend selector: inference ALWAYS runs the ONNX
 * graph in the embedded portable Python (`PythonRawTensorEngine` /
 * `PythonTextEncoderEngine`) — the platform ships no Node ONNX runtime and
 * no CUDA/CoreML embedding path. Two selects promising exactly that shipped
 * here until 2026-08-28 (D272); their only reference was a `withTags` log
 * field, so an operator picking "CUDA" got a differently-labelled log line
 * and the same CPU inference.
 */
interface EmbeddingConfig {
  modelId: string
}

/** Memory-watchdog key prefix of a text tower; the suffix is its CLIP model id. */
const TEXT_ENGINE_KEY_PREFIX = 'clip-text:'

/** How often idle text towers are looked for (see `TEXT_ENGINE_IDLE_MS`). */
const IDLE_SWEEP_MS = 60_000

/** A model URL answering one of these does not exist; retrying changes nothing. */
const PERMANENT_HTTP_STATUS: ReadonlySet<number> = new Set([404, 410])

export default class EmbeddingEncoderAddon
  extends BaseAddon<EmbeddingConfig>
  implements IEmbeddingEncoderProvider
{
  /**
   * Everything on this node that can be terminally refused (`failed-models-report.ts`):
   * the respawn budgets per tower (D6, `crash-budget.ts`) and the requirements
   * gates (`model-requirements.ts` — cooldown, and terminal for what can never
   * be met). All in memory: a runner respawn starts them from zero. Every row
   * and refusal names this node.
   */
  private readonly towers: EncoderTowers = {
    budgets: {
      image: new CrashBudget({
        tower: 'image',
        nodeId: () => this.localNodeId(),
        logger: {
          info: (message, extras) => this.ctx.logger.info(message, extras),
          error: (message, extras) => this.ctx.logger.error(message, extras),
        },
      }),
      text: new CrashBudget({
        tower: 'text',
        nodeId: () => this.localNodeId(),
        logger: {
          info: (message, extras) => this.ctx.logger.info(message, extras),
          error: (message, extras) => this.ctx.logger.error(message, extras),
        },
      }),
    },
    requirements: {
      image: new RequirementsGate({
        tower: 'image',
        nodeId: () => this.localNodeId(),
        logger: {
          info: (message, extras) => this.ctx.logger.info(message, extras),
          warn: (message, extras) => this.ctx.logger.warn(message, extras),
          error: (message, extras) => this.ctx.logger.error(message, extras),
        },
      }),
      text: new RequirementsGate({
        tower: 'text',
        nodeId: () => this.localNodeId(),
        logger: {
          info: (message, extras) => this.ctx.logger.info(message, extras),
          warn: (message, extras) => this.ctx.logger.warn(message, extras),
          error: (message, extras) => this.ctx.logger.error(message, extras),
        },
      }),
    },
  }
  /** The image tower, one model at a time, single-flight per model (`model-engine-slot.ts`). */
  private readonly imageEngine = new ModelEngineSlot<PythonRawTensorEngine>(
    (modelId) => this.buildImageEngine(modelId),
    this.towers.budgets.image,
    this.towers.requirements.image,
    (modelId) =>
      this.ctx.logger.warn('CLIP image tower died — dropping it and rebuilding', {
        meta: { modelId },
      }),
  )
  /** One text tower per CLIP model, bounded (see `clip-text-engines.ts`). */
  private readonly textEngines = new ClipTextEngines({
    registry: BUILTIN_CLIP_MODELS,
    textCatalog: CLIP_TEXT_MODELS,
    build: (spec) => this.buildTextEngine(spec),
    budget: this.towers.budgets.text,
    requirements: this.towers.requirements.text,
    // Declared below; read lazily, at sweep time only.
    activeModelId: () => this.activeModel.known(),
    logger: {
      info: (message, extras) => this.ctx.logger.info(message, extras),
      warn: (message, extras) => this.ctx.logger.warn(message, extras),
    },
  })
  /** Disposes NON-active text towers idle for `TEXT_ENGINE_IDLE_MS` (never prefetched). */
  private idleSweep: ReturnType<typeof setInterval> | null = null
  private warnedUnknownConfigModel = false
  /** The cluster row's CLIP model — what an unnamed request encodes in (D649). */
  private readonly activeModel = new ActiveClipModel({
    readRow: () => this.readClusterRow(),
    // A stored config naming a removed id (`mobileclip-s0/s1/s2`) falls
    // back to the default rather than to a model nobody can load — and says
    // so, once per process, so a node still configured with a retired model is
    // visible rather than silently overridden (D871).
    fallbackModelId: () => {
      if (BUILTIN_CLIP_MODELS.resolve(this.config.modelId) !== null) return this.config.modelId
      if (!this.warnedUnknownConfigModel) {
        this.warnedUnknownConfigModel = true
        this.ctx.logger.warn('CLIP encoder config names a model that is not in the catalog', {
          meta: { configured: this.config.modelId, using: DEFAULT_CLIP_MODEL },
        })
      }
      return DEFAULT_CLIP_MODEL
    },
    now: () => Date.now(),
    logger: {
      info: (message, extras) => this.ctx.logger.info(message, extras),
      warn: (message, extras) => this.ctx.logger.warn(message, extras),
    },
    // The row naming a model is a fresh start for THAT model's towers only
    // (D6: the exits from `failed` are this, the operator's resetFailedModels,
    // and a runner respawn). The model the row left keeps its state — see
    // `clearFailedOnModelChange`.
    onChange: (modelId) => {
      clearFailedOnModelChange(this.towers, modelId)
    },
  })

  private models: IAddonModelManager | null = null

  /**
   * RSS bound + periodic memory telemetry for the two Python engines
   * (`raw_tensor_inference.py` — one of the four leaking pools in the
   * 2026-08-18 OOM audit — and `text_encoder_inference.py`). Shared
   * watchdog from `@camstack/types`; a restart here is dispose + null, and
   * the next encode lazily re-resolves the engine (the exact recovery an
   * operator model change already uses). Started in `onInitialize`,
   * stopped in `onShutdown`.
   */
  private memoryGuard: PoolMemoryWatchdog | null = null

  constructor() {
    super({ modelId: DEFAULT_CLIP_MODEL })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const modelsDir = await this.resolveModelsDir()
    // Seed the download service with the CLIP image + text catalogs so
    // `models.ensure(id, 'onnx')` can resolve every encoder model. An empty
    // catalog makes EVERY `ensure()` throw `unknown model "<id>"` — this broke
    // the text tower (`siglip2-b16-224-text`), surfaced by `searchObjectEvents`
    // → `encodeText`, and leaves the image tower (`siglip2-b16-224`) equally
    // unresolvable from this source.
    this.models = new ModelDownloadService(modelsDir, [...CLIP_IMAGE_MODELS, ...CLIP_TEXT_MODELS])

    // RSS bound + periodic `pool memory` line for the two Python engines
    // (see the field doc). Sweeps no-op while an engine is not spawned.
    this.memoryGuard = new PoolMemoryWatchdog({
      policy: resolvePoolMemoryPolicy(process.env),
      log: this.ctx.logger.child('pool-memory'),
      sample: () => this.sampleEngineMemory(),
      restart: (key) => this.restartEngineForMemory(key),
    })
    this.memoryGuard.start()
    this.idleSweep = setInterval(() => {
      this.textEngines.evictIdle().catch((err: unknown) => {
        this.ctx.logger.warn('CLIP text tower idle sweep failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }, IDLE_SWEEP_MS)
    this.idleSweep.unref?.()

    return [{ capability: embeddingEncoderCapability, provider: this }]
  }

  /** Watchdog sample: one telemetry row per live Python engine. A pid the
   *  read cannot see is logged, never silently skipped. */
  private async sampleEngineMemory(): Promise<readonly PoolMemoryTelemetry[]> {
    const engines: readonly {
      readonly key: string
      readonly modelId: string | null
      readonly pid: number | null
      readonly requests: number
    }[] = [
      {
        key: 'clip-image',
        modelId: this.imageEngine.held()?.modelId ?? null,
        pid: this.imageEngine.held()?.engine.getPid() ?? null,
        requests: this.imageEngine.held()?.engine.getRequestCount() ?? 0,
      },
      ...[...this.textEngines.live()].map(([modelId, engine]) => ({
        key: `${TEXT_ENGINE_KEY_PREFIX}${modelId}`,
        modelId,
        pid: engine.getPid(),
        requests: engine.getRequestCount(),
      })),
    ]
    const out: PoolMemoryTelemetry[] = []
    for (const engine of engines) {
      if (engine.pid === null) continue // engine not spawned — nothing to bound
      const mem = await readProcessMemory(engine.pid)
      if (!mem) {
        this.ctx.logger.warn('embedding engine memory sample dropped', {
          meta: { poolKey: engine.key, pid: engine.pid },
        })
        continue
      }
      const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024))
      out.push({
        key: engine.key,
        pids: [engine.pid],
        rssBytes: mem.rssBytes,
        meta: {
          modelId: engine.modelId,
          vmMb: mb(mem.vmBytes),
          peakRssMb: mb(mem.hwmBytes),
          swapMb: mb(mem.swapBytes),
          threads: mem.threads,
          requestsServed: engine.requests,
        },
      })
    }
    return out
  }

  /** Watchdog restart: dispose + null; the next encode re-resolves lazily
   *  through the single-flight ensure. An in-flight encode fails once — its
   *  callers are the retry-until-landed bulk passes (D58) and RPCs that
   *  surface errors, never silent loss. */
  private async restartEngineForMemory(key: string): Promise<void> {
    if (key === 'clip-image') {
      await this.imageEngine.dispose()
      return
    }
    if (key.startsWith(TEXT_ENGINE_KEY_PREFIX)) {
      await this.textEngines.restart(key.slice(TEXT_ENGINE_KEY_PREFIX.length))
    }
  }

  /** The cluster row's `clip-embedding` model, or `null` when unreadable. */
  private async readClusterRow(): Promise<string | null> {
    return resolveClusterModelPin(this.ctx.api, CLIP_EMBEDDING_STEP_ID, {
      warn: (message, extras) => this.ctx.logger.warn(message, extras),
    })
  }

  async encode(input: {
    crop: Uint8Array
    width: number
    height: number
  }): Promise<EmbeddingEncodeOutput> {
    const { crop, width, height } = input
    const model = this.textEngines.requireModel(await this.activeModel.get())
    const imageEngine = await this.imageEngine.ensure(model.modelId)
    const meta = model.meta
    const start = Date.now()

    // ONNX path (embedded Python) — custom CLIP preprocessing + raw tensor engine
    const cropBuffer = Buffer.isBuffer(crop) ? crop : Buffer.from(crop)
    const preprocessed = preprocessForClip(
      cropBuffer,
      width,
      height,
      model.inputSize,
      model.inputSize,
    )
    const output = await imageEngine.run(preprocessed, [1, 3, model.inputSize, model.inputSize])
    if (output.length !== meta.embeddingDim) {
      throw new Error(
        `EmbeddingEncoder: ${model.modelId} image tower produced ${String(output.length)} dims, ` +
          `its metadata declares ${String(meta.embeddingDim)}`,
      )
    }
    const normalized = l2Normalize(new Float32Array(output))

    return {
      embedding: Array.from(normalized),
      inferenceMs: Date.now() - start,
    }
  }

  /**
   * Encode a query in ONE model's space: the named `modelId`, else the cluster
   * row's (D649). The token window, pad id, tokenizer and dimension all come
   * from that model's catalog metadata.
   */
  async encodeText(input: { text: string; modelId?: string }): Promise<EmbeddingEncodeOutput> {
    const modelId = input.modelId ?? (await this.activeModel.get())
    const start = Date.now()
    const { vector } = await this.textEngines.encode(modelId, input.text)
    return {
      embedding: Array.from(l2Normalize(new Float32Array(vector))),
      inferenceMs: Date.now() - start,
    }
  }

  /** THIS node's answer — the cap is one provider per node (see the cap's docblock). */
  async getInfo(): Promise<EmbeddingInfoOutput> {
    const model = this.textEngines.requireModel(await this.activeModel.get())
    const nodeId = this.localNodeId()
    return {
      modelId: model.modelId,
      embeddingDim: model.meta.embeddingDim,
      ready: this.imageEngine.held()?.modelId === model.modelId,
      nodeId,
      failedModels: [...reportFailedModels(this.towers.budgets)],
      failedRequirements: [...reportFailedRequirements(this.towers.requirements)],
    }
  }

  /** The operator's explicit clear of THIS node's `failed` state (D6); names the node. */
  async resetFailedModels(input: { modelId?: string }): Promise<FailedModelsReset> {
    return resetFailedModelsOn(this.localNodeId(), this.towers, input.modelId)
  }

  /** The logical node (a forked child's `<node>/<addon>` id stripped to the node). */
  private localNodeId(): string {
    return normalizeNodeId(this.ctx.kernel?.localNodeId)
  }

  /**
   * The REQUIREMENTS stage, shared by both towers: the embedded Python, its
   * requirements, then the model file (downloaded on first use). Anything that
   * throws here is refused as `model-requirements-unavailable` and spends no
   * crash budget (`model-requirements.ts`). The runtime is asked for first —
   * the cheap question before the 185–565 MB download (D54's rule).
   */
  private async prepareOnnx(
    entry: ModelCatalogEntry,
  ): Promise<{ modelPath: string; pythonPath: string; pythonDir: string }> {
    const pythonPath = await this.ctx.deps.ensurePython()
    if (!pythonPath) {
      throw new Error(
        'EmbeddingEncoder: embedded Python is unavailable — cannot run ONNX embeddings. ' +
          'ctx.deps.ensurePython() returned null (portable Python download likely failed).',
      )
    }
    const pythonDir = resolveEmbeddingPythonDir()
    await this.ctx.deps.installPythonRequirements(
      path.join(pythonDir, 'requirements-embedding.txt'),
    )
    // ONNX is the only embedding format. A catalog entry WITHOUT an onnx build
    // (the CLIP image entries since 2026-08-21) is a requirement no download
    // meets: permanent, decided by the entry's STRUCTURE before any download —
    // never by the downloader's "has no onnx format" wording.
    if (entry.formats.onnx === undefined) {
      throw new PermanentRequirementsFailure(
        `EmbeddingEncoder: ${entry.id} has no onnx build in its catalog entry ` +
          `(formats: ${Object.keys(entry.formats).join(', ') || 'none'}) — no download can supply it`,
      )
    }
    // A server that ANSWERS "not there"
    // (404/410) is a requirement no retry meets — marked permanent for the
    // gate by STATUS, never by the message; an unreachable server is not.
    let modelPath: string
    try {
      modelPath = await this.models!.ensure(entry.id, 'onnx')
    } catch (err: unknown) {
      const status = downloadHttpStatusOf(err)
      if (status !== null && PERMANENT_HTTP_STATUS.has(status)) {
        throw new PermanentRequirementsFailure(
          `EmbeddingEncoder: ${entry.id} is not at its catalog URL (HTTP ${String(status)}) — fix the catalog entry`,
        )
      }
      throw err
    }
    return { modelPath, pythonPath, pythonDir }
  }

  private async buildImageEngine(modelId: string): Promise<PythonRawTensorEngine> {
    const entry = CLIP_IMAGE_MODELS.find((m) => m.id === modelId)
    if (!entry) {
      throw new PermanentRequirementsFailure(
        `EmbeddingEncoderAddon: unknown image model "${modelId}" — not in the CLIP image catalog`,
      )
    }
    const { modelPath, pythonPath, pythonDir } = await this.prepareOnnx(entry)
    const scriptPath = path.join(pythonDir, 'raw_tensor_inference.py')
    const engineLogger = this.ctx.logger.withTags({ modelId: entry.id })
    // Constructed, not started: `initialize()` is the slot's call (engine stage).
    return new PythonRawTensorEngine(pythonPath, scriptPath, modelPath, engineLogger)
  }

  /**
   * One text tower. Tokenization happens IN Python via the HF `tokenizers`
   * library, with the tokenizer the model's metadata names — a declared sibling
   * of the text onnx, so `ModelDownloadService.ensure()` fetched it next to the
   * model file — and the model's own token window.
   */
  private async buildTextEngine(spec: ClipTextEngineSpec): Promise<ClipTextEngine> {
    const { modelPath, pythonPath, pythonDir } = await this.prepareOnnx(spec.textEntry)
    const tokenizerPath = path.join(path.dirname(modelPath), spec.meta.tokenizerFile)
    if (!fs.existsSync(tokenizerPath)) {
      // The model file landed but its declared sibling did not: permanent.
      throw new PermanentRequirementsFailure(
        `EmbeddingEncoder: tokenizer not found at "${tokenizerPath}" — ` +
          `the ${spec.meta.tokenizerFile} sibling download of ${spec.textEntry.id} likely failed.`,
      )
    }
    // Constructed, not started: `initialize()` is the holder's call (engine stage).
    return new PythonTextEncoderEngine(
      pythonPath,
      path.join(pythonDir, 'text_encoder_inference.py'),
      modelPath,
      tokenizerPath,
      { contextLength: spec.meta.contextLength, padId: spec.meta.padId },
      this.ctx.logger.withTags({ modelId: spec.textEntry.id }),
    )
  }

  protected async onShutdown(): Promise<void> {
    this.memoryGuard?.stop()
    if (this.idleSweep !== null) clearInterval(this.idleSweep)
    this.idleSweep = null
    this.memoryGuard = null
    await this.imageEngine.dispose()
    await this.textEngines.disposeAll()
  }

  // ── Three-level settings API (Phase 3) ──────────────────────────────

  protected globalSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'embedding-encoder-settings',
          title: 'Embedding Encoder',
          columns: 2,
          fields: [
            {
              type: 'text',
              key: 'modelId',
              label: 'Fallback model ID',
              description:
                'Used only until the cluster "Semantic search model" row has been read once. The encoder follows that row.',
              default: DEFAULT_CLIP_MODEL,
            },
          ],
        },
      ],
    })
  }

  protected async onConfigChanged(): Promise<void> {
    // Config already updated by BaseAddon.resolveConfig(). The model in force is
    // the cluster row's; engines follow it on the next request.
  }
}

/**
 * Locate the addon's bundled `python/` dir (holds `raw_tensor_inference.py` +
 * `requirements-embedding.txt`). Published package first, then `__dirname`
 * candidates for the in-tree dev build.
 */
function resolveEmbeddingPythonDir(): string {
  const candidates: string[] = []
  try {
    const pkgPath = require.resolve('@camstack/addon-post-analysis/package.json')
    candidates.push(path.join(path.dirname(pkgPath), 'python'))
  } catch {
    // not resolvable in-tree before npm install
  }
  candidates.push(
    path.join(__dirname, '../../python'),
    path.join(__dirname, '../../../python'),
    path.join(__dirname, '../python'),
    path.join(__dirname, '../../../../python'),
  )
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'raw_tensor_inference.py'))) return c
  }
  throw new Error(
    `EmbeddingEncoder: python/ dir (raw_tensor_inference.py) not found. Searched:\n${candidates.join('\n')}`,
  )
}

/**
 * HTTP status of a model-download failure, recognised by SHAPE (`name` +
 * numeric `status`), never by `instanceof` or a framework import.
 * `@camstack/system` is host-resolved (not bundled), so importing a guard it
 * only exports from a newer server would stop this whole entry from linking
 * on a node still running the older server — a deploy-order hazard for a
 * one-line classification. `null` = not an HTTP answer (unreachable, other).
 */
function downloadHttpStatusOf(err: unknown): number | null {
  if (
    err instanceof Error &&
    err.name === 'ModelDownloadHttpError' &&
    'status' in err &&
    typeof err.status === 'number'
  ) {
    return err.status
  }
  return null
}
