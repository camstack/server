/**
 * `llm-runtime` provider — the node-side managed executor. Reuses the
 * object-detection model plane (ensureModel/isModelDownloaded/delete via the
 * injected `RuntimeModelOps`) for GGUF artifacts, the `LlamaSupervisor` for the
 * llama-server child, and the SHARED {@link LlmClient} for the local inference
 * wire (only lifecycle + locality differ — spec §2). GGUFs are
 * multi-GB, so a missing model is an EXPLICIT-install error, never an auto-pull.
 * Usage rows are written hub-side only (single accounting point).
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type {
  ILlmRuntimeProvider,
  IScopedLogger,
  LlmDownloadProgress,
  LlmGenerateResult,
  LlmNodeModel,
  LlmProfile,
  LlmRuntimeCompleteInput,
  LlmRuntimeDiskUsage,
  LlmRuntimeStatus,
  ManagedModelRef,
  ManagedRuntimeConfig,
  ModelCatalogEntry,
} from '@camstack/types'
import { LlmTimeoutDefaults } from '@camstack/types'
import type { LlmClient } from '../client/llm-client.js'
import type { AppleFmBackend } from './apple/afm-backend.js'
import { CancelRegistry } from './cancel-registry.js'
import { checkExtraArgs, type LlamaStartConfig, type LlamaSupervisor } from './llama-supervisor.js'
import { shardInfoOf } from './hf-ref.js'
import { catalogById, entryForRef, LLM_MODEL_CATALOG } from './llm-model-catalog.js'
import { type ProjectorScan, scanExtraFiles } from './mmproj.js'
import { fileSha256 as defaultFileSha256 } from './sha256.js'

/** Where a multi-file GGUF install currently is; see `model-ops.planFiles`. */
export interface ModelDownloadProgress {
  readonly file: string
  readonly fileIndex: number
  readonly fileCount: number
  /** Across the whole install, not the current file. */
  readonly downloadedBytes: number
  readonly totalBytes?: number
}

export interface RuntimeModelOps {
  ensure(
    entry: ModelCatalogEntry,
    onProgress: (progress: ModelDownloadProgress) => void,
  ): Promise<string>
  isDownloaded(entry: ModelCatalogEntry): boolean
  pathFor(entry: ModelCatalogEntry): string
  delete(entry: ModelCatalogEntry): Promise<void>
  extraFilePath(entry: ModelCatalogEntry, filename: string): string
}

/** The slice of `LlamaSupervisor` this provider drives — a seam, so a test
 *  can supply one without a cast. */
export type RuntimeSupervisor = Pick<
  LlamaSupervisor,
  'start' | 'stop' | 'status' | 'noteActivity' | 'port'
>

export interface LlmRuntimeProviderDeps {
  readonly nodeId: string
  readonly modelsDir: string
  readonly ensureBinary: () => Promise<string>
  readonly supervisor: RuntimeSupervisor
  readonly modelOps: RuntimeModelOps
  readonly client: LlmClient
  readonly logger: IScopedLogger
  /** Injectable for tests; defaults to the streamed file sha256. */
  readonly fileSha256?: (filePath: string) => Promise<string>
  /** Apple Foundation Models on this node. Absent = never wired (answers unknown). */
  readonly apple?: AppleFmBackend
}

/** What the shared client answers when its caller's signal aborts. */
const CANCELLED_RESULT: LlmGenerateResult = {
  ok: false,
  code: 'timeout',
  message: 'the call was cancelled',
}

function basename(url: string): string {
  const clean = url.split('?')[0] ?? url
  return clean.slice(clean.lastIndexOf('/') + 1)
}

function catalogIdForFile(file: string): string | undefined {
  return LLM_MODEL_CATALOG.find((m) => basename(m.meta.url) === file)?.meta.id
}

/**
 * The projector among the extra files — matched by NAME (`mmproj` as a token
 * anywhere in it, `mmproj.ts`), not by position.
 *
 * `extraFiles[0]` was safe while the only extra a GGUF entry ever had was an
 * mmproj. A split GGUF puts shards 2..N in the same list, so index 0 is now
 * routinely a weights shard, and passing one to `--mmproj` starts llama-server
 * against a file that is not a projector.
 */
function projectorScan(entry: ModelCatalogEntry): ProjectorScan {
  return scanExtraFiles(entry.extraFiles, (name) => shardInfoOf(name) !== null)
}

/** A catalogue entry that is SOLD as vision: launching it without a projector is a defect, not a choice. */
function declaresVision(model: ManagedModelRef): boolean {
  return model.kind === 'catalog' && catalogById(model.catalogId)?.meta.purpose === 'vision'
}

function gb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`
}

export function createLlmRuntimeProvider(deps: LlmRuntimeProviderDeps): ILlmRuntimeProvider {
  let downloadProgress: number | undefined
  let download: LlmDownloadProgress | undefined
  /** `llm.cancel` forwarded from the hub lands here, by `requestId`. */
  const cancels = new CancelRegistry()

  /** Model ids whose projector gap was already logged by this provider: once per model, not per call. */
  const projectorGapsReported = new Set<string>()

  /**
   * D391: a launch that silently drops vision is a branch that accepts work
   * and produces nothing. Say so — once per model — when a vision catalogue
   * entry has no projector, or when an extra file is neither a projector nor
   * a shard (an unrecognised projector is exactly how vision used to vanish).
   */
  function reportProjectorGap(modelId: string, scan: ProjectorScan, visionDeclared: boolean): void {
    const missingProjector = scan.projector === undefined && visionDeclared
    if (!missingProjector && scan.unrecognised.length === 0) return
    if (projectorGapsReported.has(modelId)) return
    projectorGapsReported.add(modelId)
    deps.logger.warn(
      scan.projector === undefined
        ? 'llm model launches WITHOUT vision: no multimodal projector (mmproj) among its files'
        : 'llm model has extra files that are neither its projector nor a shard; they are not passed to llama-server',
      {
        meta: {
          nodeId: deps.nodeId,
          modelId,
          visionDeclared,
          ...(scan.projector !== undefined ? { projector: scan.projector } : {}),
          unrecognised: scan.unrecognised,
        },
      },
    )
  }

  async function resolvePaths(
    runtime: ManagedRuntimeConfig,
  ): Promise<{ modelId: string; modelPath: string; mmprojPath?: string }> {
    const resolution = entryForRef(runtime.model)
    if (resolution === null) throw new Error('unknown model reference')
    const { entry, localPathOverride } = resolution
    const modelPath = localPathOverride ?? deps.modelOps.pathFor(entry)
    const scan = projectorScan(entry)
    reportProjectorGap(entry.id, scan, declaresVision(runtime.model))
    const mmproj = scan.projector
    return {
      modelId: entry.id,
      modelPath,
      ...(mmproj !== undefined ? { mmprojPath: deps.modelOps.extraFilePath(entry, mmproj) } : {}),
    }
  }

  function installedGuard(
    runtime: ManagedRuntimeConfig,
  ): { ok: true } | { ok: false; message: string } {
    const resolution = entryForRef(runtime.model)
    if (resolution === null) return { ok: false, message: 'unknown model reference' }
    if (resolution.localPathOverride !== undefined) return { ok: true }
    if (!deps.modelOps.isDownloaded(resolution.entry)) {
      return {
        ok: false,
        message: `model ${resolution.entry.id} not installed on node ${deps.nodeId}`,
      }
    }
    return { ok: true }
  }

  async function ensureStartedInternal(runtime: ManagedRuntimeConfig): Promise<LlmRuntimeStatus> {
    // Before the binary, before the model: a duplicated flag is a config error
    // and must not cost a download or a spawn to discover.
    const argCheck = checkExtraArgs(runtime.extraArgs)
    if (!argCheck.ok) throw new Error(argCheck.message)
    const binaryPath = await deps.ensureBinary()
    const paths = await resolvePaths(runtime)
    const startCfg: LlamaStartConfig = {
      nodeId: deps.nodeId,
      modelId: paths.modelId,
      modelPath: paths.modelPath,
      ...(paths.mmprojPath !== undefined ? { mmprojPath: paths.mmprojPath } : {}),
      contextSize: runtime.contextSize,
      gpuLayers: runtime.gpuLayers,
      ...(runtime.threads !== undefined ? { threads: runtime.threads } : {}),
      parallel: runtime.parallel,
      ...(runtime.batchSize !== undefined ? { batchSize: runtime.batchSize } : {}),
      ...(runtime.ubatchSize !== undefined ? { ubatchSize: runtime.ubatchSize } : {}),
      flashAttention: runtime.flashAttention,
      mlock: runtime.mlock,
      noMmap: runtime.noMmap,
      ...(runtime.cacheTypeK !== undefined ? { cacheTypeK: runtime.cacheTypeK } : {}),
      ...(runtime.cacheTypeV !== undefined ? { cacheTypeV: runtime.cacheTypeV } : {}),
      extraArgs: runtime.extraArgs,
      idleStopMinutes: runtime.idleStopMinutes,
      binaryPath,
    }
    return deps.supervisor.start(startCfg)
  }

  /**
   * sha256 every artifact whose digest the reference pinned — the main file
   * AND the extras.
   *
   * Verifying only the main file was the gap: a truncated or swapped mmproj is
   * exactly as fatal to llama-server as a bad weights file, and a resolved HF
   * reference carries a digest for every artifact (LFS `oid`) so there is no
   * reason to check one and trust the rest.
   *
   * This pass reads tens of GB and takes minutes; it is a REPORTED phase, not
   * a silent tail, because a progress bar frozen at 100% is the shape of a
   * hang.
   */
  async function verifyDigests(
    entry: ModelCatalogEntry,
    model: ManagedModelRef,
    startedAt: number,
  ): Promise<void> {
    if (model.kind !== 'url') return
    const targets: Array<{ filePath: string; sha256: string; name: string }> = []
    if (model.sha256 !== undefined) {
      targets.push({
        filePath: deps.modelOps.pathFor(entry),
        sha256: model.sha256,
        name: basename(model.url),
      })
    }
    for (const extra of model.extraFiles ?? []) {
      if (extra.sha256 === undefined) continue
      targets.push({
        filePath: deps.modelOps.extraFilePath(entry, extra.filename),
        sha256: extra.sha256,
        name: extra.filename,
      })
    }
    if (targets.length === 0) return

    const sha256 = deps.fileSha256 ?? defaultFileSha256
    for (const [index, target] of targets.entries()) {
      download = {
        phase: 'verifying',
        file: target.name,
        fileIndex: index + 1,
        fileCount: targets.length,
        downloadedBytes: 0,
      }
      deps.logger.info('llm model verifying digest', {
        meta: { nodeId: deps.nodeId, modelId: entry.id, file: target.name },
      })
      const digest = await sha256(target.filePath)
      if (digest !== target.sha256) {
        deps.logger.error('llm model digest mismatch; discarding the download', {
          meta: {
            nodeId: deps.nodeId,
            modelId: entry.id,
            file: target.name,
            expected: target.sha256,
            actual: digest,
            elapsedMs: Date.now() - startedAt,
          },
        })
        await deps.modelOps.delete(entry)
        await fsp.rm(target.filePath, { force: true })
        throw new Error(
          `sha256 mismatch for ${target.name}: expected ${target.sha256}, got ${digest}`,
        )
      }
    }
  }

  function status(): LlmRuntimeStatus {
    const base = deps.supervisor.status()
    return {
      ...base,
      nodeId: deps.nodeId,
      ...(downloadProgress !== undefined ? { downloadProgress } : {}),
      ...(download !== undefined ? { download } : {}),
    }
  }

  async function completeOnLocalServer(
    input: LlmRuntimeCompleteInput,
    signal: AbortSignal,
  ): Promise<LlmGenerateResult> {
    await ensureStartedInternal(input.runtime)
    if (signal.aborted) return CANCELLED_RESULT
    const port = deps.supervisor.port
    if (port === undefined) {
      return { ok: false, code: 'unavailable', message: 'llama-server has no port' }
    }
    const paths = await resolvePaths(input.runtime)
    const timeoutMs = input.timeoutMs ?? 120_000
    // An ephemeral profile describing the child we just started. It goes
    // through the SAME client as every other openai-compatible endpoint —
    // a llama-server on loopback is not a special wire, and routing it here
    // is what gives the managed path structured output and abort for free.
    const localProfile: LlmProfile = {
      id: 'managed-local',
      name: 'managed-local',
      kind: 'openai-compatible',
      addonId: 'ai',
      enabled: true,
      model: paths.modelId,
      providerConfig: { baseUrl: `http://127.0.0.1:${String(port)}/v1` },
      supportsVision: paths.mmprojPath !== undefined,
      timeoutMs,
      connectTimeoutMs: LlmTimeoutDefaults.connectMs,
      firstTokenTimeoutMs: LlmTimeoutDefaults.firstTokenMs,
      idleTimeoutMs: LlmTimeoutDefaults.idleMs,
      // The node-side call is already the innermost hop; a retry here would
      // stack under whatever the hub decided. The hub owns retry policy.
      retry: { enabled: false, maxAttempts: 1 },
      toolsEnabled: false,
    }
    const result = await deps.client.generate(
      {
        profile: localProfile,
        ...(input.system !== undefined ? { system: input.system } : {}),
        prompt: input.prompt,
        ...(input.images !== undefined ? { images: input.images } : {}),
        ...(input.jsonSchema !== undefined ? { jsonSchema: input.jsonSchema } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.topP !== undefined ? { topP: input.topP } : {}),
        ...(input.topK !== undefined ? { topK: input.topK } : {}),
        signal,
      },
      timeoutMs,
    )
    deps.supervisor.noteActivity()
    return result
  }

  return {
    complete: async (input: LlmRuntimeCompleteInput) => {
      const guard = installedGuard(input.runtime)
      if (!guard.ok) return { ok: false, code: 'unavailable', message: guard.message }
      // Registered BEFORE the boot: a cancel that lands while llama-server is
      // still loading must stop the generation it would otherwise start.
      const handle = cancels.begin(input.requestId)
      try {
        // Tombstoned before it arrived: not worth a cold multi-GB model load.
        if (handle.signal.aborted) return CANCELLED_RESULT
        return await completeOnLocalServer(input, handle.signal)
      } finally {
        handle.end()
      }
    },

    cancel: async ({ requestId }) => {
      if (cancels.cancel(requestId)) {
        deps.logger.debug('llm-runtime generation cancelled by its caller', {
          meta: { nodeId: deps.nodeId, requestId },
        })
      }
    },

    appleAvailability: async () =>
      deps.apple?.availability() ?? {
        state: 'unknown',
        error: 'the Apple backend is not wired on this node',
      },

    completeApple: async (input) => {
      if (deps.apple === undefined) {
        return {
          ok: false,
          code: 'unavailable',
          message: 'the Apple backend is not wired on this node',
        }
      }
      const handle = cancels.begin(input.requestId)
      try {
        if (handle.signal.aborted) return CANCELLED_RESULT
        return await deps.apple.complete(input, handle.signal)
      } finally {
        handle.end()
      }
    },

    ensureStarted: async ({ runtime }) => {
      const guard = installedGuard(runtime)
      if (!guard.ok) {
        return {
          nodeId: deps.nodeId,
          state: 'stopped',
          lastError: guard.message,
          crashesInWindow: 0,
        }
      }
      return ensureStartedInternal(runtime)
    },

    stop: async () => {
      await deps.supervisor.stop()
    },

    status: async () => status(),

    /**
     * Install a model on THIS node.
     *
     * Loud on purpose. This is the longest-running operation the addon has —
     * tens of minutes for a 23 GB vision model — and until now it emitted not
     * one log line, so an install that stalled on a gated URL or a full disk
     * was indistinguishable from one that was simply slow. Every phase
     * transition is a line, and every line carries the node.
     */
    installModel: async ({ model }: { model: ManagedModelRef }) => {
      const resolution = entryForRef(model)
      if (resolution === null) throw new Error('unknown model reference')
      if (resolution.localPathOverride !== undefined) {
        deps.logger.info('llm model is pre-provisioned; nothing to download', {
          meta: { nodeId: deps.nodeId, path: resolution.localPathOverride },
        })
        return
      }
      const { entry } = resolution
      const declaredBytes = model.kind === 'url' ? model.sizeBytes : undefined
      const startedAt = Date.now()
      deps.logger.info('llm model install started', {
        meta: {
          nodeId: deps.nodeId,
          modelId: entry.id,
          url: entry.formats.gguf?.url,
          extraFiles: (entry.extraFiles ?? []).map((f) => f.filename),
          ...(declaredBytes !== undefined
            ? { declaredBytes, declaredSize: gb(declaredBytes) }
            : {}),
        },
      })
      downloadProgress = 0
      download = {
        phase: 'downloading',
        file: '',
        fileIndex: 0,
        fileCount: 0,
        downloadedBytes: 0,
      }
      let lastLoggedDecile = -1
      try {
        await deps.modelOps.ensure(entry, (progress) => {
          const fraction =
            progress.totalBytes !== undefined && progress.totalBytes > 0
              ? Math.min(1, progress.downloadedBytes / progress.totalBytes)
              : undefined
          downloadProgress = fraction
          download = {
            phase: 'downloading',
            file: progress.file,
            fileIndex: progress.fileIndex,
            fileCount: progress.fileCount,
            downloadedBytes: progress.downloadedBytes,
            ...(progress.totalBytes !== undefined ? { totalBytes: progress.totalBytes } : {}),
          }
          // One line per 10%: enough to see movement in a log tail without
          // writing a line per chunk of a 23 GB file.
          const decile = fraction === undefined ? -1 : Math.floor(fraction * 10)
          if (decile > lastLoggedDecile) {
            lastLoggedDecile = decile
            deps.logger.info('llm model download progress', {
              meta: {
                nodeId: deps.nodeId,
                modelId: entry.id,
                file: progress.file,
                fileIndex: progress.fileIndex,
                fileCount: progress.fileCount,
                downloadedBytes: progress.downloadedBytes,
                downloaded: gb(progress.downloadedBytes),
                ...(progress.totalBytes !== undefined ? { total: gb(progress.totalBytes) } : {}),
              },
            })
          }
        })
        await verifyDigests(entry, model, startedAt)
        deps.logger.info('llm model install complete', {
          meta: {
            nodeId: deps.nodeId,
            modelId: entry.id,
            elapsedMs: Date.now() - startedAt,
          },
        })
      } catch (err) {
        deps.logger.error('llm model install failed', {
          meta: {
            nodeId: deps.nodeId,
            modelId: entry.id,
            elapsedMs: Date.now() - startedAt,
            error: err instanceof Error ? err.message : String(err),
          },
        })
        throw err
      } finally {
        downloadProgress = undefined
        download = undefined
      }
    },

    deleteModel: async ({ file }: { file: string }) => {
      const loaded = deps.supervisor.status().modelPath
      if (loaded !== undefined && basename(loaded) === file) {
        throw new Error(`cannot delete ${file}: loaded by the running runtime`)
      }
      await fsp.rm(path.join(deps.modelsDir, file), { force: true })
    },

    listLocalModels: async (): Promise<LlmNodeModel[]> => {
      const files = await listGgufFiles(deps.modelsDir)
      return files.map((f) => {
        const catalogId = catalogIdForFile(f.file)
        return {
          file: f.file,
          sizeBytes: f.sizeBytes,
          path: path.join(deps.modelsDir, f.file),
          ...(catalogId !== undefined ? { catalogId } : {}),
        }
      })
    },

    getDiskUsage: async (): Promise<LlmRuntimeDiskUsage> => {
      const files = await listGgufFiles(deps.modelsDir)
      const modelsBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0)
      return { nodeId: deps.nodeId, modelsBytes }
    },
  }
}

async function listGgufFiles(dir: string): Promise<Array<{ file: string; sizeBytes: number }>> {
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return []
  }
  const out: Array<{ file: string; sizeBytes: number }> = []
  for (const name of names) {
    if (!name.endsWith('.gguf')) continue
    try {
      const stat = await fsp.stat(path.join(dir, name))
      out.push({ file: name, sizeBytes: stat.size })
    } catch {
      // ignore
    }
  }
  return out
}
