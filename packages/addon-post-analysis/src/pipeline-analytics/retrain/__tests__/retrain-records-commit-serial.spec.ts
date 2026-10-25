/**
 * Records-path frame commits must not interleave on one mediaKey (revision guard alone
 * is not atomic across delete → insert → bump).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { makeFakeRecords } from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { pipelineAnalyticsRecordKinds } from '../../record-kinds.js'
import {
  wireRetrainAnnotationLedger,
  wireRetrainFrameLedger,
} from '../../store/event-ledger-wiring.js'
import { RetrainAnnotationStore, type RetrainAnnotationDraft } from '../retrain-annotation-store.js'

describe('RetrainAnnotationStore records commit serialization', () => {
  let records: ReturnType<typeof makeFakeRecords>

  beforeEach(async () => {
    records = makeFakeRecords()
    await records.records.declare(pipelineAnalyticsRecordKinds)
  })

  it('concurrent replaceForFrame on one frame yields one saved and one conflict', async () => {
    const wiring = { records: records.records }
    const frameId = 'retrain:t:race'
    records.seed('retrain-frames', {
      id: frameId,
      deviceId: 101,
      at: 1,
      data: {
        deviceId: 101,
        trackId: 't',
        sourceMediaId: 1,
        sourceKind: 'keyFrame',
        path: 'retrain/101/t/race.jpg',
        sizeBytes: 10,
        width: 100,
        height: 100,
        copiedAt: 1,
        revision: 0,
      },
    })
    let counter = 0
    const annotations = new RetrainAnnotationStore({
      logger: makeSilentLogger(),
      now: () => 9,
      newId: () => {
        counter += 1
        return `ann-${String(counter)}`
      },
      annotationLedger: wireRetrainAnnotationLedger(wiring),
      frameLedger: wireRetrainFrameLedger(wiring),
    })
    const draft = (label: string): RetrainAnnotationDraft => ({
      trackId: 't',
      deviceId: 101,
      mediaKey: frameId,
      bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 },
      macroClass: 'person',
      kind: 'subject',
      source: 'operator',
      label,
    })
    const [first, second] = await Promise.all([
      annotations.replaceForFrame(frameId, [draft('a')], { fromRevision: 0 }),
      annotations.replaceForFrame(frameId, [draft('b')], { fromRevision: 0 }),
    ])
    const kinds = [first.kind, second.kind].toSorted()
    expect(kinds).toEqual(['conflict', 'saved'])
    expect(records.tables.get('retrain-annotations')?.size).toBe(1)
    const row = [...(records.tables.get('retrain-annotations')?.values() ?? [])][0]
    expect(row?.data['label']).toBeDefined()
  })
})
