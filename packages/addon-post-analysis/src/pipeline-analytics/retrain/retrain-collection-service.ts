/**
 * RetrainCollectionService — the bodies behind the named-collection cap
 * methods, and the only writer of RECORDING stills into the retrain corpus.
 *
 * ## A frame the model saw nothing in
 *
 * The track-curation path can only offer frames a track produced, so the one
 * failure a detector fine-tune most needs — the person the model never boxed —
 * was unreachable: no track, no media row, nothing to copy. A recording still
 * is that frame: the recorder re-decodes the native frame at a playhead
 * instant (`RecordedStillService`, the HIGH profile, never downscaled here),
 * and the dataset copies it like any other retrain frame — trackless, owned
 * outright on the durable tenant, annotatable and exportable through the
 * same paths.
 *
 * ## A collection is a set, so deletion asks who else holds the frame
 *
 * A recording still exists only because some collection holds it. Removing
 * it from its last collection (or deleting that collection) removes the frame
 * with its annotations — an unreachable frame would still be exported. A
 * track copy is reachable from its track, so a collection never deletes one.
 */

import type {
  IScopedLogger,
  PreparedTransactOp,
  RetrainFrame as WireFrame,
  RetrainVerdictSubject,
} from '@camstack/types'
import type { RecoveredStill } from '../recorded-still.js'
import type { RetrainAnnotationStore } from './retrain-annotation-store.js'
import type {
  RetrainCollection,
  RetrainCollectionCreateResult,
  RetrainCollectionRenameResult,
  RetrainCollectionStore,
} from './retrain-collection-store.js'
import {
  type RetrainFrame,
  type RetrainFrameStore,
  recordingFrameId,
} from './retrain-frame-store.js'
import type { RetrainService } from './retrain-service.js'

/** Why a frame could not be added from the recording — every cause named. */
export type AddFromRecordingRefusal =
  | 'unknown-collection'
  /** Nothing was recorded then, a gap, or the decode produced no pixels. */
  | 'still-unavailable'
  /** The node is already decoding its bound of stills — try again. */
  | 'still-busy'
  | 'unreadable-image'
  | 'write-failed'

export type AddFromRecordingResult =
  | {
      readonly kind: 'added'
      readonly collectionId: string
      readonly frame: WireFrame
      /** The moment was already in the dataset; nothing was decoded. */
      readonly reused: boolean
    }
  | { readonly kind: 'refused'; readonly reason: AddFromRecordingRefusal; readonly detail?: string }

export interface AddFramesResult {
  readonly added: number
  readonly alreadyMember: number
  readonly unknownFrameIds: readonly string[]
}

export interface RetrainCollectionServiceDeps {
  readonly collections: RetrainCollectionStore
  readonly frames: RetrainFrameStore
  readonly annotations: RetrainAnnotationStore
  readonly retrain: RetrainService
  /** Decode the native frame at an instant from the recording. */
  readonly captureStill: (deviceId: number, epochMs: number) => Promise<RecoveredStill>
  readonly logger: IScopedLogger
}

/** What each still outcome tells the operator. */
const STILL_REFUSAL: Readonly<
  Record<
    Exclude<RecoveredStill['outcome'], 'ok'>,
    { reason: AddFromRecordingRefusal; detail: string }
  >
> = {
  'no-recording': {
    reason: 'still-unavailable',
    detail: 'this camera is not recording, so there is no footage to take a frame from',
  },
  'no-footage': {
    reason: 'still-unavailable',
    detail: 'no recorded footage covers that instant (a gap, or already pruned)',
  },
  'decode-failed': {
    reason: 'still-unavailable',
    detail: 'the footage is there but the frame could not be decoded',
  },
  busy: {
    reason: 'still-busy',
    detail: 'the recorder is already decoding other frames — try again in a moment',
  },
}

export class RetrainCollectionService {
  private readonly deps: RetrainCollectionServiceDeps

  constructor(deps: RetrainCollectionServiceDeps) {
    this.deps = deps
  }

  create(input: { name: string }): Promise<RetrainCollectionCreateResult> {
    return this.deps.collections.create(input)
  }

  list(): Promise<readonly RetrainCollection[]> {
    return this.deps.collections.list()
  }

  rename(input: { id: string; name: string }): Promise<RetrainCollectionRenameResult> {
    return this.deps.collections.rename(input)
  }

  /**
   * Delete a collection. Its recording stills that no other collection holds
   * go with it (annotations first); track copies always stay.
   */
  async delete(input: { id: string }): Promise<{ deleted: boolean; removedFrames: number }> {
    const result = await this.deps.collections.delete(input.id)
    if (!result.deleted) return { deleted: false, removedFrames: 0 }
    const removedFrames = await this.dropOrphanStills(result.memberFrameIds)
    return { deleted: true, removedFrames }
  }

  /**
   * Decode the frame at `epochMs` from the camera's recording and add it to
   * the collection. The moment already in the dataset is reused without a
   * decode; every refusal is named and writes nothing.
   */
  async addFrameFromRecording(input: {
    collectionId: string
    deviceId: number
    epochMs: number
    /** The subject a notification verdict froze: stored on the still as its own proposal. */
    verdictSubject?: RetrainVerdictSubject
  }): Promise<AddFromRecordingResult> {
    const tags = { deviceId: input.deviceId }
    if ((await this.deps.collections.getById(input.collectionId)) === null) {
      this.deps.logger.info('retrain collection add refused: unknown collection', {
        tags,
        meta: { collectionId: input.collectionId, epochMs: input.epochMs },
      })
      return { kind: 'refused', reason: 'unknown-collection' }
    }
    // A new still's row and its membership commit in ONE transaction (the blob
    // is written first): a failure never leaves a still no collection holds.
    const membershipOp = await this.deps.collections.addFrameOp({
      collectionId: input.collectionId,
      frameId: recordingFrameId(input.deviceId, input.epochMs),
      deviceId: input.deviceId,
    })
    const stored = await this.storeStill(
      input.deviceId,
      input.epochMs,
      membershipOp === null ? [] : [membershipOp],
      input.verdictSubject,
    )
    if (stored.kind === 'refused') {
      this.deps.logger.info('retrain collection add refused', {
        tags,
        meta: {
          collectionId: input.collectionId,
          epochMs: input.epochMs,
          reason: stored.reason,
        },
      })
      return stored
    }
    // A still that already existed wrote no row, so its membership was not part
    // of a transaction: add it now (the frame is there, nothing can dangle).
    let storedFrame = stored.frame
    if (stored.reused) {
      await this.deps.collections.addFrame({
        collectionId: input.collectionId,
        frameId: stored.frame.frameId,
        deviceId: input.deviceId,
      })
      // The moment was already in the dataset: the answer still belongs to it.
      if (input.verdictSubject !== undefined) {
        storedFrame =
          (await this.deps.frames.setVerdictSubject(stored.frame.frameId, input.verdictSubject)) ??
          stored.frame
      }
    }
    this.deps.logger.info('retrain frame added to a collection from the recording', {
      tags,
      meta: {
        collectionId: input.collectionId,
        frameId: stored.frame.frameId,
        epochMs: input.epochMs,
        reused: stored.reused,
      },
    })
    const [wire] = await this.deps.retrain.toWireFrames([storedFrame])
    if (wire === undefined) throw new Error('retrain: a stored still produced no wire frame')
    return { kind: 'added', collectionId: input.collectionId, frame: wire, reused: stored.reused }
  }

  /** Add frames already in the dataset (track copies or stills) to a collection. */
  async addFrames(input: {
    collectionId: string
    frameIds: readonly string[]
  }): Promise<AddFramesResult> {
    if ((await this.deps.collections.getById(input.collectionId)) === null) {
      return { added: 0, alreadyMember: 0, unknownFrameIds: [...input.frameIds] }
    }
    const frames = await this.deps.frames.getMany(input.frameIds)
    const known = new Set(frames.map((f) => f.frameId))
    let added = 0
    let alreadyMember = 0
    for (const frame of frames) {
      const fresh = await this.deps.collections.addFrame({
        collectionId: input.collectionId,
        frameId: frame.frameId,
        deviceId: frame.deviceId,
      })
      if (fresh) added += 1
      else alreadyMember += 1
    }
    return {
      added,
      alreadyMember,
      unknownFrameIds: input.frameIds.filter((id) => !known.has(id)),
    }
  }

  /**
   * Remove a frame from a collection. A recording still left in no collection
   * is deleted with its annotations; a track copy is never deleted here.
   */
  async removeFrame(input: {
    collectionId: string
    frameId: string
  }): Promise<{ removed: boolean; deletedFrame: boolean }> {
    const removed = await this.deps.collections.removeFrame(input)
    if (!removed) return { removed: false, deletedFrame: false }
    const deleted = await this.dropOrphanStills([input.frameId])
    return { removed: true, deletedFrame: deleted > 0 }
  }

  /** The frames of a collection, as the canvas lists them. */
  async listFrames(input: { collectionId: string }): Promise<readonly WireFrame[]> {
    const ids = await this.deps.collections.listFrameIds(input.collectionId)
    return this.deps.retrain.toWireFrames(await this.deps.frames.getMany(ids))
  }

  private async storeStill(
    deviceId: number,
    epochMs: number,
    withRow: readonly PreparedTransactOp[],
    verdictSubject?: RetrainVerdictSubject,
  ): Promise<
    | { readonly kind: 'stored'; readonly frame: RetrainFrame; readonly reused: boolean }
    | {
        readonly kind: 'refused'
        readonly reason: AddFromRecordingRefusal
        readonly detail?: string
      }
  > {
    // An existing copy of the moment needs no decode — the recording may even
    // have been pruned since, and the dataset already owns the pixels.
    const existing = await this.deps.frames.get(recordingFrameId(deviceId, epochMs))
    if (existing !== null) return { kind: 'stored', frame: existing, reused: true }
    const still = await this.deps.captureStill(deviceId, epochMs)
    if (still.outcome !== 'ok' || still.jpeg === undefined) {
      const refusal =
        still.outcome === 'ok' ? STILL_REFUSAL['decode-failed'] : STILL_REFUSAL[still.outcome]
      return { kind: 'refused', reason: refusal.reason, detail: refusal.detail }
    }
    const stored = await this.deps.frames.storeRecordingStill(
      {
        deviceId,
        epochMs,
        bytes: still.jpeg,
        ...(verdictSubject !== undefined ? { verdictSubject } : {}),
      },
      withRow,
    )
    return stored.kind === 'copied'
      ? { kind: 'stored', frame: stored.frame, reused: stored.reused }
      : { kind: 'refused', reason: stored.reason }
  }

  /** Delete the recording stills among `frameIds` that no collection holds any more. */
  private async dropOrphanStills(frameIds: readonly string[]): Promise<number> {
    if (frameIds.length === 0) return 0
    const memberships = await this.deps.collections.collectionsOf(frameIds)
    const orphans = (await this.deps.frames.getMany(frameIds)).filter(
      (f) => f.origin === 'recording' && (memberships.get(f.frameId)?.length ?? 0) === 0,
    )
    for (const frame of orphans) await this.deps.retrain.removeFrame(frame)
    return orphans.length
  }
}
