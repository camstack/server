import { describe, it, expect } from 'vitest'
import {
  buildFrameResult,
  applyChildOutput,
  FrameIdGenerator,
  type MutableObjectDetection,
  type AssemblyContext,
} from '../pipeline/result-assembler.js'
import type { ExecutableStep } from '../pipeline/tree-builder.js'

/** A face detail accumulator carrying a stored, normalized embedding. */
function makeFaceDetail(id: string, parentId: string): MutableObjectDetection {
  return {
    id,
    kind: 'detail',
    macroClass: 'face',
    score: 0.9,
    bbox: [10, 10, 50, 60],
    parentId,
    ownLabels: [],
    alternateLabels: {},
    stepLatencyMs: {},
    modelIds: {},
    embedding: [0.5, 0.5, 0.5, 0.5],
    embeddingModelId: 'arcface-r100',
  }
}

function buildArgs(dets: MutableObjectDetection[]) {
  const firstLevel = dets.filter((d) => d.kind === 'first-level')
  const details = dets.filter((d) => d.kind === 'detail')
  return {
    deviceId: 99,
    width: 1920,
    height: 1080,
    firstLevel,
    details,
    stepTimings: [],
    totalMs: 1,
    engine: 'test',
    debug: false,
    timestamp: 1000,
  }
}

describe('result-assembler — embedding exposure', () => {
  it("emits a face detail's own normalized embedding + model id", () => {
    const face = makeFaceDetail('d2', 'd1')
    const frame = buildFrameResult(buildArgs([face]))

    const emitted = frame.detections.find((d) => d.id === 'd2')
    expect(emitted?.embedding).toEqual([0.5, 0.5, 0.5, 0.5])
    expect(emitted?.embeddingModelId).toBe('arcface-r100')
  })

  it('omits embedding fields on a detection that has none', () => {
    const face = makeFaceDetail('d2', 'd1')
    delete (face as { embedding?: unknown }).embedding
    delete (face as { embeddingModelId?: unknown }).embeddingModelId
    const frame = buildFrameResult(buildArgs([face]))

    const emitted = frame.detections.find((d) => d.id === 'd2')
    expect('embedding' in (emitted ?? {})).toBe(false)
    expect('embeddingModelId' in (emitted ?? {})).toBe(false)
  })
})

/** Minimal arcface step — applyChildOutput only reads stepId + modelId here.
 *  The heavy `definition`/`engine` fields are unused on the embedding path. */
function fakeArcfaceStep(): ExecutableStep {
  return { stepId: 'face-embedding', modelId: 'arcface-r100' } as unknown as ExecutableStep
}

describe('result-assembler — applyChildOutput embedding case', () => {
  it('stores the normalized vector + model id on the parent face detail', () => {
    const face = makeFaceDetail('d2', 'd1')
    delete (face as { embedding?: unknown }).embedding
    delete (face as { embeddingModelId?: unknown }).embeddingModelId

    const ctx: AssemblyContext = { idGen: new FrameIdGenerator(), details: [] }
    applyChildOutput(
      face,
      fakeArcfaceStep(),
      { kind: 'embedding', embedding: [3, 4], embeddingNorm: [0.6, 0.8] },
      12,
      ctx,
    )

    expect(face.embedding).toEqual([0.6, 0.8]) // normalized, not raw [3,4]
    expect(face.embeddingModelId).toBe('arcface-r100')
    // back-compat marker is still emitted
    expect(face.ownLabels.some((l) => l.label === 'embedding:2d')).toBe(true)
  })

  /**
   * The RAW magnitude is the face-quality signal, and normalizing destroys it.
   * Until 2026-08-19 this line was where it was silently dropped — the
   * postprocessor computed both forms and only the unit vector survived, so
   * nothing downstream could tell a real face from an information-free crop.
   */
  it('keeps the RAW vector magnitude, which normalizing would destroy', () => {
    const face = makeFaceDetail('d2', 'd1')
    const ctx: AssemblyContext = { idGen: new FrameIdGenerator(), details: [] }
    applyChildOutput(
      face,
      fakeArcfaceStep(),
      { kind: 'embedding', embedding: [3, 4], embeddingNorm: [0.6, 0.8] },
      12,
      ctx,
    )

    expect(face.embeddingMagnitude).toBeCloseTo(5, 10) // ||[3,4]|| = 5
  })

  it('reports a magnitude of 0 for a zero vector rather than omitting it', () => {
    const face = makeFaceDetail('d2', 'd1')
    const ctx: AssemblyContext = { idGen: new FrameIdGenerator(), details: [] }
    applyChildOutput(
      face,
      fakeArcfaceStep(),
      { kind: 'embedding', embedding: [0, 0], embeddingNorm: [0, 0] },
      12,
      ctx,
    )

    expect(face.embeddingMagnitude).toBe(0)
  })
})

function makePerson(id: string): MutableObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.8,
    bbox: [0, 0, 200, 400],
    ownLabels: [],
    alternateLabels: {},
    stepLatencyMs: {},
    modelIds: {},
  }
}

describe('result-assembler — parent inherits best face embedding', () => {
  it('person inherits the higher-score face child embedding; faces keep their own', () => {
    const person = makePerson('d1')
    const faceA = makeFaceDetail('d2', 'd1') // score 0.9, [0.5,0.5,0.5,0.5]
    const faceB = makeFaceDetail('d3', 'd1')
    ;(faceB as { score: number }).score = 0.4
    ;(faceB as { embedding: readonly number[] }).embedding = [0.1, 0.2, 0.3, 0.4]

    const frame = buildFrameResult(buildArgs([person, faceA, faceB]))

    const emittedPerson = frame.detections.find((d) => d.id === 'd1')
    expect(emittedPerson?.embedding).toEqual([0.5, 0.5, 0.5, 0.5]) // from faceA (0.9 > 0.4)
    expect(emittedPerson?.embeddingModelId).toBe('arcface-r100')

    // each face still carries its own embedding
    expect(frame.detections.find((d) => d.id === 'd2')?.embedding).toEqual([0.5, 0.5, 0.5, 0.5])
    expect(frame.detections.find((d) => d.id === 'd3')?.embedding).toEqual([0.1, 0.2, 0.3, 0.4])
  })

  it('a person with no embedding-bearing children emits no embedding', () => {
    const person = makePerson('d1')
    const face = makeFaceDetail('d2', 'd1')
    delete (face as { embedding?: unknown }).embedding
    delete (face as { embeddingModelId?: unknown }).embeddingModelId

    const frame = buildFrameResult(buildArgs([person, face]))
    expect('embedding' in (frame.detections.find((d) => d.id === 'd1') ?? {})).toBe(false)
  })

  it("emits the face detail's aligned crop (exact ArcFace input) verbatim, without inheriting it onto the parent", () => {
    const person = makePerson('d1')
    const face = makeFaceDetail('d2', 'd1')
    ;(face as { faceAlignedCrop?: string }).faceAlignedCrop = 'QUxJR05FRA==' // "ALIGNED"

    const frame = buildFrameResult(buildArgs([person, face]))

    // Face carries its exact aligned crop verbatim.
    expect(frame.detections.find((d) => d.id === 'd2')?.faceAlignedCrop).toBe('QUxJR05FRA==')
    // The parent person inherits the embedding but NOT the aligned crop — the
    // person box is not the model input.
    const emittedPerson = frame.detections.find((d) => d.id === 'd1')
    expect(emittedPerson?.embedding).toEqual([0.5, 0.5, 0.5, 0.5])
    expect('faceAlignedCrop' in (emittedPerson ?? {})).toBe(false)
  })

  it('omits faceAlignedCrop on a face detail that has none', () => {
    const face = makeFaceDetail('d2', 'd1')
    const frame = buildFrameResult(buildArgs([face]))
    expect('faceAlignedCrop' in (frame.detections.find((d) => d.id === 'd2') ?? {})).toBe(false)
  })

  it('a detection keeps its OWN embedding instead of inheriting from a child', () => {
    // Guards the `if (embedding === undefined)` precedence: a parent that
    // already carries its own embedding must not be overwritten by a child's.
    const person = makePerson('d1')
    ;(person as { embedding: readonly number[] }).embedding = [0.9, 0.0, 0.0, 0.0]
    ;(person as { embeddingModelId: string }).embeddingModelId = 'own-model'
    const child = makeFaceDetail('d2', 'd1') // score 0.9, [0.5,0.5,0.5,0.5], arcface-r100

    const frame = buildFrameResult(buildArgs([person, child]))

    const emittedPerson = frame.detections.find((d) => d.id === 'd1')
    expect(emittedPerson?.embedding).toEqual([0.9, 0.0, 0.0, 0.0]) // own, not the child's
    expect(emittedPerson?.embeddingModelId).toBe('own-model')
  })
})
