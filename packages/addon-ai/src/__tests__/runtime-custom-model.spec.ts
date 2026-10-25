/**
 * What a CUSTOM (Hugging Face) model reference changes on the node: the extra
 * artifacts it drags along, the digests that must all be checked, and the
 * "additional arguments" box that must never fight the typed fields.
 *
 * No network, no child process — the supervisor and the model ops are fakes.
 */
import type {
  LlmRuntimeStatus,
  ManagedModelRef,
  ManagedRuntimeConfig,
  ModelCatalogEntry,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { LlmClient } from '../client/llm-client.js'
import {
  buildLlamaArgs,
  checkExtraArgs,
  type LlamaStartConfig,
  type LlamaSupervisor,
} from '../runtime/llama-supervisor.js'
import {
  createLlmRuntimeProvider,
  type ModelDownloadProgress,
  type RuntimeModelOps,
} from '../runtime/runtime-provider.js'
import { createTestLogger, type TestLoggerHandle } from './support/logger.js'

const SHA_MAIN = '1'.repeat(64)
const SHA_PROJ = '2'.repeat(64)
const SHA_SHARD = '3'.repeat(64)

/** What `llm.resolveModelRef` hands back for a sharded vision model. */
function customRef(
  overrides: Partial<Extract<ManagedModelRef, { kind: 'url' }>> = {},
): ManagedModelRef {
  return {
    kind: 'url',
    url: 'https://huggingface.co/acme/X-GGUF/resolve/main/X-00001-of-00002.gguf',
    sha256: SHA_MAIN,
    label: 'X-GGUF · UD-Q4_K_M',
    sizeBytes: 1_000,
    extraFiles: [
      {
        url: 'https://huggingface.co/acme/X-GGUF/resolve/main/X-00002-of-00002.gguf',
        filename: 'X-00002-of-00002.gguf',
        sizeBytes: 500,
        sha256: SHA_SHARD,
      },
      {
        url: 'https://huggingface.co/acme/X-GGUF/resolve/main/mmproj-F16.gguf',
        filename: 'mmproj-F16.gguf',
        sizeBytes: 200,
        sha256: SHA_PROJ,
      },
    ],
    ...overrides,
  }
}

function runtimeCfg(
  model: ManagedModelRef,
  extraArgs: readonly string[] = [],
): ManagedRuntimeConfig {
  return {
    nodeId: 'hub',
    engine: 'llama-cpp',
    model,
    contextSize: 4096,
    gpuLayers: 0,
    parallel: 1,
    flashAttention: false,
    mlock: false,
    noMmap: false,
    extraArgs: [...extraArgs],
    autoStart: false,
    idleStopMinutes: 30,
  }
}

class FakeSupervisor {
  starts: LlamaStartConfig[] = []
  async start(cfg: LlamaStartConfig): Promise<LlmRuntimeStatus> {
    this.starts.push(cfg)
    return this.status()
  }
  async stop(): Promise<void> {}
  status(): LlmRuntimeStatus {
    return { nodeId: 'hub', state: 'stopped', crashesInWindow: 0 }
  }
  noteActivity(): void {}
  get port(): number | undefined {
    return 18080
  }
}

interface Harness {
  readonly provider: ReturnType<typeof createLlmRuntimeProvider>
  readonly supervisor: FakeSupervisor
  readonly deleted: ModelCatalogEntry[]
  readonly digested: string[]
  readonly progress: ModelDownloadProgress[]
  readonly logs: TestLoggerHandle
}

function harness(opts: { digests?: Readonly<Record<string, string>> } = {}): Harness {
  const supervisor = new FakeSupervisor()
  const deleted: ModelCatalogEntry[] = []
  const digested: string[] = []
  const progress: ModelDownloadProgress[] = []
  const logs = createTestLogger()
  const ops: RuntimeModelOps = {
    ensure: async (entry, onProgress) => {
      onProgress({ file: 'X-00001-of-00002.gguf', fileIndex: 1, fileCount: 3, downloadedBytes: 10 })
      progress.push({
        file: 'X-00001-of-00002.gguf',
        fileIndex: 1,
        fileCount: 3,
        downloadedBytes: 10,
      })
      return `/models/${entry.id}.gguf`
    },
    isDownloaded: () => true,
    pathFor: () => '/models/X-00001-of-00002.gguf',
    delete: async (entry) => {
      deleted.push(entry)
    },
    extraFilePath: (_entry, filename) => `/models/${filename}`,
  }
  const provider = createLlmRuntimeProvider({
    nodeId: 'hub',
    modelsDir: '/models',
    ensureBinary: async () => '/bin/llama-server',
    supervisor: supervisor as unknown as LlamaSupervisor,
    modelOps: ops,
    client: {} as unknown as LlmClient,
    logger: logs.logger,
    fileSha256: async (filePath: string) => {
      digested.push(filePath)
      return opts.digests?.[filePath] ?? SHA_MAIN
    },
  })
  return { provider, supervisor, deleted, digested, progress, logs }
}

describe('installModel with a resolved Hugging Face reference', () => {
  it('verifies the digest of EVERY artifact, not only the main file', async () => {
    const h = harness({
      digests: {
        '/models/X-00001-of-00002.gguf': SHA_MAIN,
        '/models/X-00002-of-00002.gguf': SHA_SHARD,
        '/models/mmproj-F16.gguf': SHA_PROJ,
      },
    })
    await h.provider.installModel({ model: customRef() })
    expect(h.digested).toEqual([
      '/models/X-00001-of-00002.gguf',
      '/models/X-00002-of-00002.gguf',
      '/models/mmproj-F16.gguf',
    ])
    expect(h.deleted).toEqual([])
  })

  it('discards the install when a COMPANION digest is wrong', async () => {
    // A truncated mmproj is exactly as fatal to llama-server as bad weights,
    // and checking only the main file would have shipped it.
    const h = harness({
      digests: {
        '/models/X-00001-of-00002.gguf': SHA_MAIN,
        '/models/X-00002-of-00002.gguf': SHA_SHARD,
        '/models/mmproj-F16.gguf': 'deadbeef',
      },
    })
    await expect(h.provider.installModel({ model: customRef() })).rejects.toThrow(
      /sha256 mismatch for mmproj-F16\.gguf/,
    )
    expect(h.deleted).toHaveLength(1)
  })

  it('clears the download status even when the install throws', async () => {
    const h = harness({ digests: { '/models/X-00001-of-00002.gguf': 'nope' } })
    await expect(h.provider.installModel({ model: customRef() })).rejects.toThrow()
    const status = await h.provider.status({})
    expect(status.download).toBeUndefined()
    expect(status.downloadProgress).toBeUndefined()
  })

  it('passes the mmproj to llama-server by NAME, not by list position', async () => {
    // `extraFiles[0]` is a weights SHARD here. Taking index 0 would hand
    // `--mmproj` a file that is not a projector.
    const h = harness({
      digests: {
        '/models/X-00001-of-00002.gguf': SHA_MAIN,
        '/models/X-00002-of-00002.gguf': SHA_SHARD,
        '/models/mmproj-F16.gguf': SHA_PROJ,
      },
    })
    await h.provider.ensureStarted({ runtime: runtimeCfg(customRef()) })
    expect(h.supervisor.starts[0]?.mmprojPath).toBe('/models/mmproj-F16.gguf')
  })

  it('passes a projector whose name CONTAINS the mmproj token (Prism ML shape)', async () => {
    const h = harness()
    const ref = customRef({
      extraFiles: [
        {
          url: 'https://huggingface.co/acme/X-GGUF/resolve/main/X-00002-of-00002.gguf',
          filename: 'X-00002-of-00002.gguf',
          sizeBytes: 500,
        },
        {
          url: 'https://huggingface.co/acme/X-GGUF/resolve/main/X-mmproj-Q8_0.gguf',
          filename: 'X-mmproj-Q8_0.gguf',
          sizeBytes: 200,
        },
      ],
    })
    await h.provider.ensureStarted({ runtime: runtimeCfg(ref) })
    expect(h.supervisor.starts[0]?.mmprojPath).toBe('/models/X-mmproj-Q8_0.gguf')
    expect(h.logs.entries.filter((e) => e.level === 'warn')).toEqual([])
  })

  it('LOGS, once, an extra file it cannot place instead of launching blind in silence', async () => {
    const h = harness()
    const ref = customRef({
      extraFiles: [
        {
          url: 'https://huggingface.co/acme/X-GGUF/resolve/main/X-vision-proj-f16.gguf',
          filename: 'X-vision-proj-f16.gguf',
          sizeBytes: 200,
        },
      ],
    })
    await h.provider.ensureStarted({ runtime: runtimeCfg(ref) })
    await h.provider.ensureStarted({ runtime: runtimeCfg(ref) })
    expect(h.supervisor.starts[0]?.mmprojPath).toBeUndefined()
    const warns = h.logs.entries.filter((e) => e.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.message).toContain('WITHOUT vision')
    expect(warns[0]?.extras?.meta).toMatchObject({ unrecognised: ['X-vision-proj-f16.gguf'] })
  })

  it('starts a text-only custom model with no projector at all', async () => {
    const h = harness()
    await h.provider.ensureStarted({ runtime: runtimeCfg(customRef({ extraFiles: [] })) })
    expect(h.supervisor.starts[0]?.mmprojPath).toBeUndefined()
  })
})

describe('extraArgs — one owner per flag', () => {
  it('accepts flags the schema does not model', () => {
    expect(checkExtraArgs(['--jinja', '--cont-batching', '--rope-scaling', 'yarn'])).toEqual({
      ok: true,
    })
  })

  it.each([
    ['-ngl', 'gpuLayers'],
    ['--ctx-size', 'contextSize'],
    ['--parallel', 'parallel'],
    ['-fa', 'flashAttention'],
    ['--cache-type-k', 'cacheTypeK'],
    ['-m', 'model'],
    ['--mmproj', 'projector'],
  ])('rejects %s because a typed field owns it', (flag, owner) => {
    const out = checkExtraArgs(['--jinja', flag, '999'])
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.message).toContain(flag)
    expect(out.message.toLowerCase()).toContain(owner.toLowerCase())
  })

  it('rejects the --flag=value spelling too', () => {
    expect(checkExtraArgs(['--ctx-size=32000']).ok).toBe(false)
  })

  it('refuses to START a runtime whose extraArgs collide, before any spawn', async () => {
    const h = harness()
    await expect(
      h.provider.ensureStarted({ runtime: runtimeCfg(customRef(), ['-ngl', '999']) }),
    ).rejects.toThrow(/gpuLayers/)
    expect(h.supervisor.starts).toEqual([])
  })

  it('appends extraArgs to the argv, after everything the schema owns', () => {
    const args = buildLlamaArgs(
      {
        nodeId: 'hub',
        modelId: 'm',
        modelPath: '/models/m.gguf',
        contextSize: 4096,
        gpuLayers: 0,
        parallel: 1,
        idleStopMinutes: 30,
        binaryPath: '/bin/llama-server',
        extraArgs: ['--jinja', '--cont-batching'],
      },
      18080,
    )
    expect(args.slice(-2)).toEqual(['--jinja', '--cont-batching'])
    expect(args.filter((a) => a === '-ngl')).toHaveLength(1)
  })
})
