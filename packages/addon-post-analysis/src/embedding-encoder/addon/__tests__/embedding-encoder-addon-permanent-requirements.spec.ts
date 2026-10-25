/**
 * The encoder ADDON against a model that can never be downloaded (D649 round 5).
 *
 * `ModelDownloadService.ensure` is the one caller of the downloader, and the
 * addon classifies its failure by STATUS: a 404/410 is a requirement no retry
 * meets and is marked permanent for the gate; a 503 is an outage and only
 * cools down. Driven with fake time, because the cooldown between attempts is
 * real seconds and the gate's clock is `Date.now`.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type AddonContext,
  EMBEDDING_REQUIREMENTS_FAILED,
  EMBEDDING_REQUIREMENTS_UNAVAILABLE,
  embeddingRefusalOf,
  type IScopedLogger,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ensureMock = vi.fn<(modelId: string, format?: string) => Promise<string>>()

vi.mock('@camstack/system/addon-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/system/addon-utils')>()
  class FakeModelDownloadService {
    ensure(modelId: string, format?: string): Promise<string> {
      return ensureMock(modelId, format)
    }
  }
  return { ...actual, ModelDownloadService: FakeModelDownloadService }
})

const { ModelDownloadHttpError } = await import('@camstack/system/addon-utils')
const { default: EmbeddingEncoderAddon } = await import('../index.js')
const { REQUIREMENTS_COOLDOWN_MAX_MS } = await import('../model-requirements.js')

function spyLogger(): IScopedLogger {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (): IScopedLogger => logger,
    withTags: (): IScopedLogger => logger,
  } as unknown as IScopedLogger // test double: the boundary is IScopedLogger's optional surface
  return logger
}

async function boot(): Promise<InstanceType<typeof EmbeddingEncoderAddon>> {
  const nodeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-encoder-404-'))
  // A fake AddonContext: only what BaseAddon.initialize and the encoder's boot
  // touch. The cast is the one documented test boundary in this file.
  const ctx = {
    id: 'embedding-encoder',
    logger: spyLogger(),
    eventBus: { emit: () => {}, subscribe: () => () => {} },
    addonConfig: {},
    kernel: { localNodeId: 'agent-b' },
    api: {
      addonSettings: {
        getGlobalSettings: {
          query: async () => {
            throw new Error('cluster row unreadable in this test')
          },
        },
      },
    },
    dataDir: nodeDataDir,
    nodeDataDir,
    deps: {
      ensurePython: async () => '/usr/bin/python3',
      installPythonRequirements: async () => {},
    },
    settings: {
      readAddonStore: async () => ({}),
      writeAddonStore: async () => {},
    },
  } as unknown as AddonContext
  const addon = new EmbeddingEncoderAddon()
  await addon.initialize(ctx)
  return addon
}

const CROP = { crop: new Uint8Array(4 * 4 * 3), width: 4, height: 4 }

/** The TEXT tower — its catalog entry has an onnx build, so `ensure` is really asked. */
async function refusalOf(addon: InstanceType<typeof EmbeddingEncoderAddon>): Promise<unknown> {
  return addon.encodeText({ text: 'a red car' }).then(
    () => null,
    (e: unknown) => e,
  )
}

/** The IMAGE tower — its catalog entry has NO onnx build (retired 2026-08-21). */
async function imageRefusalOf(addon: InstanceType<typeof EmbeddingEncoderAddon>): Promise<unknown> {
  return addon.encode(CROP).then(
    () => null,
    (e: unknown) => e,
  )
}

describe('EmbeddingEncoderAddon — a model URL that does not exist', () => {
  let addon: InstanceType<typeof EmbeddingEncoderAddon> | null = null
  afterEach(async () => {
    await addon?.shutdown()
    addon = null
    vi.useRealTimers()
    ensureMock.mockReset()
  })

  it('404 by STATUS is permanent: terminal after three attempts, listed with its node, cleared by resetFailedModels', async () => {
    vi.useFakeTimers()
    ensureMock.mockRejectedValue(
      new ModelDownloadHttpError(
        404,
        'https://models.example/siglip2-b16-224-text.onnx',
        'downloading',
      ),
    )
    addon = await boot()
    const codes: (string | undefined)[] = []
    for (let i = 0; i < 3; i++) {
      codes.push(embeddingRefusalOf(await refusalOf(addon))?.code)
      vi.setSystemTime(Date.now() + REQUIREMENTS_COOLDOWN_MAX_MS + 1)
    }
    expect(codes).toEqual([
      EMBEDDING_REQUIREMENTS_UNAVAILABLE,
      EMBEDDING_REQUIREMENTS_UNAVAILABLE,
      EMBEDDING_REQUIREMENTS_FAILED,
    ])
    expect(ensureMock).toHaveBeenCalledTimes(3)
    // Terminal: no attempt, however long, and the row names the node.
    expect(embeddingRefusalOf(await refusalOf(addon))?.code).toBe(EMBEDDING_REQUIREMENTS_FAILED)
    expect(ensureMock).toHaveBeenCalledTimes(3)
    const info = await addon.getInfo()
    expect(info.failedRequirements).toEqual([
      expect.objectContaining({
        modelId: 'siglip2-b16-224',
        tower: 'text',
        nodeId: 'agent-b',
        attempts: 3,
        lastReason: expect.stringContaining('404'),
      }),
    ])
    expect(info.failedModels).toEqual([]) // it was never a crash
    // The operator fixes the catalog entry and resets: the next request attempts again.
    expect(await addon.resetFailedModels({ modelId: 'siglip2-b16-224' })).toEqual({
      cleared: ['siglip2-b16-224'],
      nodeId: 'agent-b',
    })
    expect((await addon.getInfo()).failedRequirements).toEqual([])
    await refusalOf(addon)
    expect(ensureMock).toHaveBeenCalledTimes(4)
  })

  it('a catalog entry with NO onnx build is permanent by STRUCTURE: terminal after three attempts, the downloader never asked', async () => {
    vi.useFakeTimers()
    addon = await boot()
    const codes: (string | undefined)[] = []
    for (let i = 0; i < 3; i++) {
      codes.push(embeddingRefusalOf(await imageRefusalOf(addon))?.code)
      vi.setSystemTime(Date.now() + REQUIREMENTS_COOLDOWN_MAX_MS + 1)
    }
    expect(codes).toEqual([
      EMBEDDING_REQUIREMENTS_UNAVAILABLE,
      EMBEDDING_REQUIREMENTS_UNAVAILABLE,
      EMBEDDING_REQUIREMENTS_FAILED,
    ])
    expect(ensureMock).not.toHaveBeenCalled()
    expect((await addon.getInfo()).failedRequirements).toEqual([
      expect.objectContaining({
        modelId: 'siglip2-b16-224',
        tower: 'image',
        nodeId: 'agent-b',
        lastReason: expect.stringContaining('no onnx build'),
      }),
    ])
  })

  it('503 is an outage, not a missing file: it only cools down and never goes terminal', async () => {
    vi.useFakeTimers()
    ensureMock.mockRejectedValue(
      new ModelDownloadHttpError(
        503,
        'https://models.example/siglip2-b16-224-text.onnx',
        'downloading',
      ),
    )
    addon = await boot()
    for (let i = 0; i < 6; i++) {
      expect(embeddingRefusalOf(await refusalOf(addon))?.code).toBe(
        EMBEDDING_REQUIREMENTS_UNAVAILABLE,
      )
      vi.setSystemTime(Date.now() + REQUIREMENTS_COOLDOWN_MAX_MS + 1)
    }
    expect(ensureMock).toHaveBeenCalledTimes(6)
    expect((await addon.getInfo()).failedRequirements).toEqual([])
  })
})
