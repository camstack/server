/**
 * D744 — a model copy already on the node that hashes to its mirror revision
 * is recorded at provider start, so the model listing (`isModelDownloaded`,
 * synchronous, never hashes) reports it downloaded instead of every hosted
 * model reading "not downloaded" after the release that gave them revisions.
 */
import type { IScopedLogger, ModelCatalogEntry } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

const adopt = vi.hoisted(() =>
  vi.fn(async (_modelsDir: string, _entries: readonly ModelCatalogEntry[]) => ({
    adopted: [],
    stale: [],
  })),
)
vi.mock('@camstack/system/addon-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adoptModelRevisions: adopt,
}))

const { DetectionPipelineProvider } = await import('../provider.js')

function makeLogger(): IScopedLogger {
  const noop = (): void => undefined
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

describe('DetectionPipelineProvider adopts model revisions on init', () => {
  it('checks every catalog model in its modelsDir against its revision', async () => {
    const store = {
      readAddonStore: async () => ({}),
      writeAddonStore: async () => undefined,
    }
    const provider = new DetectionPipelineProvider(store, '/tmp/models-adopt-test', makeLogger())
    await provider.init()
    expect(adopt).toHaveBeenCalledTimes(1)
    const [dir, entries] = adopt.mock.calls[0] ?? ['', []]
    expect(dir).toBe('/tmp/models-adopt-test')
    expect(entries.map((e) => e.id)).toEqual(expect.arrayContaining(['yolov9m-320', 'yolo26n-320']))
    await provider.shutdown()
  })
})
