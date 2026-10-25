import { describe, expect, it } from 'vitest'
import { FULL_IMAGE_BBOX, type RunStatelessStepInput } from '@camstack/types'
import { testFaceEmbeddingDetail } from '../../__tests__/support/run-stateless-step.js'
import type { FaceReembedSample } from '../face-reembed-pass.js'
import { FaceReembedEmbedder, shouldAutoReembed } from '../face-reembed-wiring.js'
import { PHOTO_ENROLL_DEVICE_ID, PHOTO_FACE_EMBEDDING_STEP_ID } from '../photo-enrollment.js'

const SAMPLE: FaceReembedSample = {
  sampleId: 's-1',
  identityId: 'i-1',
  identityName: 'Alice',
  modelId: 'arcface-r100',
  dim: 512,
  mediaId: 1,
}

const CROP = Buffer.from('jpeg-bytes')

function vectorBase64(values: readonly number[]): string {
  return Buffer.from(new Float32Array(values).buffer).toString('base64')
}

function silentLogger(): { warn: () => void } {
  return { warn: () => undefined }
}

describe('FaceReembedEmbedder', () => {
  it('sends the template as the WHOLE frame: face-embedding alone, FULL_IMAGE_BBOX, pinned model', async () => {
    const calls: Array<{ nodeId: string; input: RunStatelessStepInput }> = []
    const embedder = new FaceReembedEmbedder(
      {
        runStatelessStep: async (nodeId, input) => {
          calls.push({ nodeId, input })
          return {
            kind: 'ran',
            nodeId,
            modelId: 'auraface-r100',
            details: [testFaceEmbeddingDetail(vectorBase64([0.5, -0.25]))],
          }
        },
        logger: silentLogger(),
      },
      ['hub'],
      'auraface-r100',
    )

    const outcome = await embedder.embed(SAMPLE, CROP)

    expect(outcome).toEqual({
      kind: 'embedded',
      embedding: [0.5, -0.25],
      dim: 2,
      modelId: 'auraface-r100',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.input.stepId).toBe(PHOTO_FACE_EMBEDDING_STEP_ID)
    expect(calls[0]!.input.modelId).toBe('auraface-r100')
    expect(calls[0]!.input.bbox).toEqual(FULL_IMAGE_BBOX)
    expect(calls[0]!.input.sourceDeviceId).toBe(PHOTO_ENROLL_DEVICE_ID)
    expect(Buffer.from(calls[0]!.input.frameJpeg, 'base64').equals(CROP)).toBe(true)
  })

  it('retries the SAME sample on the next node when one cannot serve the model', async () => {
    const asked: string[] = []
    const embedder = new FaceReembedEmbedder(
      {
        runStatelessStep: async (nodeId, _input) => {
          asked.push(nodeId)
          if (nodeId === 'agent-a') {
            return {
              kind: 'refused',
              nodeId,
              reason: 'model-not-servable',
              detail: 'no openvino build of auraface-r100',
            }
          }
          return {
            kind: 'ran',
            nodeId,
            modelId: 'auraface-r100',
            details: [testFaceEmbeddingDetail(vectorBase64([1]))],
          }
        },
        logger: silentLogger(),
      },
      ['agent-a', 'hub'],
      'auraface-r100',
    )

    const outcome = await embedder.embed(SAMPLE, CROP)

    expect(outcome.kind).toBe('embedded')
    expect(asked).toEqual(['agent-a', 'hub'])
  })

  it('a dropped node STAYS dropped for the following samples', async () => {
    const asked: string[] = []
    const embedder = new FaceReembedEmbedder(
      {
        runStatelessStep: async (nodeId, _input) => {
          asked.push(nodeId)
          if (nodeId === 'agent-a') {
            return { kind: 'refused', nodeId, reason: 'unknown-step', detail: 'old runner' }
          }
          return {
            kind: 'ran',
            nodeId,
            modelId: 'auraface-r100',
            details: [testFaceEmbeddingDetail(vectorBase64([1]))],
          }
        },
        logger: silentLogger(),
      },
      ['agent-a', 'hub'],
      'auraface-r100',
    )

    await embedder.embed(SAMPLE, CROP)
    asked.length = 0
    await embedder.embed({ ...SAMPLE, sampleId: 's-2' }, CROP)

    expect(asked).toEqual(['hub'])
  })

  it('a node that echoes a DIFFERENT model than the pin is unfit, never a source of vectors', async () => {
    const embedder = new FaceReembedEmbedder(
      {
        runStatelessStep: async (nodeId, _input) => ({
          kind: 'ran',
          nodeId,
          modelId: 'arcface-r100',
          details: [testFaceEmbeddingDetail(vectorBase64([1]))],
        }),
        logger: silentLogger(),
      },
      ['hub'],
      'auraface-r100',
    )

    const outcome = await embedder.embed(SAMPLE, CROP)

    expect(outcome.kind).toBe('no-capable-node')
    if (outcome.kind === 'no-capable-node') {
      expect(outcome.reason).toContain('arcface-r100')
    }
  })

  it('ends with no-capable-node when every node refuses, carrying every reason', async () => {
    const embedder = new FaceReembedEmbedder(
      {
        runStatelessStep: async (nodeId) => ({
          kind: 'refused',
          nodeId,
          reason: 'model-not-servable',
          detail: `${nodeId} has no build`,
        }),
        logger: silentLogger(),
      },
      ['hub', 'agent-a'],
      'auraface-r100',
    )

    const outcome = await embedder.embed(SAMPLE, CROP)

    expect(outcome.kind).toBe('no-capable-node')
    if (outcome.kind === 'no-capable-node') {
      expect(outcome.reason).toContain('hub has no build')
      expect(outcome.reason).toContain('agent-a has no build')
    }
  })

  it('an execution failure is a verdict on the SAMPLE — reported, not retried elsewhere', async () => {
    const asked: string[] = []
    const embedder = new FaceReembedEmbedder(
      {
        runStatelessStep: async (nodeId) => {
          asked.push(nodeId)
          return {
            kind: 'refused',
            nodeId,
            reason: 'execution-failed',
            detail: 'engine crashed',
          }
        },
        logger: silentLogger(),
      },
      ['hub', 'agent-a'],
      'auraface-r100',
    )

    const outcome = await embedder.embed(SAMPLE, CROP)

    expect(outcome.kind).toBe('failed')
    expect(asked).toEqual(['hub'])
  })
})

describe('shouldAutoReembed', () => {
  const inSpace: FaceReembedSample = { ...SAMPLE, sampleId: 'ok', modelId: 'auraface-r100' }
  const stray: FaceReembedSample = { ...SAMPLE, sampleId: 'stray', modelId: 'arcface-r100' }
  const strayNoPixels: FaceReembedSample = {
    sampleId: 'ghost',
    identityId: 'i-1',
    identityName: 'Alice',
    modelId: 'arcface-r100',
    dim: 512,
  }

  it('triggers when a stray sample still has pixels to try', () => {
    expect(shouldAutoReembed([inSpace, stray], 'auraface-r100', new Set(), false)).toBe(true)
  })

  it('does NOT trigger when every sample is already in space', () => {
    expect(shouldAutoReembed([inSpace], 'auraface-r100', new Set(), false)).toBe(false)
  })

  it('does NOT re-trigger forever on samples a pass already probed pixel-less', () => {
    expect(shouldAutoReembed([inSpace, stray], 'auraface-r100', new Set(['stray']), false)).toBe(
      false,
    )
  })

  it('does NOT trigger on a sample with no mediaId at all — there is nothing to read', () => {
    expect(shouldAutoReembed([strayNoPixels], 'auraface-r100', new Set(), false)).toBe(false)
  })

  it('does NOT trigger while a pass is already running', () => {
    expect(shouldAutoReembed([stray], 'auraface-r100', new Set(), true)).toBe(false)
  })

  it('does NOT trigger without a resolved target model', () => {
    expect(shouldAutoReembed([stray], null, new Set(), false)).toBe(false)
  })
})
