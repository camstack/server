/**
 * Retrain annotations / frames / collections live in `ctx.records` kinds (every node); no store
 * of theirs holds a settings-store client, so no write can reach a legacy table.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { makeFakeRecords } from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { pipelineAnalyticsRecordKinds } from '../../record-kinds.js'
import {
  wireRetrainAnnotationLedger,
  wireRetrainCollectionFrameLedger,
  wireRetrainCollectionLedger,
  wireRetrainFrameLedger,
} from '../../store/event-ledger-wiring.js'
import { RetrainAnnotationStore, type RetrainAnnotationDraft } from '../retrain-annotation-store.js'
import { RetrainCollectionStore } from '../retrain-collection-store.js'

describe('retrain IO on records (phase 5)', () => {
  let records: ReturnType<typeof makeFakeRecords>

  beforeEach(async () => {
    records = makeFakeRecords()
    await records.records.declare(pipelineAnalyticsRecordKinds)
  })

  it('replaceForFrame on records deletes prior rows for mediaKey then upserts', async () => {
    const wiring = { records: records.records }
    const frameId = 'retrain:t:replace'
    const otherFrame = 'retrain:t:other'
    records.seed('retrain-frames', {
      id: frameId,
      deviceId: 101,
      at: 1,
      data: {
        deviceId: 101,
        trackId: 't',
        sourceMediaId: 1,
        sourceKind: 'keyFrame',
        path: 'retrain/101/t/replace.jpg',
        sizeBytes: 10,
        width: 100,
        height: 100,
        copiedAt: 1,
        revision: 0,
      },
    })
    records.seed('retrain-annotations', {
      id: 'old-a',
      deviceId: 101,
      at: 1,
      data: {
        deviceId: 101,
        trackId: 't',
        mediaKey: frameId,
        bbox: { x: 0, y: 0, w: 0.1, h: 0.1 },
        macroClass: 'person',
        kind: 'subject',
        source: 'operator',
        createdAt: 1,
      },
    })
    records.seed('retrain-annotations', {
      id: 'keep-other-frame',
      deviceId: 101,
      at: 2,
      data: {
        deviceId: 101,
        trackId: 't',
        mediaKey: otherFrame,
        bbox: { x: 0, y: 0, w: 0.1, h: 0.1 },
        macroClass: 'person',
        kind: 'subject',
        source: 'operator',
        createdAt: 2,
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
    const draft: RetrainAnnotationDraft = {
      trackId: 't',
      deviceId: 101,
      mediaKey: frameId,
      bbox: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 },
      macroClass: 'vehicle',
      kind: 'subject',
      source: 'operator',
      label: 'new-only',
    }
    const saved = await annotations.replaceForFrame(frameId, [draft], { fromRevision: 0 })
    expect(saved.kind).toBe('saved')
    const table = records.tables.get('retrain-annotations')
    expect(table?.has('old-a')).toBe(false)
    expect(table?.has('keep-other-frame')).toBe(true)
    expect(table?.size).toBe(2)
    const fresh = [...(table?.values() ?? [])].find((r) => r.data['label'] === 'new-only')
    expect(fresh).toBeDefined()
  })

  it('replaceForFrame writes annotations and the bumped revision to records', async () => {
    const wiring = { records: records.records }
    const frameId = 'retrain:t:abc'
    records.seed('retrain-frames', {
      id: frameId,
      deviceId: 101,
      at: 1_700_000_000_000,
      data: {
        deviceId: 101,
        trackId: 't',
        sourceMediaId: 1,
        sourceKind: 'keyFrame',
        path: 'retrain/101/t/abc.jpg',
        sizeBytes: 10,
        width: 100,
        height: 100,
        copiedAt: 1_700_000_000_000,
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
    const draft: RetrainAnnotationDraft = {
      trackId: 't',
      deviceId: 101,
      mediaKey: frameId,
      bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 },
      macroClass: 'person',
      kind: 'subject',
      source: 'operator',
    }
    const saved = await annotations.replaceForFrame(frameId, [draft], { fromRevision: 0 })
    expect(saved.kind).toBe('saved')
    expect(records.tables.get('retrain-annotations')?.size).toBe(1)
    expect(records.tables.get('retrain-frames')?.get(frameId)?.data['revision']).toBe(1)
  })

  it('create collection lands in the records kind', async () => {
    const wiring = { records: records.records }
    const store = new RetrainCollectionStore({
      logger: makeSilentLogger(),
      now: () => 1,
      newId: () => 'c1',
      collectionLedger: wireRetrainCollectionLedger(wiring),
      membershipLedger: wireRetrainCollectionFrameLedger(wiring),
    })
    const created = await store.create({ name: 'porch night' })
    expect(created.kind).toBe('created')
    expect(records.tables.get('retrain-collections')?.has('c1')).toBe(true)
  })
})
