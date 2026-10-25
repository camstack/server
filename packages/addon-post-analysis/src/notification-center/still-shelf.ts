/**
 * The still shelf — the PHOTOGRAPH a notification carries when nothing it can
 * name owns a frame.
 *
 * ## Why a trigger needs one at all
 *
 * The attachment ladder resolves media by OWNER, and most triggers have one: an
 * object or package event owns its crops, a closed track owns its best shot, a
 * doorbell press owns the marker track the same press projected
 * (`sensor-marker-projector.ts`), an occupancy edge names one of the objects it
 * counted (`chooseOccupancyMediaOwner`). Two triggers own nothing, and for the
 * same reason in both cases — the subject is an ABSENCE:
 *
 *  - an **audio** match: nothing was boxed, nothing was tracked, and —
 *    deliberately — nothing is persisted at all. A confirmed window is a claim
 *    about sound that has already stopped, and `event-intake.ts` states why
 *    replaying it later would be wrong.
 *  - an **occupancy** edge whose scope is EMPTY — "posto libero". The vehicle
 *    whose departure IS the news has left, so `chooseOccupancyMediaOwner` names
 *    nobody and the ladder logs `no still could be resolved … owners=[]`.
 *
 * So the only honest picture is a PHOTOGRAPH of the camera taken at the moment
 * of the trigger. Not of the sound, not of the object that left — of what the
 * camera can see now that it happened. For a freed parking space that is
 * exactly the answer the operator wants: the space, empty.
 *
 * **One shelf, not two.** The mechanism is identical down to the reuse window,
 * and the only thing that differs between the two triggers is the GATE deciding
 * that a photograph is owed at all — which belongs at the trigger site, where
 * the rules are, and not here. A twin module would be a second derivation of
 * one thing. The trigger rides along as {@link NcStillTrigger} only so the logs
 * can say which absence they are about.
 *
 * ## Three properties, and each one is a decision
 *
 * **It is not a record.** The bytes live here, in RAM, under an owner id and a
 * TTL that covers the outbox's whole retry horizon — and nowhere else. The
 * alternative was the doorbell's: materialise a synthetic marker track through
 * `SyntheticTrackMaterializer` and let the notification name it. That would put
 * a durable Track on the camera's timeline for every confirmed window and every
 * emptied zone, feeding the digest's `listTracks`, retention, and the audio-
 * marker feature's own operator ceilings (`audio-marker-projector.ts` exists
 * precisely to bound how many audio markers a camera may emit). A notification
 * must not manufacture timeline history as a side effect of wanting a picture.
 *
 * **The capture STARTS immediately and is never awaited.** The subject is
 * transient — a scream is over before a snapshot round-trip completes, and a
 * freed space is about to be taken by the next car — so the fetch is kicked off
 * at the trigger, before the rule evaluation runs, and the owner id is minted
 * synchronously so the outbox row can name it. The bytes land while the row
 * waits in the queue, and the dispatcher's existing bounded still-wait (or the
 * pause its own footage render already costs) picks them up. A camera that
 * never answers costs the picture and never the notification.
 *
 * **Two triggers seconds apart share ONE capture.** A barking dog confirms
 * repeatedly and a label-mode rule has no re-arm timer at all (D157) — the
 * rule's cooldown is its only brake, and the cooldown is applied AFTER this.
 * Without a reuse window this would photograph a camera at whatever rate the
 * sound happens to occur. Each trigger still gets its OWN owner id, so two
 * outbox rows are never mistaken for one subject; they merely point at the same
 * frame, which is the truth — the scene did not change in ten seconds. The
 * window is per CAMERA and trigger-agnostic for the same reason: a sound and an
 * emptied zone ten seconds apart are two claims about one scene.
 *
 * Nothing here is silent: a capture that lands and a camera that refuses each
 * emit one line carrying `tags: { deviceId }`, because "why did 102 get a photo
 * and 101 not" is the only form that question is ever asked in.
 */

import { randomUUID } from 'node:crypto'
import type { IScopedLogger, MediaFileBytes, MediaFileKind } from '@camstack/types'
import { nextUnstoredMediaId } from './unstored-media-id.js'
import {
  downscaleFullFrameJpeg,
  SYNTHETIC_SNAPSHOT_MAX_HEIGHT,
  SYNTHETIC_SNAPSHOT_MAX_WIDTH,
} from '../shared/frame/downscale-full-frame.js'

/**
 * Which absence this photograph stands in for. It changes NOTHING about the
 * capture — it is the noun the log lines use, so a grep for "why did this
 * camera get photographed" answers with the trigger that asked.
 */
export type NcStillTrigger = 'audio' | 'occupancy'

/**
 * The owner-id namespace. It is what routes a lookup here instead of to the
 * media store, and it is the reason the dispatcher needs no audio or occupancy
 * branch — `getMediaForOwner` answers for all of them under one signature.
 */
const NC_STILL_SHELF_PREFIX = 'nc-still:'

/** True for an owner id this shelf minted. */
export function isStillShelfId(id: string): boolean {
  return id.startsWith(NC_STILL_SHELF_PREFIX)
}

/**
 * How long the bytes are held.
 *
 * The outbox retries 8 times with a 5 s → 300 s backoff, which tops out around
 * ten minutes; fifteen covers that with room for a slow drain. Past it the row
 * ships text-only, which is the correct degradation for a photograph of a scene
 * that is a quarter of an hour stale anyway.
 */
export const NC_STILL_SHELF_TTL_MS = 15 * 60_000

/**
 * How long one capture answers for later triggers on the same camera.
 *
 * Ten seconds — the same window `SyntheticTrackMaterializer` debounces its
 * marker snapshots on, for the same reason and against the same snapshot cap.
 */
export const NC_STILL_SHELF_REUSE_MS = 10_000

/**
 * How far BEFORE a departure's dated moment its ring still is cut (D691).
 *
 * `observedAt` is either the departing read — the first frame that no longer
 * counted the subject, so it has just left the zone — or a parked entry's last
 * confirmation. A second earlier the subject is still in the picture in both
 * cases, and a second is far inside any ring a camera an occupancy rule follows
 * holds (60 s, `clip-retention-ask.ts`).
 */
export const NC_DEPARTURE_STILL_LEAD_MS = 1_000

/**
 * Where a capture's frame comes from.
 *
 *  - `live` — the snapshot cap: what the camera sees NOW. Right for a sound
 *    and for an arrival, whose subject is in the picture now.
 *  - `past` — the clip ring at the trigger's own instant (D691). Right for a
 *    departure: by the commit the subject has gone, and a live frame is the
 *    empty space.
 */
export type NcStillSource = 'live' | 'past'

/** A hanging snapshot cap must not pin a capture slot forever. */
const SNAPSHOT_TIMEOUT_MS = 8_000

/**
 * The bound on a PAST capture (D691). It may be served from the recordings
 * when the ring has lost the moment (review M2), and that cut owns D686's
 * 30 s bound (`NC_RECORDED_FOOTAGE_WAIT_MS`) as its deadline; this is that
 * plus the frame decode. Still a bound — a capture that never answers costs
 * the picture, never the notification.
 */
export const NC_PAST_STILL_TIMEOUT_MS = 32_000

/**
 * Hard bound on held captures. Reached only if every camera on the hub triggers
 * one inside a single TTL; the oldest is dropped first, which costs a
 * fifteen-minute-old picture nobody is waiting for.
 */
const MAX_CAPTURES = 64

/** One photograph, and whatever the fetch has made of it so far. */
interface HeldCapture {
  readonly deviceId: number
  readonly trigger: NcStillTrigger
  readonly startedAt: number
  readonly expiresAt: number
  /** Empty until the fetch lands, and forever if it fails. */
  readonly files: readonly MediaFileBytes[]
}

export interface NcStillShelfDeps {
  /**
   * The snapshot cap, WITHOUT `force`. `snapshot.cap.ts` defines `force` as the
   * operator's refresh button — a background caller that sets it walks past the
   * sleep gate and wakes a battery camera per event. Nobody pressed anything
   * here: a sound did, or a parking space emptied.
   */
  readonly getSnapshot: (
    deviceId: number,
  ) => Promise<{ readonly base64: string; readonly contentType: string } | null>
  /**
   * A frame of `deviceId` at the PAST instant `atMs`, cut from the clip ring
   * (D691). Absent where nothing can serve one — a `past` capture is then not
   * possible, and {@link NcStillShelf.canCapturePast} says so to the trigger,
   * which names the miss rather than falling back to a live frame.
   */
  readonly getPastStill?: (
    deviceId: number,
    atMs: number,
  ) => Promise<{ readonly base64: string; readonly contentType: string } | null>
  readonly logger: IScopedLogger
  readonly now: () => number
}

export class NcStillShelf {
  private readonly deps: NcStillShelfDeps
  /** captureId → the photograph. */
  private readonly captures = new Map<string, HeldCapture>()
  /** ownerId → captureId. Several owners may name one capture (the reuse window). */
  private readonly owners = new Map<string, string>()
  /** deviceId → its newest capture, for the reuse window. */
  private readonly newest = new Map<number, { readonly captureId: string; readonly at: number }>()

  constructor(deps: NcStillShelfDeps) {
    this.deps = deps
  }

  /**
   * Photograph `deviceId` for a trigger at `atMs`, and return the owner id the
   * subject should name. SYNCHRONOUS by contract: the caller is on the trigger
   * path and the outbox row is built from what this returns.
   */
  capture(
    deviceId: number,
    atMs: number,
    trigger: NcStillTrigger,
    source: NcStillSource = 'live',
  ): string {
    const now = this.deps.now()
    this.prune(now)
    const ownerId = `${NC_STILL_SHELF_PREFIX}${randomUUID()}`
    const recent = this.newest.get(deviceId)
    // A PAST frame is of its own instant: it shares nothing with the camera's
    // newest live capture, so the reuse window is a live-only economy.
    if (
      source === 'live' &&
      recent !== undefined &&
      now - recent.at < NC_STILL_SHELF_REUSE_MS &&
      this.captures.has(recent.captureId)
    ) {
      this.owners.set(ownerId, recent.captureId)
      return ownerId
    }
    const captureId = randomUUID()
    this.captures.set(captureId, {
      deviceId,
      trigger,
      startedAt: now,
      expiresAt: now + NC_STILL_SHELF_TTL_MS,
      files: [],
    })
    if (source === 'live') this.newest.set(deviceId, { captureId, at: now })
    this.owners.set(ownerId, captureId)
    void this.fetch(captureId, deviceId, atMs, trigger, source)
    return ownerId
  }

  /** Can this shelf cut a frame at a past instant? (D691) */
  canCapturePast(): boolean {
    return this.deps.getPastStill !== undefined
  }

  /**
   * The media an owner id holds, or `undefined` when this shelf never minted
   * it. An EMPTY array is a different answer: the capture exists and has not
   * landed (or never will), which is exactly the case the dispatcher's bounded
   * wait and its `no still could be resolved` line are for.
   */
  get(ownerId: string): readonly MediaFileBytes[] | undefined {
    const captureId = this.owners.get(ownerId)
    if (captureId === undefined) return undefined
    return this.captures.get(captureId)?.files ?? []
  }

  /** Drop expired captures and the owners that named them. */
  prune(now: number): void {
    for (const [captureId, held] of this.captures) {
      if (held.expiresAt > now) continue
      this.captures.delete(captureId)
      const newest = this.newest.get(held.deviceId)
      if (newest?.captureId === captureId) this.newest.delete(held.deviceId)
    }
    while (this.captures.size > MAX_CAPTURES) {
      const oldest = this.captures.keys().next()
      if (oldest.done === true) break
      const held = this.captures.get(oldest.value)
      this.captures.delete(oldest.value)
      if (held !== undefined && this.newest.get(held.deviceId)?.captureId === oldest.value) {
        this.newest.delete(held.deviceId)
      }
    }
    for (const [ownerId, captureId] of this.owners) {
      if (!this.captures.has(captureId)) this.owners.delete(ownerId)
    }
  }

  /** Drop everything (shutdown). */
  clear(): void {
    this.captures.clear()
    this.owners.clear()
    this.newest.clear()
  }

  private async fetch(
    captureId: string,
    deviceId: number,
    atMs: number,
    trigger: NcStillTrigger,
    source: NcStillSource,
  ): Promise<void> {
    try {
      const pastStill = this.deps.getPastStill
      const pending =
        source === 'past' && pastStill !== undefined
          ? pastStill(deviceId, atMs)
          : this.deps.getSnapshot(deviceId)
      const shot = await withTimeout(
        pending,
        source === 'past' ? NC_PAST_STILL_TIMEOUT_MS : SNAPSHOT_TIMEOUT_MS,
      )
      if (shot === null || shot.base64.length === 0) {
        this.reportMiss(
          deviceId,
          trigger,
          source === 'past'
            ? 'the ring returned no frame at that instant'
            : 'the camera returned no snapshot',
        )
        return
      }
      const raw = Buffer.from(shot.base64, 'base64')
      let data: Buffer = raw
      try {
        // A phone notification is glanced at, and the degrade engine DROPS an
        // attachment over a backend's byte cap outright (pushover: 5 MiB) — a
        // raw 4K frame is exactly the attachment that arrives as nothing.
        data = await downscaleFullFrameJpeg(
          raw,
          SYNTHETIC_SNAPSHOT_MAX_WIDTH,
          SYNTHETIC_SNAPSHOT_MAX_HEIGHT,
        )
      } catch {
        // The raw frame is a worse attachment, never a missing one.
      }
      const held = this.captures.get(captureId)
      // Expired or evicted while the camera was thinking. Nothing to hold it
      // for — the row that named it has already shipped text-only.
      if (held === undefined) return
      this.captures.set(captureId, { ...held, files: stillShelfMedia(data, atMs) })
      this.deps.logger.info(`${trigger} still captured`, {
        tags: { deviceId },
        meta: {
          trigger,
          source,
          atMs,
          bytes: data.byteLength,
          tookMs: this.deps.now() - held.startedAt,
        },
      })
    } catch (err) {
      this.reportMiss(deviceId, trigger, err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * A branch that drops work says so. This one costs the operator the picture
   * on a notification they DID receive, so it is a warn and it carries the
   * camera — the only key the question is ever asked with.
   */
  private reportMiss(deviceId: number, trigger: NcStillTrigger, reason: string): void {
    this.deps.logger.warn(
      `the camera did not answer the ${trigger} still — this notification ships text-only`,
      { tags: { deviceId }, meta: { trigger, reason } },
    )
  }
}

/**
 * The photograph, in the three kinds the CLEAN-SCENE ladders ask for.
 *
 * `keyFrameSmall` leads because it is the first rung of both `attach: 'best'`
 * and `attach: 'keyFrame'` on a track owner; `keyFrame` and `fullFrame` answer
 * `frame: 'full'` and `frame: 'boxed'`'s honest degrade. There is deliberately
 * no `crop` / `thumbnail`: nothing was boxed, so `frame: 'cropped'` resolves
 * NOTHING and the notification ships text-only with the ordinary line saying
 * so. Inventing a centre crop would answer a different question from the one
 * the operator asked.
 */
export function stillShelfMedia(data: Buffer, timestamp: number): readonly MediaFileBytes[] {
  const base64 = data.toString('base64')
  const file = (kind: MediaFileKind): MediaFileBytes => ({
    mediaId: nextUnstoredMediaId(),
    kind,
    base64,
    sizeBytes: data.byteLength,
    timestamp,
  })
  return [file('keyFrameSmall'), file('keyFrame'), file('fullFrame')]
}

/** Reject if `promise` does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`snapshot cap timed out after ${String(ms)}ms`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}
