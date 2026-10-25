/**
 * `cropSource` joined the birth ledger row with D922. A row written before it
 * must still READ — the store `safeParse`s every row, and one that failed
 * would silently drop out of every aggregate.
 */
import { describe, expect, it } from 'vitest'
import { BirthDecisionRecordSchema } from '../birth-decision-ledger.js'

const preD922Row = {
  id: 'bd-1',
  at: 1,
  deviceId: 1439,
  sourceTrackId: '64sj03gxj0',
  className: 'person',
  verdict: 'suppressed',
  reason: 'suppressed',
  attempts: 0,
  deferredForMs: 0,
  decidedOnCoastedFrame: false,
  birthEvidenceAvailable: false,
  decidedByBirthEvidence: false,
  bestScore: null,
  appliedMinConfidence: 0.4,
  firstSeen: null,
  motionOnsetAt: null,
  birthLatencyMs: null,
  birthIndexInBurst: null,
}

describe('BirthDecisionRecordSchema — cropSource', () => {
  it('reads a row written before D922 with cropSource null', () => {
    expect(BirthDecisionRecordSchema.parse(preD922Row).cropSource).toBeNull()
  })

  it('keeps the crop source a new row carries', () => {
    const row = { ...preD922Row, reason: 'below-detector-floor', cropSource: 'native' }
    expect(BirthDecisionRecordSchema.parse(row).cropSource).toBe('native')
  })
})
