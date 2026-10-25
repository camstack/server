/**
 * The detector a gate verdict was re-judged with joined the birth ledger row
 * with D925. A row written before it must still READ — the store `safeParse`s
 * every row, and one that failed would silently drop out of every aggregate.
 */
import { describe, expect, it } from 'vitest'
import { BirthDecisionRecordSchema } from '../birth-decision-ledger.js'

const preD925Row = {
  id: 'bd-1',
  at: 1,
  deviceId: 1439,
  sourceTrackId: '64sj03gxj0',
  className: 'person',
  verdict: 'suppressed',
  reason: 'scored-below-threshold',
  cropSource: 'native',
  attempts: 0,
  deferredForMs: 0,
  decidedOnCoastedFrame: false,
  birthEvidenceAvailable: false,
  decidedByBirthEvidence: false,
  bestScore: 0.31,
  appliedMinConfidence: 0.4,
  firstSeen: null,
  motionOnsetAt: null,
  birthLatencyMs: null,
  birthIndexInBurst: null,
}

describe('BirthDecisionRecordSchema — the re-detect detector (D925)', () => {
  it('reads a row written before D925 with every detector field null', () => {
    const row = BirthDecisionRecordSchema.parse(preD925Row)
    expect(row.detectorModelId).toBeNull()
    expect(row.detectorDeviceKey).toBeNull()
    expect(row.detectorNodeId).toBeNull()
  })

  it('keeps the session detector a new row carries', () => {
    const row = BirthDecisionRecordSchema.parse({
      ...preD925Row,
      detectorModelId: 'yolov9s-320-edgetpu',
      detectorDeviceKey: 'edgetpu:usb',
      detectorNodeId: 'agent-b',
    })
    expect(row).toMatchObject({
      detectorModelId: 'yolov9s-320-edgetpu',
      detectorDeviceKey: 'edgetpu:usb',
      detectorNodeId: 'agent-b',
    })
  })
})
