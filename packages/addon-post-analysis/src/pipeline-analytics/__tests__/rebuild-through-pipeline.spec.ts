/**
 * The rebuild's encode goes through a RUNNER, not the encoder addon — and now
 * through ANY capable runner, not the camera's own.
 *
 * Two load-bearing assertions live here. The first is D52's: `pipeline-analytics`
 * used to call `api.embeddingEncoder.encode` with a crop it cut itself, so
 * nothing about the vector matched the live path filling the same index. The
 * second is this change's: the request carries a MODEL PIN and the answer is
 * only accepted when the node confirms it ran that model, because a pass spread
 * across nodes can otherwise mix encoders one level below the crop.
 *
 * These exercise the pure request builder and the pure answer reader, so they
 * check the SHAPE of the call rather than an addon's private wiring.
 */

import type { RunStatelessStepResult } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildRebuildStepInput,
  hasKeyFrame,
  REBUILD_DETAIL_STEP_ID,
  readRebuildStepOutcome,
} from '../rebuild-detail-request.js'

const PINNED_MODEL = 'mobileclip-s1'

const source = {
  trackId: 't1',
  deviceId: 102,
  timestamp: 1000,
  className: 'dog',
  confidence: 0.9,
  keyFrame: Buffer.from('jpeg-bytes'),
  bbox: { x: 0.25, y: 0.5, w: 0.25, h: 0.25 },
  boxSource: { kind: 'subjectBox' as const },
}

const EMBEDDING = Buffer.from(Float32Array.from([1, 0, 0]).buffer).toString('base64')

function ran(overrides: Partial<Extract<RunStatelessStepResult, { kind: 'ran' }>> = {}) {
  const result: RunStatelessStepResult = {
    kind: 'ran',
    nodeId: 'hub',
    modelId: PINNED_MODEL,
    details: [
      { stepId: REBUILD_DETAIL_STEP_ID, className: 'embedding', score: 1, embedding: EMBEDDING },
    ],
    ...overrides,
  }
  return result
}

describe('buildRebuildStepInput', () => {
  it('sends the FULL key frame — the runner cuts, not this side', () => {
    const input = buildRebuildStepInput(source, PINNED_MODEL)
    expect(input.frameJpeg).toBe(source.keyFrame.toString('base64'))
  })

  it('asks for the clip-embedding step alone', () => {
    expect(buildRebuildStepInput(source, PINNED_MODEL).stepId).toBe('clip-embedding')
    expect(REBUILD_DETAIL_STEP_ID).toBe('clip-embedding')
  })

  it('sends the box NORMALISED — the decoding side denormalises it', () => {
    // The key frame is a native-resolution capture while the detection ran on a
    // downscaled analysis frame. Converting here would need this module to read
    // the image's dimensions, one process away from the code that decodes it.
    expect(buildRebuildStepInput(source, PINNED_MODEL).bbox).toEqual(source.bbox)
  })

  it('pins the model on EVERY request', () => {
    // Not a default and not resolved per call: a pass that lets any request go
    // out unpinned lets that node pick its own per-device model.
    expect(buildRebuildStepInput(source, PINNED_MODEL).modelId).toBe(PINNED_MODEL)
    expect(buildRebuildStepInput(source, 'mobileclip-s0').modelId).toBe('mobileclip-s0')
  })

  it('carries the camera as `sourceDeviceId`, NOT as `deviceId`', () => {
    // `deviceId` in cap args is read as a routing hint and would drag the call
    // back to the camera's owning node — the exact placement constraint this
    // path removes. The value is still there so the executing node can tag its
    // logs with the camera.
    const input = buildRebuildStepInput(source, PINNED_MODEL)
    expect(input.sourceDeviceId).toBe(102)
    expect(Object.keys(input)).not.toContain('deviceId')
  })

  it('carries the parent class through', () => {
    expect(buildRebuildStepInput(source, PINNED_MODEL).className).toBe('dog')
  })
})

describe('readRebuildStepOutcome', () => {
  it('lifts the clip-embedding vector out, still base64', () => {
    expect(readRebuildStepOutcome(ran(), PINNED_MODEL)).toEqual({
      kind: 'embedded',
      embeddingBase64: EMBEDDING,
    })
  })

  it('a model the node did not run is NODE-UNFIT, never an accepted vector', () => {
    // The node already refuses what it cannot serve, so this means a node
    // ignored the pin. Accepting it would put a foreign feature space in the
    // index with nothing in the data to show it.
    const verdict = readRebuildStepOutcome(ran({ modelId: 'mobileclip-s0' }), PINNED_MODEL)
    expect(verdict.kind).toBe('node-unfit')
    if (verdict.kind === 'node-unfit') {
      expect(verdict.reason).toContain('mobileclip-s0')
      expect(verdict.reason).toContain(PINNED_MODEL)
    }
  })

  it('a model refusal is NODE-UNFIT — the track is fine, the node is not', () => {
    const verdict = readRebuildStepOutcome(
      {
        kind: 'refused',
        nodeId: 'agent-1',
        reason: 'model-not-servable',
        detail: 'no tflite build',
      },
      PINNED_MODEL,
    )
    expect(verdict.kind).toBe('node-unfit')
  })

  it('an unknown step is NODE-UNFIT — version skew, not a broken track', () => {
    const verdict = readRebuildStepOutcome(
      { kind: 'refused', nodeId: 'agent-1', reason: 'unknown-step', detail: 'no such step' },
      PINNED_MODEL,
    )
    expect(verdict.kind).toBe('node-unfit')
  })

  it('an unreadable frame is NOT-RUNNABLE — retrying elsewhere reproduces it exactly', () => {
    const verdict = readRebuildStepOutcome(
      { kind: 'refused', nodeId: 'hub', reason: 'unreadable-frame', detail: 'bad jpeg' },
      PINNED_MODEL,
    )
    expect(verdict.kind).toBe('not-runnable')
  })

  it('an execution failure is FAILED — that is the counter pointing at the engine', () => {
    const verdict = readRebuildStepOutcome(
      { kind: 'refused', nodeId: 'hub', reason: 'execution-failed', detail: 'pool died' },
      PINNED_MODEL,
    )
    expect(verdict.kind).toBe('failed')
  })

  it('details WITHOUT an embedding are a failure — the step ran and produced nothing usable', () => {
    const verdict = readRebuildStepOutcome(
      ran({ details: [{ stepId: REBUILD_DETAIL_STEP_ID, className: 'embedding', score: 1 }] }),
      PINNED_MODEL,
    )
    expect(verdict.kind).toBe('failed')
  })

  it('an empty details array is a failure, never a silent success', () => {
    expect(readRebuildStepOutcome(ran({ details: [] }), PINNED_MODEL).kind).toBe('failed')
  })

  it('ignores a detail from another step', () => {
    const verdict = readRebuildStepOutcome(
      ran({
        details: [
          { stepId: 'face-embedding', className: 'face', score: 1, embedding: EMBEDDING },
          {
            stepId: REBUILD_DETAIL_STEP_ID,
            className: 'embedding',
            score: 1,
            embedding: EMBEDDING,
          },
        ],
      }),
      PINNED_MODEL,
    )
    expect(verdict).toEqual({ kind: 'embedded', embeddingBase64: EMBEDDING })
  })

  it('every non-embedded verdict carries a reason the log can print', () => {
    const results: readonly RunStatelessStepResult[] = [
      ran({ details: [] }),
      ran({ modelId: 'other' }),
      { kind: 'refused', nodeId: 'hub', reason: 'unreadable-frame', detail: 'bad jpeg' },
      { kind: 'refused', nodeId: 'hub', reason: 'execution-failed', detail: 'pool died' },
    ]
    for (const result of results) {
      const verdict = readRebuildStepOutcome(result, PINNED_MODEL)
      expect(verdict.kind).not.toBe('embedded')
      if (verdict.kind !== 'embedded') expect(verdict.reason.length).toBeGreaterThan(0)
    }
  })
})

describe('hasKeyFrame', () => {
  it('rejects a source with no key frame or no box', () => {
    expect(hasKeyFrame({ ...source, keyFrame: null })).toBe(false)
    expect(hasKeyFrame({ ...source, bbox: null })).toBe(false)
    expect(hasKeyFrame(source)).toBe(true)
  })
})
