import { describe, expect, it } from 'vitest'
import { MAX_BIRTH_LATENCY_PROXY_MS } from '@camstack/types'
import {
  buildBirthDecisionRecord,
  type BirthDecisionRecordInput,
} from '../birth-decision-record.js'
import { MotionOnsetRegistry } from '../motion-onset-registry.js'

const base: BirthDecisionRecordInput = {
  deviceId: 102,
  trackId: 'd035f251',
  className: 'person',
  confirmed: true,
  exhaustedFallback: false,
  attempts: 0,
  deferredForMs: 0,
  matchedThisFrame: true,
  birthEvidenceAvailable: false,
  decidedByBirthEvidence: false,
  decidedAtMs: 1_000_000,
  firstSeen: 999_000,
  motionOnsetAtMs: null,
  birthIndexInBurst: null,
}

describe('buildBirthDecisionRecord — the verdict', () => {
  it('reports a plain confirmation', () => {
    const r = buildBirthDecisionRecord(base)
    expect(r.verdict).toBe('confirmed')
    expect(r.decidedOnCoastedFrame).toBe(false)
  })

  it('reports a suppression and carries no firstSeen — a suppressed birth has no track', () => {
    const r = buildBirthDecisionRecord({ ...base, confirmed: false, firstSeen: 999_000 })
    expect(r.verdict).toBe('suppressed')
    expect(r.firstSeen).toBeNull()
    expect(r.birthLatencyMs).toBeNull()
  })

  it('separates the fail-open from an ordinary confirmation', () => {
    const r = buildBirthDecisionRecord({
      ...base,
      exhaustedFallback: true,
      attempts: 3,
      deferredForMs: 2100,
    })
    expect(r.verdict).toBe('exhausted-fallback')
    expect(r.attempts).toBe(3)
    expect(r.deferredForMs).toBe(2100)
  })

  it('never reports the fail-open for a SUPPRESSED birth — exhaustion only ever waves one through', () => {
    const r = buildBirthDecisionRecord({ ...base, confirmed: false, exhaustedFallback: true })
    expect(r.verdict).toBe('suppressed')
  })
})

describe('buildBirthDecisionRecord — a suppression says why, on what, with what score (D922)', () => {
  it('carries the reason, the score and WHICH pixels decided it', () => {
    const r = buildBirthDecisionRecord({
      ...base,
      confirmed: false,
      reason: 'below-detector-floor',
      bestScore: 0.55,
      appliedMinConfidence: 0.4,
      cropSource: 'native',
    })
    expect(r.verdict).toBe('suppressed')
    expect(r.reason).toBe('below-detector-floor')
    expect(r.bestScore).toBe(0.55)
    expect(r.cropSource).toBe('native')
  })

  it('reports no crop source for a decision that measured nothing', () => {
    const r = buildBirthDecisionRecord({ ...base, reason: 'no-crop' })
    expect(r.cropSource).toBeNull()
  })
})

describe('buildBirthDecisionRecord — the detector that re-judged it (D925)', () => {
  it('carries the session detector: model, device pool and node', () => {
    const r = buildBirthDecisionRecord({
      ...base,
      reason: 'confirmed',
      detector: { modelId: 'yolov9s-320-edgetpu', deviceKey: 'edgetpu:usb', nodeId: 'amd' },
    })
    expect(r.detectorModelId).toBe('yolov9s-320-edgetpu')
    expect(r.detectorDeviceKey).toBe('edgetpu:usb')
    expect(r.detectorNodeId).toBe('amd')
  })

  it('names no detector when none was asked', () => {
    const r = buildBirthDecisionRecord({ ...base, reason: 'no-crop' })
    expect([r.detectorModelId, r.detectorDeviceKey, r.detectorNodeId]).toEqual([null, null, null])
  })
})

describe('buildBirthDecisionRecord — the coasted-frame column (the re-offer defect)', () => {
  it('marks a decision taken on a frame the subject was not observed in', () => {
    const r = buildBirthDecisionRecord({ ...base, matchedThisFrame: false })
    expect(r.decidedOnCoastedFrame).toBe(true)
  })

  it('treats an ABSENT flag as matched, like every other consumer of it', () => {
    const r = buildBirthDecisionRecord({ ...base, matchedThisFrame: undefined })
    expect(r.decidedOnCoastedFrame).toBe(false)
  })

  it('keeps "evidence was available" and "evidence decided it" apart', () => {
    const r = buildBirthDecisionRecord({
      ...base,
      matchedThisFrame: false,
      birthEvidenceAvailable: true,
      decidedByBirthEvidence: false,
    })
    expect(r.birthEvidenceAvailable).toBe(true)
    expect(r.decidedByBirthEvidence).toBe(false)
  })
})

describe('buildBirthDecisionRecord — the birth-latency proxy', () => {
  it('measures firstSeen against the motion onset', () => {
    const r = buildBirthDecisionRecord({
      ...base,
      firstSeen: 999_000,
      motionOnsetAtMs: 995_500,
      birthIndexInBurst: 0,
    })
    expect(r.birthLatencyMs).toBe(3500)
    expect(r.motionOnsetAt).toBe(995_500)
    expect(r.birthIndexInBurst).toBe(0)
  })

  it('stores a NEGATIVE latency as measured — a clamp would fabricate the left tail', () => {
    const r = buildBirthDecisionRecord({
      ...base,
      firstSeen: 999_000,
      motionOnsetAtMs: 999_400,
      birthIndexInBurst: 0,
    })
    expect(r.birthLatencyMs).toBe(-400)
  })

  it('refuses an onset older than the proxy window rather than reporting a large number', () => {
    const r = buildBirthDecisionRecord({
      ...base,
      firstSeen: 999_000,
      motionOnsetAtMs: 999_000 - MAX_BIRTH_LATENCY_PROXY_MS - 1,
      birthIndexInBurst: 4,
    })
    expect(r.birthLatencyMs).toBeNull()
    expect(r.motionOnsetAt).toBeNull()
    expect(r.birthIndexInBurst).toBeNull()
  })

  it('reports null when this runner has no motion reference at all', () => {
    const r = buildBirthDecisionRecord({ ...base, motionOnsetAtMs: null })
    expect(r.birthLatencyMs).toBeNull()
    expect(r.motionOnsetAt).toBeNull()
  })

  it('keeps a LATER burst index — the row records it, the reader filters on it', () => {
    const r = buildBirthDecisionRecord({
      ...base,
      firstSeen: 999_000,
      motionOnsetAtMs: 997_000,
      birthIndexInBurst: 3,
    })
    expect(r.birthIndexInBurst).toBe(3)
    expect(r.birthLatencyMs).toBe(2000)
  })
})

describe('MotionOnsetRegistry', () => {
  it('has no reference before a rising edge', () => {
    const reg = new MotionOnsetRegistry()
    expect(reg.onsetFor(102)).toBeNull()
    expect(reg.noteBirth(102)).toBeNull()
  })

  it('remembers the rising edge and counts births against it', () => {
    const reg = new MotionOnsetRegistry()
    reg.noteRisingEdge(102, 5000)
    expect(reg.onsetFor(102)).toBe(5000)
    expect(reg.noteBirth(102)).toBe(0)
    expect(reg.noteBirth(102)).toBe(1)
  })

  it('a NEW rising edge opens a new burst and restarts the index', () => {
    const reg = new MotionOnsetRegistry()
    reg.noteRisingEdge(102, 5000)
    reg.noteBirth(102)
    reg.noteRisingEdge(102, 9000)
    expect(reg.onsetFor(102)).toBe(9000)
    expect(reg.noteBirth(102)).toBe(0)
  })

  it('keeps cameras apart', () => {
    const reg = new MotionOnsetRegistry()
    reg.noteRisingEdge(102, 5000)
    expect(reg.onsetFor(101)).toBeNull()
  })

  it('forgets a device wholesale', () => {
    const reg = new MotionOnsetRegistry()
    reg.noteRisingEdge(102, 5000)
    reg.forgetDevice(102)
    expect(reg.onsetFor(102)).toBeNull()
  })
})
