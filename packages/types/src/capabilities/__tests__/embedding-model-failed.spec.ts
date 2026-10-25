/**
 * The encoder's `failed` refusal is ONE shared code that survives the process
 * hop in the message (D649 round 4, same pattern as `VECTOR_INDEX_DIM_CONFLICT`).
 *
 * The live detail plane classifies on it to count refusals per camera; a
 * consumer that matched the wording instead would break silently the day a
 * word changed, and one that could not read the model or the node out of it
 * would have to call `getInfo` (1.42 s cross-process) to say which tower to
 * reset.
 */
import { describe, expect, it } from 'vitest'
import {
  EMBEDDING_MODEL_FAILED,
  EMBEDDING_REQUIREMENTS_FAILED,
  EMBEDDING_REQUIREMENTS_UNAVAILABLE,
  embeddingModelFailedError,
  embeddingModelFailedOf,
  embeddingRefusalOf,
  embeddingRequirementsFailedError,
  embeddingRequirementsUnavailableError,
  isEmbeddingModelFailed,
} from '../embedding-encoder.cap.js'

const ROW = {
  modelId: 'siglip2-b16-224',
  tower: 'image' as const,
  nodeId: 'agent-b',
  crashes: 3,
  windowMs: 600_000,
  sinceMs: 1_700_000_000_000,
  lastReason: 'process died after loading',
}

describe('EMBEDDING_MODEL_FAILED — one code, built and read through the helpers', () => {
  it('the refusal carries the code, the model, the tower and the node, and reads back as such', () => {
    const err = embeddingModelFailedError(ROW)
    expect(err.message).toContain(`[${EMBEDDING_MODEL_FAILED}`)
    expect(isEmbeddingModelFailed(err)).toBe(true)
    expect(embeddingModelFailedOf(err)).toEqual({
      modelId: 'siglip2-b16-224',
      tower: 'image',
      nodeId: 'agent-b',
    })
  })

  it('names the recovery in the prose — the operator reads it off the log line', () => {
    const { message } = embeddingModelFailedError(ROW)
    expect(message).toContain('embeddingEncoder.resetFailedModels')
    expect(message).toContain('"agent-b"')
    expect(message).toContain('crashed 3 times in 600s')
  })

  it('survives a transport re-wrap: only the message travels', () => {
    const rewrapped = new Error(`TRPCClientError: ${embeddingModelFailedError(ROW).message}`)
    expect(embeddingModelFailedOf(rewrapped)?.tower).toBe('image')
    expect(embeddingModelFailedOf(embeddingModelFailedError(ROW).message)).not.toBeNull()
  })

  it('any other error — including one that merely TALKS about a failed model — is not the refusal', () => {
    expect(isEmbeddingModelFailed(new Error('model failed to download'))).toBe(false)
    expect(isEmbeddingModelFailed(new Error('embedding-model-failed'))).toBe(false)
    expect(embeddingModelFailedOf(undefined)).toBeNull()
    expect(
      embeddingModelFailedOf(new Error(`[${EMBEDDING_MODEL_FAILED} model=x tower=gpu node=hub]`)),
    ).toBeNull()
  })
})

describe('the requirements refusals — two more codes, the same token, the same reader (round 5)', () => {
  const ON = { modelId: 'siglip2-b16-224', tower: 'text' as const, nodeId: 'agent-b' }

  it('requirements-unavailable carries the code, model, tower, node and the reason', () => {
    const err = embeddingRequirementsUnavailableError(ON, 'retry in 5s — hub unreachable')
    expect(embeddingRefusalOf(err)).toEqual({ code: EMBEDDING_REQUIREMENTS_UNAVAILABLE, ...ON })
    expect(err.message).toContain('hub unreachable')
    // It is NOT the crashed-tower refusal: the detail plane must not count it as one.
    expect(isEmbeddingModelFailed(err)).toBe(false)
    expect(embeddingModelFailedOf(err)).toBeNull()
  })

  it('requirements-failed (terminal) names the attempts and the reset', () => {
    const err = embeddingRequirementsFailedError({
      ...ON,
      attempts: 3,
      sinceMs: 1,
      lastReason: 'HTTP 404 downloading https://x/model.onnx',
    })
    expect(embeddingRefusalOf(err)).toEqual({ code: EMBEDDING_REQUIREMENTS_FAILED, ...ON })
    expect(err.message).toContain('3 attempts')
    expect(err.message).toContain('embeddingEncoder.resetFailedModels')
    expect(isEmbeddingModelFailed(err)).toBe(false)
  })

  it('the generic reader classifies all three and rejects an unknown code in the same shape', () => {
    expect(embeddingRefusalOf(embeddingModelFailedError(ROW))?.code).toBe(EMBEDDING_MODEL_FAILED)
    expect(
      embeddingRefusalOf(new Error('[embedding-something-else model=x tower=text node=hub]')),
    ).toBeNull()
    expect(embeddingRefusalOf(new Error('requirements unavailable'))).toBeNull()
  })
})
