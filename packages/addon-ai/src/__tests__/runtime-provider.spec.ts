import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  ILlmRuntimeProvider,
  LlmGenerateResult,
  LlmRuntimeCompleteInput,
  LlmRuntimeStatus,
  ManagedRuntimeConfig,
  ModelCatalogEntry,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LlmCallRequest, LlmClient } from '../client/llm-client.js'
import type { LlamaStartConfig, LlamaSupervisor } from '../runtime/llama-supervisor.js'
import { createLlmRuntimeProvider, type RuntimeModelOps } from '../runtime/runtime-provider.js'
import { makeTestLogger } from './support/logger.js'

function runtimeCfg(catalogId = 'llm-qwen2.5-1.5b-instruct-q4'): ManagedRuntimeConfig {
  return {
    nodeId: 'hub',
    engine: 'llama-cpp',
    model: { kind: 'catalog', catalogId },
    contextSize: 4096,
    gpuLayers: 0,
    parallel: 1,
    flashAttention: false,
    mlock: false,
    noMmap: false,
    extraArgs: [],
    autoStart: false,
    idleStopMinutes: 30,
  }
}

class FakeSupervisor {
  starts: LlamaStartConfig[] = []
  private _port: number | undefined
  private _state: LlmRuntimeStatus['state'] = 'stopped'
  loadedModelPath: string | undefined
  activities = 0

  async start(cfg: LlamaStartConfig): Promise<LlmRuntimeStatus> {
    this.starts.push(cfg)
    this._port = 18080
    this._state = 'ready'
    this.loadedModelPath = cfg.modelPath
    return this.status()
  }
  async stop(): Promise<void> {
    this._state = 'stopped'
    this._port = undefined
  }
  status(): LlmRuntimeStatus {
    return {
      nodeId: 'hub',
      state: this._state,
      ...(this.loadedModelPath !== undefined ? { modelPath: this.loadedModelPath } : {}),
      crashesInWindow: 0,
    }
  }
  noteActivity(): void {
    this.activities++
  }
  get port(): number | undefined {
    return this._port
  }
}

function fakeModelOps(overrides: Partial<RuntimeModelOps> & { downloaded?: Set<string> } = {}): {
  ops: RuntimeModelOps
  ensured: ModelCatalogEntry[]
  deleted: ModelCatalogEntry[]
} {
  const downloaded = overrides.downloaded ?? new Set<string>()
  const ensured: ModelCatalogEntry[] = []
  const deleted: ModelCatalogEntry[] = []
  const ops: RuntimeModelOps = {
    ensure: async (entry, onProgress) => {
      ensured.push(entry)
      onProgress({
        file: 'a.gguf',
        fileIndex: 1,
        fileCount: 1,
        downloadedBytes: 50,
        totalBytes: 100,
      })
      onProgress({
        file: 'a.gguf',
        fileIndex: 1,
        fileCount: 1,
        downloadedBytes: 100,
        totalBytes: 100,
      })
      downloaded.add(entry.id)
      return `/models/${entry.id}.gguf`
    },
    isDownloaded: (entry) => downloaded.has(entry.id),
    pathFor: (entry) => `/models/${entry.id}.gguf`,
    delete: async (entry) => {
      deleted.push(entry)
      downloaded.delete(entry.id)
    },
    extraFilePath: (_entry, filename) => `/models/${filename}`,
    ...overrides,
  }
  return { ops, ensured, deleted }
}

/**
 * The node-side transport, scripted. `calls[i].request.profile.providerConfig.baseUrl` is what
 * used to be asserted as a plan URL — same fact, one layer up.
 */
function scriptedClient(result?: LlmGenerateResult): {
  client: LlmClient
  calls: LlmCallRequest[]
} {
  const calls: LlmCallRequest[] = []
  const client: LlmClient = {
    supports: (kind) => kind === 'openai' || kind === 'openai-compatible',
    generate: async (request) => {
      calls.push(request)
      return (
        result ?? {
          ok: true,
          text: 'local answer',
          model: 'q',
          usage: { inputTokens: 3, outputTokens: 2 },
          truncated: false,
          latencyMs: 1,
        }
      )
    },
    openStream: async () => ({ kind: 'unsupported' }),
  }
  return { client, calls }
}

function provider(opts: {
  supervisor: FakeSupervisor
  modelOps: RuntimeModelOps
  client: LlmClient
  modelsDir: string
  fileSha256?: (filePath: string) => Promise<string>
}): ILlmRuntimeProvider {
  return createLlmRuntimeProvider({
    nodeId: 'hub',
    modelsDir: opts.modelsDir,
    ensureBinary: async () => '/bin/llama-server',
    supervisor: opts.supervisor as unknown as LlamaSupervisor,
    modelOps: opts.modelOps,
    client: opts.client,
    logger: makeTestLogger(),
    ...(opts.fileSha256 !== undefined ? { fileSha256: opts.fileSha256 } : {}),
  })
}

const completeInput = (runtime = runtimeCfg()): LlmRuntimeCompleteInput => ({
  consumer: 'adhoc-ui',
  prompt: 'q',
  runtime,
})

let modelsDir: string
beforeEach(async () => {
  modelsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'llm-models-'))
})
afterEach(async () => {
  await fsp.rm(modelsDir, { recursive: true, force: true })
})

describe('llm-runtime provider', () => {
  it('complete with the model NOT installed → unavailable naming model + node, supervisor never started', async () => {
    const supervisor = new FakeSupervisor()
    const { ops } = fakeModelOps()
    const p = provider({
      supervisor,
      modelOps: ops,
      client: scriptedClient().client,
      modelsDir,
    })
    const result = await p.complete(completeInput())
    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
    if (!result.ok) {
      expect(result.message).toContain('llm-qwen2.5-1.5b-instruct-q4')
      expect(result.message).toContain('hub')
    }
    expect(supervisor.starts).toHaveLength(0)
  })

  it('complete with the model installed → starts supervisor, dispatches local wire, notes activity', async () => {
    const supervisor = new FakeSupervisor()
    const { ops } = fakeModelOps({ downloaded: new Set(['llm-qwen2.5-1.5b-instruct-q4']) })
    const { client, calls } = scriptedClient()
    const p = provider({ supervisor, modelOps: ops, client, modelsDir })
    const result = await p.complete(completeInput())
    expect(result).toMatchObject({ ok: true, text: 'local answer' })
    expect(supervisor.starts).toHaveLength(1)
    expect(calls[0]!.profile.providerConfig.baseUrl).toBe('http://127.0.0.1:18080/v1')
    expect(supervisor.activities).toBe(1)
  })

  // Was pinned to SmolVLM2, which left the catalogue on 2026-09-02 (its GGUF
  // was sixteen months old and 44% of the download was projector, on a weight
  // class Qwen3-VL-2B already covers). Repointed at the 2B rather than deleted:
  // the claim is that a vision entry threads its mmproj into the start config,
  // and that is true of whichever vision entry is asked for.
  it('vision entry threads the mmproj path into the start config', async () => {
    const supervisor = new FakeSupervisor()
    const { ops } = fakeModelOps({ downloaded: new Set(['llm-qwen3-vl-2b-instruct-q4']) })
    const { client } = scriptedClient()
    const p = provider({ supervisor, modelOps: ops, client, modelsDir })
    await p.complete(completeInput(runtimeCfg('llm-qwen3-vl-2b-instruct-q4')))
    expect(supervisor.starts[0]!.mmprojPath).toContain('mmproj-F16.gguf')
  })

  it('ensureStarted with a missing model → stopped + lastError, no start', async () => {
    const supervisor = new FakeSupervisor()
    const { ops } = fakeModelOps()
    const p = provider({
      supervisor,
      modelOps: ops,
      client: scriptedClient().client,
      modelsDir,
    })
    const status = await p.ensureStarted({ runtime: runtimeCfg() })
    expect(status.state).toBe('stopped')
    expect(status.lastError).toContain('not installed')
    expect(supervisor.starts).toHaveLength(0)
  })

  it('installModel(catalog) ensures the entry and surfaces progress', async () => {
    const supervisor = new FakeSupervisor()
    const { ops, ensured } = fakeModelOps()
    const p = provider({
      supervisor,
      modelOps: ops,
      client: scriptedClient().client,
      modelsDir,
    })
    await p.installModel({ model: { kind: 'catalog', catalogId: 'llm-qwen2.5-1.5b-instruct-q4' } })
    expect(ensured[0]!.id).toBe('llm-qwen2.5-1.5b-instruct-q4')
  })

  it('installModel(url) with sha mismatch deletes + throws', async () => {
    const supervisor = new FakeSupervisor()
    const { ops, deleted } = fakeModelOps()
    const p = provider({
      supervisor,
      modelOps: ops,
      client: scriptedClient().client,
      modelsDir,
      fileSha256: async () => 'actualdigest',
    })
    await expect(
      p.installModel({ model: { kind: 'url', url: 'http://x/m.gguf', sha256: 'deadbeef' } }),
    ).rejects.toThrow(/sha256/i)
    expect(deleted).toHaveLength(1)
  })

  it('listLocalModels lists *.gguf files with sizes, back-mapping catalog ids', async () => {
    const supervisor = new FakeSupervisor()
    const { ops } = fakeModelOps()
    await fsp.writeFile(path.join(modelsDir, 'qwen2.5-1.5b-instruct-q4_k_m.gguf'), 'x'.repeat(100))
    await fsp.writeFile(path.join(modelsDir, 'random.gguf'), 'y'.repeat(10))
    await fsp.writeFile(path.join(modelsDir, 'not-a-model.txt'), 'z')
    const p = provider({
      supervisor,
      modelOps: ops,
      client: scriptedClient().client,
      modelsDir,
    })
    const models = await p.listLocalModels({})
    expect(models.map((m) => m.file).sort()).toEqual([
      'qwen2.5-1.5b-instruct-q4_k_m.gguf',
      'random.gguf',
    ])
    const qwen = models.find((m) => m.file.startsWith('qwen'))
    expect(qwen?.catalogId).toBe('llm-qwen2.5-1.5b-instruct-q4')
    expect(qwen?.sizeBytes).toBe(100)
  })

  it('deleteModel refuses a loaded file, deletes otherwise', async () => {
    const supervisor = new FakeSupervisor()
    supervisor.loadedModelPath = '/models/loaded.gguf'
    const { ops } = fakeModelOps()
    await fsp.writeFile(path.join(modelsDir, 'loaded.gguf'), 'x')
    await fsp.writeFile(path.join(modelsDir, 'other.gguf'), 'y')
    const p = provider({
      supervisor,
      modelOps: ops,
      client: scriptedClient().client,
      modelsDir,
    })
    await expect(p.deleteModel({ file: 'loaded.gguf' })).rejects.toThrow()
    await p.deleteModel({ file: 'other.gguf' })
    const remaining = await fsp.readdir(modelsDir)
    expect(remaining).toContain('loaded.gguf')
    expect(remaining).not.toContain('other.gguf')
  })

  it('getDiskUsage sums gguf bytes', async () => {
    const supervisor = new FakeSupervisor()
    const { ops } = fakeModelOps()
    await fsp.writeFile(path.join(modelsDir, 'a.gguf'), 'x'.repeat(50))
    await fsp.writeFile(path.join(modelsDir, 'b.gguf'), 'y'.repeat(70))
    const p = provider({
      supervisor,
      modelOps: ops,
      client: scriptedClient().client,
      modelsDir,
    })
    const usage = await p.getDiskUsage({})
    expect(usage.modelsBytes).toBe(120)
  })
})
