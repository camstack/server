/**
 * Shared `FaceStore` / `PlateStore` construction + row builders for the
 * fusion specs — over the records world (`makeAnalyticsRecords`), the same
 * ledgers `index.ts` wires, plus a recording `TrackFusionMediaPort` fake.
 */
import { FACE_ARCFACE_INDEX } from '../store/embedding-vector-index.js'
import { wireFaceLedger, wirePlateLedger } from '../store/event-ledger-wiring.js'
import type { FaceRecord } from '../store/face-store.js'
import { FaceStore } from '../store/face-store.js'
import type { Plate } from '../store/plate-store.js'
import { PlateStore } from '../store/plate-store.js'
import type { TrackFusionMediaPort, TrackMediaOwnerKind } from '../pipeline/track-fusion-leaf.js'
import { instrumentRecords, makeAnalyticsRecords } from './fake-records.js'
import { makeFakeEmbeddingIndex, makeSilentLogger } from './test-helpers.js'

async function faultyWorld(): Promise<ReturnType<typeof instrumentRecords>> {
  const world = await makeAnalyticsRecords()
  return instrumentRecords(world.records)
}

function faceStoreOver(records: ReturnType<typeof instrumentRecords>['records']): FaceStore {
  return new FaceStore({
    vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
    logger: makeSilentLogger(),
    faceLedger: wireFaceLedger({ records }),
  })
}

function plateStoreOver(records: ReturnType<typeof instrumentRecords>['records']): PlateStore {
  return new PlateStore({ logger: makeSilentLogger(), plateLedger: wirePlateLedger({ records }) })
}

export async function buildFaceStoreForTest(): Promise<FaceStore> {
  return faceStoreOver((await makeAnalyticsRecords()).records)
}

export async function buildPlateStoreForTest(): Promise<PlateStore> {
  return plateStoreOver((await makeAnalyticsRecords()).records)
}

export interface PlateStoreWithFailingSet {
  readonly store: PlateStore
  /** Arms the NEXT row write (i.e. the next `insert`) to throw once, then
   *  resume writing normally (review H2). */
  readonly armFailNextSet: () => void
}

/** A `PlateStore` whose next row write can be told to fail once, mirroring
 *  {@link buildFaceStoreForTestWithFailingSet}. */
export async function buildPlateStoreForTestWithFailingSet(): Promise<PlateStoreWithFailingSet> {
  const faulty = await faultyWorld()
  return { store: plateStoreOver(faulty.records), armFailNextSet: () => faulty.armFailNext('put') }
}

export interface FaceStoreWithFailingSet {
  readonly store: FaceStore
  /** Arms the NEXT row write (i.e. the next `insert`) to throw once, then
   *  resume writing normally (review H2). */
  readonly armFailNextSet: () => void
}

/** A `FaceStore` whose next row write can be told to fail once, for the "a
 *  swallowed insert must not still delete the only copy" spec. */
export async function buildFaceStoreForTestWithFailingSet(): Promise<FaceStoreWithFailingSet> {
  const faulty = await faultyWorld()
  return { store: faceStoreOver(faulty.records), armFailNextSet: () => faulty.armFailNext('put') }
}

export interface FaceStoreWithFailingDelete {
  readonly store: FaceStore
  /** Arms the NEXT row delete to throw once, then resume deleting normally
   *  (review N3 — the final `delete(fromId)` must be verified). */
  readonly armFailNextDelete: () => void
}

/** A `FaceStore` whose next row delete can be told to fail once. */
export async function buildFaceStoreForTestWithFailingDelete(): Promise<FaceStoreWithFailingDelete> {
  const faulty = await faultyWorld()
  return {
    store: faceStoreOver(faulty.records),
    armFailNextDelete: () => faulty.armFailNext('delete'),
  }
}

export interface PlateStoreWithFailingDelete {
  readonly store: PlateStore
  /** Arms the NEXT row delete to throw once, mirroring
   *  {@link buildFaceStoreForTestWithFailingDelete}. */
  readonly armFailNextDelete: () => void
}

/** A `PlateStore` whose next row delete can be told to fail once. */
export async function buildPlateStoreForTestWithFailingDelete(): Promise<PlateStoreWithFailingDelete> {
  const faulty = await faultyWorld()
  return {
    store: plateStoreOver(faulty.records),
    armFailNextDelete: () => faulty.armFailNext('delete'),
  }
}

export interface FaceStoreWithFailingUpdate {
  readonly store: FaceStore
  /** Arms the NEXT row patch to throw once, then resume updating normally
   *  (review P3 — the survivor's stale `keyFrameMediaId` clear must be
   *  verified, like every other write in this leaf). */
  readonly armFailNextUpdate: () => void
}

/** A `FaceStore` whose next row patch can be told to fail once. */
export async function buildFaceStoreForTestWithFailingUpdate(): Promise<FaceStoreWithFailingUpdate> {
  const faulty = await faultyWorld()
  return {
    store: faceStoreOver(faulty.records),
    armFailNextUpdate: () => faulty.armFailNext('patch'),
  }
}

export interface PlateStoreWithFailingUpdate {
  readonly store: PlateStore
  /** Arms the NEXT row patch to throw once, mirroring
   *  {@link buildFaceStoreForTestWithFailingUpdate}. */
  readonly armFailNextUpdate: () => void
}

/** A `PlateStore` whose next row patch can be told to fail once. */
export async function buildPlateStoreForTestWithFailingUpdate(): Promise<PlateStoreWithFailingUpdate> {
  const faulty = await faultyWorld()
  return {
    store: plateStoreOver(faulty.records),
    armFailNextUpdate: () => faulty.armFailNext('patch'),
  }
}

/** Review L4: named types only — no inline types on signatures. */
export type FaceRowInput = Partial<FaceRecord> & { readonly trackId: string }

/** A complete `FaceRecord`, id `face-<trackId>`, `assigned: false` by default,
 *  a 4-float embedding. */
export function faceRow(partial: FaceRowInput): FaceRecord {
  return {
    deviceId: 1,
    timestamp: 1000,
    embedding: [0.1, 0.2, 0.3, 0.4],
    assigned: false,
    ...partial,
    id: `face-${partial.trackId}`,
  }
}

export type PlateRowInput = Partial<Plate> & { readonly trackId: string }

/** A complete `Plate`, id `plate-<trackId>`, `assigned: false` by default. */
export function plateRow(partial: PlateRowInput): Plate {
  return {
    deviceId: 1,
    timestamp: 1000,
    text: 'AB123CD',
    score: 0.5,
    corrected: false,
    assigned: false,
    ...partial,
    id: `plate-${partial.trackId}`,
  }
}

export interface RecordingMediaPort extends TrackFusionMediaPort {
  readonly calls: string[]
}

export interface RecordingMediaPortOptions {
  /** Media ids `stillPresent` answers `false` for (review M2) — everything
   *  else answers `true`. */
  readonly absentMediaIds?: ReadonlySet<number>
}

/** A `TrackFusionMediaPort` that records `move <kind> <from> <to>` /
 *  `delete <kind> <id>` and answers 1 row moved/deleted. `stillPresent`
 *  answers `true` unless the id is named in `absentMediaIds`. */
export function recordingMediaPort(options: RecordingMediaPortOptions = {}): RecordingMediaPort {
  const calls: string[] = []
  const absent = options.absentMediaIds ?? new Set<number>()
  return {
    calls,
    moveOwner: async (kind: TrackMediaOwnerKind, fromOwnerId: string, toOwnerId: string) => {
      calls.push(`move ${kind} ${fromOwnerId} ${toOwnerId}`)
      return 1
    },
    deleteOwner: async (kind: TrackMediaOwnerKind, ownerId: string) => {
      calls.push(`delete ${kind} ${ownerId}`)
      return 1
    },
    stillPresent: async (mediaId: number) => !absent.has(mediaId),
  }
}
