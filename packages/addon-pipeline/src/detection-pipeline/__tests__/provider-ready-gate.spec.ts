/**
 * Task 7 — provider inference gate.
 *
 * The provider owns an {@link EngineProvisioner} and must refuse to run
 * inference until the engine reaches the `ready` phase. A freshly
 * constructed provider has never provisioned, so:
 *   - `getEngineProvisioning().state` is NOT `ready` (it is `idle`), and
 *   - `assertEngineReady()` rejects with a phase-describing message.
 *
 * Reuses the `makeLogger` / `InMemoryStore` / `makeProvider` doubles from
 * the sibling engine-catalog gate test.
 */

import type { IScopedLogger } from '@camstack/types'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { DetectionPipelineProvider } from '../provider.js'

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

class InMemoryStore {
  private data: Record<string, unknown> = {}
  async readAddonStore(): Promise<Record<string, unknown>> {
    return { ...this.data }
  }
  async writeAddonStore(patch: Record<string, unknown>): Promise<void> {
    this.data = { ...this.data, ...patch }
  }
}

function makeProvider(): DetectionPipelineProvider {
  return new DetectionPipelineProvider(new InMemoryStore(), '/tmp/models-test', makeLogger())
}

/** Smallest valid JPEG sharp will produce — exercises the real decode path. */
async function tinyJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer()
}

describe('provider inference gate', () => {
  it('reports not-ready before provisioning completes and refuses to infer', async () => {
    const p = makeProvider()
    // Before any successful provisioning, the snapshot is not ready.
    expect(p.getEngineProvisioning().state).not.toBe('ready')
    // The inference gate rejects with the current phase/error.
    await expect(p.assertEngineReady()).rejects.toThrow(/not ready|installing|failed|idle/i)
  })

  // PRODUCTION-PATH gate test (review). The isolated `assertEngineReady()`
  // assertion above did NOT catch the original bug — the gate had been
  // placed in `ensureExecutor()`, a legacy dead path, while the LIVE
  // camera-frame path (`pipeline-runner.runInference → runPipeline.mutate
  // → runPipeline() → ensureEngineFactory()`) built the EngineFactory and
  // ran inference UNGATED. This test drives the public `runPipeline()`
  // entry that the live path funnels through, so a not-ready provider MUST
  // reject (no factory built, no inference) — proving the gate now sits on
  // the real chokepoint (`ensureEngineFactory`), not a dead branch.
  it('refuses to build the factory / run inference on the live runPipeline path when not ready', async () => {
    const p = makeProvider()
    // Sanity: a fresh provider (no setApi) has never provisioned → idle.
    expect(p.getEngineProvisioning().state).toBe('idle')

    const image = await tinyJpeg()
    // `runPipeline` is the exact method the runner calls over tRPC. It
    // decodes the image, then reaches `ensureEngineFactory()` — which now
    // calls `assertEngineReady()` BEFORE constructing the EngineFactory.
    // An idle provider must therefore reject here, never building a pool.
    await expect(p.runPipeline({ image: new Uint8Array(image), steps: [] })).rejects.toThrow(
      /not ready|installing|failed|idle/i,
    )
  })
})
