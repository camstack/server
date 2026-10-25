/** D692 §4: has a grouped-window member anything left to wait for? */
import type { DetailStepAnnounce } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { recognitionOutlook, type RecognitionOutlookInput } from '../recognition-outlook.js'

const FACE: DetailStepAnnounce = {
  stepId: 'face-detection',
  inputClasses: ['person'],
  cadence: { trigger: 'once' },
}
const PLATE: DetailStepAnnounce = {
  stepId: 'plate-detection',
  inputClasses: ['car'],
  cadence: { trigger: 'once' },
}
const base: RecognitionOutlookInput = {
  className: 'person',
  detailSteps: [FACE, PLATE],
  faceRecognizerWired: true,
  firstFaceAt: undefined,
  now: 100_000,
  faceSettleHoldMs: 20_000,
}

describe('recognitionOutlook (D692 §4)', () => {
  it('a recognition label is final', () => {
    expect(recognitionOutlook({ ...base, labelKind: 'identity' })).toEqual({ final: true })
    expect(recognitionOutlook({ ...base, className: 'car', labelKind: 'plate' })).toEqual({
      final: true,
    })
  })
  it('no announce yet is UNKNOWN (pending), never final', () => {
    expect(recognitionOutlook({ ...base, detailSteps: undefined })).toMatchObject({
      final: false,
      awaiting: 'unknown',
    })
  })
  it('a class no recognizer applies to is final at once; so is any class on an EMPTY announce', () => {
    expect(recognitionOutlook({ ...base, className: 'dog' })).toEqual({ final: true })
    expect(recognitionOutlook({ ...base, detailSteps: [] })).toEqual({ final: true })
  })
  it('a person whose face has not shown is pending face-unseen', () => {
    expect(recognitionOutlook(base)).toEqual({ final: false, awaiting: 'face-unseen' })
  })
  it('a face shown 3 s ago is pending; at the 20 s cap it is final', () => {
    expect(recognitionOutlook({ ...base, firstFaceAt: 97_000 })).toEqual({
      final: false,
      awaiting: 'face',
    })
    expect(recognitionOutlook({ ...base, firstFaceAt: 80_000 })).toEqual({ final: true })
  })
  it('a car on a plate camera waits for its plate — there is no unreadable verdict', () => {
    expect(recognitionOutlook({ ...base, className: 'car' })).toEqual({
      final: false,
      awaiting: 'plate',
    })
  })
  it('a face step without a wired recognizer is UNKNOWN, not final', () => {
    expect(recognitionOutlook({ ...base, faceRecognizerWired: false })).toMatchObject({
      final: false,
      awaiting: 'unknown',
    })
  })
})
