/**
 * Event ledger writes land in `ctx.records` (every node), never a legacy
 * collection. Only `EventStore` still holds a settings store (object-events), so
 * only its cases can — and do — assert the legacy motion/audio tables stay empty;
 * the other stores have no settings-store dependency at all.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { makeFakeRecords } from '../../__tests__/fake-records.js'
import { makeFakeSettingsStore, makeSilentLogger } from '../../__tests__/test-helpers.js'
import { pipelineAnalyticsRecordKinds } from '../../record-kinds.js'
import { AUDIO_EVENTS_COLLECTION, EventStore, MOTION_EVENTS_COLLECTION } from '../event-store.js'
import {
  wireAudioEventLedger,
  wireBirthDecisionLedger,
  wireFaceLedger,
  wireMotionEventLedger,
  wirePlateLedger,
  wireSensorEventLedger,
  wireTrackAliasLedger,
} from '../event-ledger-wiring.js'
import { BirthDecisionLedgerStore } from '../birth-decision-ledger-store.js'
import { TrackAliasStore } from '../track-alias-store.js'
import { FaceStore } from '../face-store.js'
import { PlateStore } from '../plate-store.js'
import { SensorEventStore } from '../sensor-event-store.js'
import { makeFakeEmbeddingIndex } from '../../__tests__/test-helpers.js'
import { FACE_ARCFACE_INDEX } from '../embedding-vector-index.js'

describe('phase-5 event ledgers (records path)', () => {
  let fakeStore: ReturnType<typeof makeFakeSettingsStore>
  let records: ReturnType<typeof makeFakeRecords>

  beforeEach(async () => {
    fakeStore = makeFakeSettingsStore()
    records = makeFakeRecords()
    await records.records.declare(pipelineAnalyticsRecordKinds)
  })

  it('insertMotion does not write the legacy motion-events collection on hub', async () => {
    const wiring = { records: records.records }
    const store = new EventStore({
      store: fakeStore.client,
      logger: makeSilentLogger(),
      motionLedger: wireMotionEventLedger(wiring),
      audioLedger: wireAudioEventLedger(wiring),
    })
    const id = await store.insertMotion({
      deviceId: 102,
      timestamp: 1_700_000_000_000,
      regionCount: 2,
      kind: 'motion',
    })
    expect(id).not.toBeNull()
    expect(fakeStore.data.has(MOTION_EVENTS_COLLECTION)).toBe(false)
    expect(records.tables.get('motion-events')?.size).toBe(1)
  })

  it('insertAudio does not write the legacy audio-events collection on hub', async () => {
    const wiring = { records: records.records }
    const store = new EventStore({
      store: fakeStore.client,
      logger: makeSilentLogger(),
      motionLedger: wireMotionEventLedger(wiring),
      audioLedger: wireAudioEventLedger(wiring),
    })
    await store.insertAudio({
      deviceId: 102,
      timestamp: 1_700_000_000_100,
      rms: 0.1,
      dbfs: -30,
      kind: 'audio',
    })
    expect(fakeStore.data.has(AUDIO_EVENTS_COLLECTION)).toBe(false)
    expect(records.tables.get('audio-events')?.size).toBe(1)
  })

  it('SensorEventStore.insert uses records on hub', async () => {
    const wiring = { records: records.records }
    const sensor = new SensorEventStore({
      logger: makeSilentLogger(),
      sensorLedger: wireSensorEventLedger(wiring),
    })
    await sensor.insert({
      id: 's1',
      deviceId: 1,
      sourceDeviceId: 9,
      kind: 'contact',
      value: { open: true },
      timestamp: 500,
    })
    expect(records.tables.get('sensor-events')?.has('s1')).toBe(true)
  })

  it('FaceStore.insert does not write the legacy faces collection on hub', async () => {
    const wiring = { records: records.records }
    const faces = new FaceStore({
      vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
      logger: makeSilentLogger(),
      faceLedger: wireFaceLedger(wiring),
    })
    await faces.insert({
      id: 'face-t1',
      deviceId: 102,
      trackId: 't1',
      timestamp: 900,
      embedding: [0.1, 0.2],
      assigned: false,
    })
    expect(records.tables.get('faces')?.has('face-t1')).toBe(true)
  })

  it('PlateStore.insert does not write the legacy plates collection on hub', async () => {
    const wiring = { records: records.records }
    const plates = new PlateStore({
      logger: makeSilentLogger(),
      plateLedger: wirePlateLedger(wiring),
    })
    await plates.insert({
      id: 'plate-t1',
      deviceId: 102,
      trackId: 't1',
      timestamp: 901,
      text: 'AB123CD',
      score: 0.9,
      corrected: false,
      assigned: false,
    })
    expect(records.tables.get('plates')?.has('plate-t1')).toBe(true)
  })

  it('TrackAliasStore.record does not write legacy track-aliases on hub', async () => {
    const wiring = { records: records.records }
    const aliases = new TrackAliasStore({
      aliasLedger: wireTrackAliasLedger(wiring),
    })
    await aliases.record(102, 'alias-a', 'survivor-t', 1_700_000_000_000)
    expect(records.tables.get('track-aliases')?.has('alias-a')).toBe(true)
  })

  it('deleteByIdsIn removes only named motion rows on the records path', async () => {
    const wiring = { records: records.records }
    const motionPayload = {
      deviceId: 102,
      regionCount: 1,
      kind: 'motion' as const,
    }
    for (const [id, timestamp] of [
      ['m-keep-a', 100],
      ['m-drop', 200],
      ['m-keep-b', 300],
    ] as const) {
      records.seed('motion-events', {
        id,
        deviceId: 102,
        at: timestamp,
        data: { ...motionPayload, timestamp },
      })
    }
    const store = new EventStore({
      store: fakeStore.client,
      logger: makeSilentLogger(),
      motionLedger: wireMotionEventLedger(wiring),
      audioLedger: wireAudioEventLedger(wiring),
    })
    await store.deleteByIdsIn('motion', ['m-drop'])
    const table = records.tables.get('motion-events')
    expect(table?.size).toBe(2)
    expect(table?.has('m-drop')).toBe(false)
    expect(table?.has('m-keep-a')).toBe(true)
    expect(table?.has('m-keep-b')).toBe(true)
  })

  it('BirthDecisionLedgerStore.append uses records on hub', async () => {
    const wiring = { records: records.records }
    const ledger = new BirthDecisionLedgerStore({
      logger: makeSilentLogger(),
      birthLedger: wireBirthDecisionLedger(wiring),
      newId: () => 'bd-1',
      trimEvery: 1,
      maxRows: 10_000,
    })
    await ledger.append({
      at: 100,
      deviceId: 102,
      sourceTrackId: 't-new',
      className: 'person',
      verdict: 'confirmed',
      reason: null,
      attempts: 1,
      deferredForMs: 0,
      decidedOnCoastedFrame: false,
      birthEvidenceAvailable: true,
      decidedByBirthEvidence: true,
      bestScore: null,
      appliedMinConfidence: null,
      cropSource: null,
      detectorModelId: null,
      detectorDeviceKey: null,
      detectorNodeId: null,
      firstSeen: null,
      motionOnsetAt: null,
      birthLatencyMs: null,
      birthIndexInBurst: null,
    })
    expect(records.tables.get('birth-decision-ledger')?.has('bd-1')).toBe(true)
  })
})
