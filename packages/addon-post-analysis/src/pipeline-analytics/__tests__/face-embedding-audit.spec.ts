/**
 * D658 — the forced gallery audit: does each sample's stored vector come from
 * the model it is stamped with? Re-embed the template pinned, take the cosine,
 * report — and WRITE NOTHING.
 *
 * Driven through the real `FaceReembedEmbedder` over a fake
 * `runStatelessStep`, so the pin, the node rotation and the refusal of a node
 * that ran another model are the production ones.
 */
import type { RunStatelessStepInput, RunStatelessStepResult } from '@camstack/types'
import { encodeVectorBase64 } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  auditFaceEmbeddings,
  cosine,
  type FaceEmbeddingAuditDeps,
  verdictOf,
} from '../face-embedding-audit.js'
import type { FaceReembedSample } from '../face-reembed-pass.js'
import { FaceReembedEmbedder } from '../face-reembed-wiring.js'

const AURA = 'auraface-r100'

const unit = (dim: number, hot: number, lean = 0): number[] =>
  Array.from({ length: dim }, (_, i) => (i === hot ? 1 : i === hot + 1 ? lean : 0))

/** `mediaId: null` = a sample whose template blob is gone. */
function sample(id: string, modelId: string, mediaId: number | null = 1): FaceReembedSample {
  return {
    sampleId: id,
    identityId: `person-${id}`,
    identityName: `Person ${id}`,
    modelId,
    dim: 4,
    ...(mediaId !== null ? { mediaId } : {}),
  }
}

/** What the pinned re-embed of each template answers, keyed by the template bytes. */
function runnerAnswering(
  byTemplate: Readonly<Record<string, readonly number[]>>,
): (nodeId: string, input: RunStatelessStepInput) => Promise<RunStatelessStepResult> {
  return async (nodeId, input) => {
    const key = Buffer.from(input.frameJpeg ?? '', 'base64').toString()
    const vec = byTemplate[key]
    return {
      kind: 'ran',
      nodeId,
      modelId: input.modelId,
      details: vec
        ? [
            {
              stepId: 'face-embedding',
              className: 'face',
              score: 1,
              embedding: encodeVectorBase64(vec),
            },
          ]
        : [],
    }
  }
}

function deps(
  samples: readonly FaceReembedSample[],
  stored: Readonly<Record<string, readonly number[]>>,
  runner: (nodeId: string, input: RunStatelessStepInput) => Promise<RunStatelessStepResult>,
): FaceEmbeddingAuditDeps & { readonly embed: ReturnType<typeof vi.fn> } {
  const embedder = new FaceReembedEmbedder(
    { runStatelessStep: runner, logger: { warn: () => undefined } },
    ['hub'],
    AURA,
  )
  return {
    listSamples: async () => samples,
    loadStoredVectors: async (ids) =>
      new Map(ids.flatMap((id) => (stored[id] ? [[id, stored[id]] as const] : []))),
    loadAlignedCrop: async (s) => (s.mediaId === undefined ? null : Buffer.from(s.sampleId)),
    embed: vi.fn((s: FaceReembedSample, crop: Buffer) => embedder.embed(s, crop)),
  }
}

describe('face embedding audit (D658)', () => {
  it('ok when the re-embed agrees, mismatch when the stored vector is another model', async () => {
    const samples = [sample('a', AURA), sample('b', AURA)]
    const d = deps(
      samples,
      // `a` was embedded by AuraFace; `b`'s stored vector is another space.
      { a: unit(4, 0), b: unit(4, 2) },
      runnerAnswering({ a: unit(4, 0, 0.1), b: unit(4, 0) }),
    )
    const report = await auditFaceEmbeddings(d, { auditedModelId: AURA })
    expect(report.rows.map((r) => [r.sampleId, r.verdict])).toEqual([
      ['a', 'ok'],
      ['b', 'mismatch'],
    ])
    expect(report).toMatchObject({ total: 2, ok: 1, mismatch: 1, unmeasurable: 0, complete: true })
    expect(report.rows[0]!.cosine).toBeGreaterThan(0.98)
    expect(report.rows[1]!.cosine).toBeLessThan(0.9)
  })

  it('names every sample it cannot measure, and why — never a silent skip', async () => {
    const samples = [
      sample('arc', 'arcface-r100'),
      sample('gone', AURA, null),
      sample('novec', AURA),
    ]
    const d = deps(samples, {}, runnerAnswering({}))
    const report = await auditFaceEmbeddings(d, { auditedModelId: AURA })
    expect(report.rows.map((r) => [r.sampleId, r.verdict, r.reason])).toEqual([
      ['arc', 'unmeasurable', 'stamped-other-model'],
      ['gone', 'unmeasurable', 'no-stored-vector'],
      ['novec', 'unmeasurable', 'no-stored-vector'],
    ])
    expect(d.embed).not.toHaveBeenCalled()
  })

  it('a template whose blob is gone is `no-pixels`; an empty runner answer is `embed-failed`', async () => {
    const samples = [sample('gone', AURA, null), sample('empty', AURA)]
    const d = deps(samples, { gone: unit(4, 0), empty: unit(4, 0) }, runnerAnswering({}))
    const report = await auditFaceEmbeddings(d, { auditedModelId: AURA })
    expect(report.rows.map((r) => r.reason)).toEqual(['no-pixels', 'embed-failed'])
  })

  it('a node that ran another model is never measured against — every node refusing is `no-capable-node`, asked once', async () => {
    const runner = vi.fn(
      async (nodeId: string): Promise<RunStatelessStepResult> => ({
        kind: 'refused',
        nodeId,
        reason: 'model-not-servable',
        detail: 'the executor ran "arcface-r100" for a call pinned to "auraface-r100"',
      }),
    )
    const samples = [sample('a', AURA), sample('b', AURA)]
    const d = deps(samples, { a: unit(4, 0), b: unit(4, 0) }, runner)
    const report = await auditFaceEmbeddings(d, { auditedModelId: AURA })
    expect(report.rows.map((r) => r.reason)).toEqual(['no-capable-node', 'no-capable-node'])
    expect(runner).toHaveBeenCalledTimes(1)
    // The audit stops ASKING once the pass is terminal — not only the embedder.
    expect(d.embed).toHaveBeenCalledTimes(1)
  })

  it('is READ-ONLY: its dependencies have no write, and it is bounded by maxSamples', async () => {
    const samples = [sample('a', AURA), sample('b', AURA), sample('c', AURA)]
    const d = deps(
      samples,
      { a: unit(4, 0), b: unit(4, 0), c: unit(4, 0) },
      runnerAnswering({ a: unit(4, 0), b: unit(4, 0), c: unit(4, 0) }),
    )
    expect(Object.keys(d).toSorted()).toEqual([
      'embed',
      'listSamples',
      'loadAlignedCrop',
      'loadStoredVectors',
    ])
    const report = await auditFaceEmbeddings(d, { auditedModelId: AURA, maxSamples: 2 })
    expect(report.rows).toHaveLength(2)
    expect(report.complete).toBe(false)
  })

  it('the thresholds: ≥0.98 ok, <0.9 mismatch, between inconclusive', () => {
    expect(verdictOf(0.99)).toBe('ok')
    expect(verdictOf(0.98)).toBe('ok')
    expect(verdictOf(0.95)).toBe('inconclusive')
    expect(verdictOf(0.9)).toBe('inconclusive')
    expect(verdictOf(0.89)).toBe('mismatch')
    expect(cosine([1, 0], [0, 0])).toBeNull()
  })
})
