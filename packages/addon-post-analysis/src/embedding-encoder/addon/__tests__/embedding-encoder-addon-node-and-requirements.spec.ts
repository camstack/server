/**
 * The encoder ADDON, booted with a fake context (D649 round 4):
 *
 * - `getInfo` and `resetFailedModels` name the node they answer for — the
 *   logical node, a forked child's `<node>/<addon>` id stripped — and a node
 *   with the budget answers `failedModels: []`, never `undefined`;
 * - a REQUIREMENTS failure (here: the embedded Python is unavailable, the same
 *   stage as a model download that cannot reach the hub) is refused by its own
 *   name on every request, logged ONCE, and never reaches the crash budget:
 *   after more attempts than the budget allows, nothing is `failed`.
 *
 * Spawns nothing: the requirements stage fails before any engine exists.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EmbeddingEncoderAddon from '../index.js'
import { EMBEDDING_REQUIREMENTS_UNAVAILABLE, embeddingRefusalOf } from '@camstack/types'
import { completeLoggerStub } from '../../../notification-center/__tests__/support/nc-test-deps.js'

function spyLogger(): IScopedLogger {
  return completeLoggerStub({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })
}

/** The messages a spied logger method received. */
function messagesOf(method: IScopedLogger['warn']): readonly string[] {
  return vi.mocked(method).mock.calls.map(([message]) => message)
}

async function boot(localNodeId: string): Promise<{
  addon: EmbeddingEncoderAddon
  logger: IScopedLogger
  ensurePython: ReturnType<typeof vi.fn>
}> {
  const logger = spyLogger()
  const ensurePython = vi.fn(async () => null)
  const nodeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-encoder-'))
  // A fake AddonContext: only what BaseAddon.initialize and the encoder's boot
  // touch. The cast is the one documented test boundary in this file.
  const ctx = {
    id: 'embedding-encoder',
    logger,
    eventBus: { emit: () => {}, subscribe: () => () => {} },
    addonConfig: {},
    kernel: { localNodeId },
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
      ensurePython,
      installPythonRequirements: async () => {},
    },
    settings: {
      readAddonStore: async () => ({}),
      writeAddonStore: async () => {},
    },
  } as unknown as AddonContext
  const addon = new EmbeddingEncoderAddon()
  await addon.initialize(ctx)
  return { addon, logger, ensurePython }
}

describe('EmbeddingEncoderAddon — node-attributed state and requirements refusals', () => {
  let booted: Awaited<ReturnType<typeof boot>> | null = null
  afterEach(async () => {
    await booted?.addon.shutdown()
    booted = null
  })

  it('getInfo and resetFailedModels name the LOGICAL node (a child id is stripped to its node)', async () => {
    booted = await boot('agent-b/embedding-encoder')
    const info = await booted.addon.getInfo()
    expect(info.nodeId).toBe('agent-b')
    expect(info.failedModels).toEqual([]) // known-empty, not unknown
    expect(info.failedRequirements).toEqual([])
    expect(await booted.addon.resetFailedModels({})).toEqual({ cleared: [], nodeId: 'agent-b' })
    expect(await booted.addon.resetFailedModels({ modelId: 'siglip2-b16-224' })).toEqual({
      cleared: [],
      nodeId: 'agent-b',
    })
  })

  it('a missing runtime refuses BOTH towers by name, once in the log, ONE attempt per tower inside the cooldown, and never spends the crash budget', async () => {
    booted = await boot('hub')
    const { addon, logger, ensurePython } = booted
    const crop = { crop: new Uint8Array(4 * 4 * 3), width: 4, height: 4 }
    for (let i = 0; i < 4; i++) {
      const image = await addon.encode(crop).then(
        () => null,
        (e: unknown) => e,
      )
      const text = await addon.encodeText({ text: 'a van' }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(embeddingRefusalOf(image)).toEqual({
        code: EMBEDDING_REQUIREMENTS_UNAVAILABLE,
        modelId: 'siglip2-b16-224',
        tower: 'image',
        nodeId: 'hub',
      })
      expect(embeddingRefusalOf(text)?.tower).toBe('text')
      // The first request of each tower carries the cause; the ones inside the cooldown say so.
      expect(String(image)).toMatch(i === 0 ? /embedded Python is unavailable/ : /retry in \d+s/)
    }
    // 4 rounds × 2 towers = 8 requests, TWO attempts: the cooldown held the rest.
    expect(ensurePython).toHaveBeenCalledTimes(2)
    const info = await addon.getInfo()
    expect(info.failedModels).toEqual([])
    expect(info.failedRequirements).toEqual([]) // transient: never terminal
    expect(info.ready).toBe(false)
    const requirementLines = messagesOf(logger.warn).filter((m) =>
      m.startsWith('CLIP model requirements unavailable'),
    )
    expect(requirementLines).toHaveLength(2) // one per tower, not one per request
    expect(messagesOf(logger.error)).toEqual([])
  })
})
