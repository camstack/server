/**
 * The face source frame's PARK, over the track parcel client (D644, D422).
 *
 * A face's source frame is the track's best-FACE frame, which is not the
 * track's best frame, so it cannot share the track's `keyFrame` parcel. It is
 * parked under its own key: the runner treats `trackId` as opaque ("the hub
 * owns it"), so the face parcel lives at `face-src:<trackId>` with kind
 * `keyFrame` — which on the runner means exactly what a face source needs, a
 * whole frame at the native cap (`KEYFRAME_NATIVE_MAX_WIDTH`). No new cap
 * method, no new wire field, so no framework release is needed for it. The
 * runner keeps `face-src:` parcels in their OWN budget
 * (`PartitionedParkedFrameStore`), so they can never evict a track parcel.
 *
 * ## The newest best face wins
 *
 * The parcel client JOINS a second order for a key already in flight — right
 * for a best frame decided twice on one frame, wrong here: the held face can
 * improve while the previous park is still travelling, and the joined order
 * would leave the node holding the OLDER frame. So this port keeps the latest
 * order per key and sends it as soon as the one in flight settles (a trailing
 * park). `take` waits for both. A trailing park whose handle aged out is
 * refused by the node and logged by the client; the keeper then sees a parcel
 * of another instant and stores nothing, loudly.
 */
import type { IScopedLogger } from '@camstack/types'
import { KEYFRAME_NATIVE_MAX_WIDTH } from '../pipeline/key-frame-capture.js'
import type { ParkOrder } from '../pipeline/track-park.js'
import type {
  FaceSourceFramePort,
  FaceSourceParcel,
  FaceSourceParkOrder,
  TrackKeyFrameParcel,
} from '../face-source-frame.js'
import type { ParkedFrameClient } from './parked-frame-client.js'

/** The runner-side key prefix of a face source parcel. */
export const FACE_SOURCE_PARK_PREFIX = 'face-src:'

/** At most this many trailing rounds `take` waits for; each is one park RPC. */
const TAKE_MAX_ROUNDS = 3

export function faceSourceParkKey(trackId: string): string {
  return `${FACE_SOURCE_PARK_PREFIX}${trackId}`
}

export interface FaceSourceParkPortDeps {
  /** The parcel client, read at call time (it is built after the recognizer). */
  client(): ParkedFrameClient | null
  isNodeOffline(nodeId: string): boolean
  /** The park's round trip (the runner's encode + one RPC), and whether it parked. */
  onParkSettled?(deviceId: number, ms: number, parked: boolean): void
  readonly now?: () => number
  readonly logger: Pick<IScopedLogger, 'debug'>
}

/** A face park as the parcel client takes it. Pure. */
export function toParkOrder(order: FaceSourceParkOrder): ParkOrder {
  const g = order.geometry
  return {
    deviceId: order.deviceId,
    trackId: faceSourceParkKey(order.trackId),
    kind: 'keyFrame',
    handle: order.frameHandle,
    bbox: { x: 0, y: 0, w: 1, h: 1 },
    maxWidth: KEYFRAME_NATIVE_MAX_WIDTH,
    timestamp: g.timestamp,
    subject: { bbox: g.bbox, frameWidth: g.frameWidth, frameHeight: g.frameHeight },
  }
}

export function createFaceSourceParkPort(deps: FaceSourceParkPortDeps): FaceSourceFramePort {
  const running = new Map<string, Promise<void>>()
  const trailing = new Map<string, ParkOrder>()
  /** Released while a park was still travelling: release again once it lands. */
  const releasedInFlight = new Set<string>()
  /** D683: survivor key → every absorbed key (their release rides on the survivor's). */
  const adoptedKeys = new Map<string, readonly string[]>()
  const now = deps.now ?? Date.now

  const send = (client: ParkedFrameClient, order: ParkOrder): void => {
    const key = order.trackId
    if (running.has(key)) {
      trailing.set(key, order)
      return
    }
    const startedAt = now()
    const run = client
      .park(order)
      .then((parked) => {
        deps.onParkSettled?.(order.deviceId, now() - startedAt, parked)
      })
      .finally(() => {
        running.delete(key)
        if (releasedInFlight.delete(key)) {
          client.release(key)
          return
        }
        const next = trailing.get(key)
        if (next !== undefined) {
          trailing.delete(key)
          send(client, next)
        }
      })
    running.set(key, run)
  }

  const park = (order: FaceSourceParkOrder): void => {
    const client = deps.client()
    if (client === null) return
    if (deps.isNodeOffline(order.frameHandle.nodeId)) {
      deps.logger.debug('face source park skipped — the owning node is offline', {
        tags: { deviceId: order.deviceId },
        meta: { trackId: order.trackId, nodeId: order.frameHandle.nodeId },
      })
      return
    }
    send(client, toParkOrder(order))
  }

  const take = async (deviceId: number, trackId: string): Promise<FaceSourceParcel | null> => {
    const client = deps.client()
    if (client === null) return null
    const key = faceSourceParkKey(trackId)
    // The survivor's parcel may be an absorbed piece's (D683): wait for
    // every member's park still travelling, not only the survivor's own.
    for (const member of [key, ...(adoptedKeys.get(key) ?? [])]) {
      for (let round = 0; round < TAKE_MAX_ROUNDS; round++) {
        const pending = running.get(member)
        if (pending === undefined) break
        await pending
      }
    }
    await client.awaitPark(key, 'keyFrame')
    const parcel = await client.fetch(key, 'keyFrame')
    if (parcel === null || parcel.info.deviceId !== deviceId) return null
    return {
      jpeg: parcel.jpeg,
      width: parcel.width,
      height: parcel.height,
      timestamp: parcel.timestamp,
    }
  }

  const release = (trackId: string): void => {
    const key = faceSourceParkKey(trackId)
    const members = adoptedKeys.get(key) ?? []
    adoptedKeys.delete(key)
    for (const k of [key, ...members]) {
      trailing.delete(k)
      if (running.has(k)) releasedInFlight.add(k)
    }
    // The client releases every member it was told about through `adopt`.
    deps.client()?.release(key)
  }

  const adopt = (
    survivorTrackId: string,
    absorbedTrackId: string,
    bestShotFrom: 'survivor' | 'absorbed',
  ): void => {
    const survivorKey = faceSourceParkKey(survivorTrackId)
    const absorbedKey = faceSourceParkKey(absorbedTrackId)
    adoptedKeys.set(survivorKey, [
      ...(adoptedKeys.get(survivorKey) ?? []),
      absorbedKey,
      ...(adoptedKeys.get(absorbedKey) ?? []),
    ])
    adoptedKeys.delete(absorbedKey)
    deps.client()?.adopt(survivorKey, absorbedKey, bestShotFrom)
  }

  const trackKeyFrame = (trackId: string): TrackKeyFrameParcel | undefined => {
    const info = deps.client()?.info(trackId, 'keyFrame')
    return info === undefined
      ? undefined
      : { timestamp: info.timestamp, width: info.width, height: info.height }
  }

  return { park, take, release, adopt, trackKeyFrame }
}
