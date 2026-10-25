/**
 * The cloud-training P3 retrain methods reach the provider VERBATIM and are
 * admin-only: building and shipping the training set is not viewer curation.
 * The hub strips keys it does not know, so a filter field lost here would
 * silently widen an export — assert on what the provider RECEIVED.
 */
import { describe, expect, it } from 'vitest'
import { buildCapRouterForTest, checkAuthMatrix, invokeProcedure, makeCtx } from './harness.js'

const FRAME = {
  frameId: 'retrain:t:1',
  deviceId: 101,
  trackId: 't',
  sourceMediaId: 1,
  sourceKind: 'keyFrame',
  sizeBytes: 3,
  width: 10,
  height: 10,
  copiedAt: 1,
  capturedAt: 0,
  complete: true,
}

const ARCHIVE_INPUT = {
  filter: { frameIds: ['retrain:t:1'], completeOnly: true, batchId: 'v1', deviceIds: [101] },
  layout: 'crops',
  target: { kind: 'http', method: 'PUT', url: 'https://upload.example/x', headers: { a: 'b' } },
}

function provider(seen: unknown[]): Record<string, (input: unknown) => Promise<unknown>> {
  return {
    setRetrainFrameComplete: async (input) => {
      seen.push(input)
      return FRAME
    },
    writeRetrainArchive: async (input) => {
      seen.push(input)
      return {
        batchId: 'b',
        frames: 1,
        crops: 1,
        annotations: 1,
        missing: 0,
        bytes: 2048,
        sha256: 'ab',
        status: 200,
      }
    },
    getRetrainExportUrl: async (input) => {
      seen.push(input)
      return { url: '/addon/pipeline-analytics/retrain-export' }
    },
  }
}

describe('pipelineAnalytics retrain export methods (P3)', () => {
  it('forwards the archive filter, layout and target verbatim', async () => {
    const seen: unknown[] = []
    const router = buildCapRouterForTest('pipeline-analytics', () => provider(seen))
    const out = await invokeProcedure(
      router,
      'writeRetrainArchive',
      makeCtx('admin'),
      ARCHIVE_INPUT,
    )
    expect(out).toMatchObject({ ok: true })
    expect(seen).toEqual([ARCHIVE_INPUT])
  })

  it('forwards the export-url filter and layout verbatim', async () => {
    const seen: unknown[] = []
    const router = buildCapRouterForTest('pipeline-analytics', () => provider(seen))
    const input = { deviceIds: [101], frameIds: ['a'], completeOnly: true, layout: 'crops' }
    await invokeProcedure(router, 'getRetrainExportUrl', makeCtx('admin'), input)
    expect(seen).toEqual([input])
  })

  it('refuses a target that is not an http(s) URL', async () => {
    const router = buildCapRouterForTest('pipeline-analytics', () => provider([]))
    const out = await invokeProcedure(router, 'writeRetrainArchive', makeCtx('admin'), {
      ...ARCHIVE_INPUT,
      target: { kind: 'http', method: 'PUT', url: 'not a url' },
    })
    expect(out.ok).toBe(false)
  })

  it.each([
    'setRetrainFrameComplete',
    'writeRetrainArchive',
  ])('%s is admin-only', async (method) => {
    const router = buildCapRouterForTest('pipeline-analytics', () => provider([]))
    const input =
      method === 'setRetrainFrameComplete'
        ? { deviceId: 101, trackId: 't', frameId: 'retrain:t:1', complete: true }
        : ARCHIVE_INPUT
    for (const row of await checkAuthMatrix(router, method, 'admin', input)) {
      expect(row.outcome.ok).toBe(row.allowed)
    }
  })
})
