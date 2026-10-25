/**
 * The hub's side of a PARK
 * ([D422](../../../../../docs/decisions/adr-0422-a-relevant-frame-is-parked-when-it-becomes-relevant.md)).
 *
 * `BestDetectionTracker` accepts a frame as a track's best; `buildParkOrders`
 * turns that into two parcels; THIS sends each order to the node that owns
 * the handle — pinned, while the handle is young — and remembers where the
 * parcel landed. Every later consumer (`persistTrackKeyFrame`, the best-shot
 * `thumbnail`, the detail plane's full-frame rung) comes back here with a
 * `(trackId, kind)` and gets the parcel from the node that answered the park.
 * Nothing in this file names a frame handle after the park; a retrieval keyed
 * by a track never falls back to one (`scripts/check-parked-frame-no-handle-fallback.ts`).
 *
 * ## The mirror
 *
 * The runner keeps the pixels; the hub keeps what the pixels cannot say —
 * which node holds them, the frame instant, the subject's box in detection
 * space and, for the thumbnail, the framing layout. It is refreshed by the
 * park's own answer and dropped at release, so a read here never asks the
 * cluster where a parcel is (D49: the gate is mirrored state, not a fallible
 * read).
 *
 * ## Two orders in flight for one key
 *
 * A best-frame decision and its consumer often fire on the SAME frame —
 * `persistKeyFrames` runs a few statements after `buildSnapshotTargets` —
 * so a consumer must be able to wait for the park it just caused rather
 * than race it. `awaitPark` is that wait; a second order for a key still in
 * flight joins the first RPC instead of stampeding the node.
 *
 * ## A park that fails is said, once, and not retried
 *
 * A refusal means the hub's decision reached the node after the surface was
 * swept — the fault the 150–500 ms window exists to prevent. It is logged
 * with `tags: { deviceId }`, the reason and the age the node measured. The
 * track's NEXT best frame will park on its own; retrying a dead handle is
 * what D419/D420 were written to end.
 */
import type {
  IPipelineRunnerProvider,
  IScopedLogger,
  NodePinnedRequestOptions,
  ParkedFrameKind,
  ParkedTrackFrame,
  ParkTrackFrameResult,
} from '@camstack/types'
import { errMsg, nodePin } from '@camstack/types'
import type { WideCentralSquareLayout } from '../../shared/frame/wide-central-square-crop.js'
import type { ParkOrder, ParkSubject } from '../pipeline/track-park.js'

/** Input of the `parkTrackFrame` cap method, as the provider declares it. */
type ParkTrackFrameInput = Parameters<IPipelineRunnerProvider['parkTrackFrame']>[0]
type GetParkedTrackFrameInput = Parameters<IPipelineRunnerProvider['getParkedTrackFrame']>[0]
type ReleaseParkedTrackFramesInput = Parameters<
  IPipelineRunnerProvider['releaseParkedTrackFrames']
>[0]

/**
 * The three procedures this client calls, structurally — so a test can hand
 * in fakes and `index.ts` hands in `api.pipelineRunner`. Method shorthand on
 * purpose: the generated tRPC client's `mutate`/`query` take a looser input
 * type, and a property-typed function would not be assignable.
 */
export interface ParkedFrameApi {
  readonly parkTrackFrame: {
    mutate(
      input: ParkTrackFrameInput,
      opts?: NodePinnedRequestOptions,
    ): Promise<ParkTrackFrameResult>
  }
  readonly getParkedTrackFrame: {
    query(
      input: GetParkedTrackFrameInput,
      opts?: NodePinnedRequestOptions,
    ): Promise<ParkedTrackFrame | null>
  }
  readonly releaseParkedTrackFrames: {
    mutate(
      input: ReleaseParkedTrackFramesInput,
      opts?: NodePinnedRequestOptions,
    ): Promise<{ released: number }>
  }
}

/** What the hub remembers about a parcel it ordered — never the pixels. */
export interface ParkedParcelInfo {
  readonly nodeId: string
  readonly deviceId: number
  readonly kind: ParkedFrameKind
  readonly timestamp: number
  readonly width: number
  readonly height: number
  readonly subject: ParkSubject
  readonly layout?: WideCentralSquareLayout
}

/** A retrieved parcel: the runner's JPEG plus what the hub kept beside it. */
export interface ParkedParcel {
  readonly jpeg: Buffer
  readonly width: number
  readonly height: number
  readonly timestamp: number
  readonly info: ParkedParcelInfo
}

export interface ParkedFrameClient {
  /** Send one order. `true` = parked; `false` = refused (already logged). */
  park(order: ParkOrder): Promise<boolean>
  /** Resolve once no park for `(trackId, kind)` is in flight. */
  awaitPark(trackId: string, kind: ParkedFrameKind): Promise<void>
  /** The mirror's record of a parcel, or undefined if none was ever parked. */
  info(trackId: string, kind: ParkedFrameKind): ParkedParcelInfo | undefined
  /** The parcel, from the node the park answered from; `null` = none. */
  fetch(trackId: string, kind: ParkedFrameKind): Promise<ParkedParcel | null>
  /** The track closed: drop its parcels on the node and here. */
  release(trackId: string): void
  /**
   * D683: `absorbedId` is now part of `survivorId`. Per kind, the survivor
   * reads the parcel of whichever id holds the CURRENT best shot: the absorbed
   * piece's (or one it had absorbed) when the merged ranking chose it, until
   * the survivor parks a newer best of its own — that park supersedes it
   * (review H3). Every other member is a fallback of last resort. `awaitPark`
   * waits on every member's park in flight (review H1); `release(survivorId)`
   * releases them all, including a park that lands after the release.
   * Every kind is a best-shot kind today (`ParkedFrameKind` is
   * `keyFrame | thumbnail`); a last-frame kind would need its own rule.
   */
  adopt(survivorId: string, absorbedId: string, bestShotFrom: 'survivor' | 'absorbed'): void
  dispose(): void
}

export interface ParkedFrameClientDeps {
  /** `api.pipelineRunner`, or undefined when the runner predates the method. */
  readonly api: ParkedFrameApi | undefined
  readonly logger: IScopedLogger
  readonly now?: () => number
  /**
   * The cluster registry's verdict on a node (D49-shaped: confirmed twice,
   * never a single read). Nothing is dispatched at a node already called
   * offline (D58) — not a park, not a retrieval: both would burn a cross-node
   * timeout to learn what the registry already said.
   */
  readonly isNodeOffline?: (nodeId: string) => boolean
}

/**
 * Bound on the mirror. A track's record leaves at release; this is the
 * backstop for a lost close. At the busiest measured hub (~12 sessions,
 * a few tracks each) 4 096 is an hour of tracks, past which the OLDEST record
 * is forgotten — its parcel still ages out on the node on its own.
 */
const MAX_MIRRORED_TRACKS = 4096

/** Every parked kind — the holder bookkeeping is per kind. */
const PARKED_FRAME_KINDS = ['keyFrame', 'thumbnail'] as const satisfies readonly ParkedFrameKind[]
type MissingParkedKind = Exclude<ParkedFrameKind, (typeof PARKED_FRAME_KINDS)[number]>
const allParkedKindsListed: [MissingParkedKind] extends [never] ? true : false = true
void allParkedKindsListed

/** One "runner has no park method" line per camera per minute. */
const SKEW_WARN_THROTTLE_MS = 60_000

function inFlightKey(trackId: string, kind: ParkedFrameKind): string {
  return `${trackId} ${kind}`
}

/** Strip the hub-side context off an order: only the wire fields travel. */
function toWireInput(order: ParkOrder): ParkTrackFrameInput {
  return {
    deviceId: order.deviceId,
    trackId: order.trackId,
    kind: order.kind,
    handle: order.handle,
    bbox: order.bbox,
    ...(order.maxWidth !== undefined ? { maxWidth: order.maxWidth } : {}),
    timestamp: order.timestamp,
  }
}

export function createParkedFrameClient(deps: ParkedFrameClientDeps): ParkedFrameClient {
  const { api, logger } = deps
  const now = deps.now ?? Date.now
  /** trackId → kind → what the hub kept beside the parcel. */
  const mirror = new Map<string, Map<ParkedFrameKind, ParkedParcelInfo>>()
  const inFlight = new Map<string, Promise<boolean>>()
  const skewWarnedAt = new Map<number, number>()
  /**
   * D683: survivorId → every id it has absorbed (flattened across chained
   * fusions). Each parcel stays in `mirror` under the id it was ORIGINALLY
   * parked under — the node never heard of a fusion.
   */
  const members = new Map<string, readonly string[]>()
  /**
   * D683 review H3: survivorId → kind → the member whose parcel is the
   * CURRENT best of that kind. Absent = the survivor's own. Set at adoption
   * from the ranking's verdict; a later park under the survivor itself
   * removes it (its newer best supersedes the adopted one).
   */
  const holders = new Map<string, Map<ParkedFrameKind, string>>()

  const holderOf = (trackId: string, kind: ParkedFrameKind): string =>
    holders.get(trackId)?.get(kind) ?? trackId

  /** Candidate ids for `(survivorId, kind)`, best-first: the current holder,
   *  then the survivor, then every other member (last-resort fallbacks). */
  const candidateOrder = (survivorId: string, kind: ParkedFrameKind): readonly string[] => {
    const entries = members.get(survivorId)
    if (entries === undefined || entries.length === 0) return [survivorId]
    return [...new Set([holderOf(survivorId, kind), survivorId, ...entries])]
  }

  /** The id whose MIRROR actually holds a `(…, kind)` record — the survivor
   *  itself when it never adopted, or no candidate has a parcel. */
  const resolveCandidate = (trackId: string, kind: ParkedFrameKind): string => {
    for (const id of candidateOrder(trackId, kind)) {
      if (mirror.get(id)?.get(kind) !== undefined) return id
    }
    return trackId
  }

  const remember = (order: ParkOrder, answer: ParkTrackFrameResult & { parked: true }): void => {
    // H3: a park under a survivor is its NEWEST best of this kind — it
    // supersedes whatever parcel an adoption handed it.
    holders.get(order.trackId)?.delete(order.kind)
    let kinds = mirror.get(order.trackId)
    if (kinds === undefined) {
      kinds = new Map()
      mirror.set(order.trackId, kinds)
      // Insertion order is first-park order; the oldest track goes first.
      while (mirror.size > MAX_MIRRORED_TRACKS) {
        const oldest = mirror.keys().next().value
        if (oldest === undefined) break
        mirror.delete(oldest)
      }
    }
    kinds.set(order.kind, {
      nodeId: answer.nodeId,
      deviceId: order.deviceId,
      kind: order.kind,
      timestamp: order.timestamp,
      width: answer.width,
      height: answer.height,
      subject: order.subject,
      ...(order.layout !== undefined ? { layout: order.layout } : {}),
    })
  }

  const warnSkew = (order: ParkOrder): void => {
    const at = skewWarnedAt.get(order.deviceId) ?? 0
    if (now() - at < SKEW_WARN_THROTTLE_MS) return
    skewWarnedAt.set(order.deviceId, now())
    logger.warn('track frame park impossible — the runner api has no park method (version skew)', {
      tags: { deviceId: order.deviceId },
      meta: { trackId: order.trackId, kind: order.kind, nodeId: order.handle.nodeId },
    })
  }

  const sendPark = async (order: ParkOrder): Promise<boolean> => {
    if (api === undefined) {
      warnSkew(order)
      return false
    }
    if (deps.isNodeOffline?.(order.handle.nodeId) === true) {
      // The caller's gate (`noteCapturesGated`) already said this on the
      // transition; here it is only accounted for.
      logger.debug('track frame park skipped — the owning node is offline in the registry', {
        tags: { deviceId: order.deviceId },
        meta: { trackId: order.trackId, kind: order.kind, nodeId: order.handle.nodeId },
      })
      return false
    }
    const meta = {
      trackId: order.trackId,
      kind: order.kind,
      nodeId: order.handle.nodeId,
      handle: `${order.handle.shmId}#${order.handle.slot}#${order.handle.seq}`,
    }
    try {
      const answer = await api.parkTrackFrame.mutate(
        toWireInput(order),
        nodePin(order.handle.nodeId),
      )
      if (answer.parked) {
        remember(order, answer)
        logger.debug('track frame parked', {
          tags: { deviceId: order.deviceId },
          meta: { ...meta, bytes: answer.bytes, replaced: answer.replaced },
        })
        return true
      }
      // The defect the window exists to prevent, said once per park, with the
      // number that says which hop was late. Not retried.
      logger.warn('track frame park refused by the owning node', {
        tags: { deviceId: order.deviceId },
        meta: {
          ...meta,
          reason: answer.reason,
          handleAgeMs: answer.handleAgeMs,
          ...(answer.detail !== undefined ? { detail: answer.detail } : {}),
        },
      })
      return false
    } catch (err) {
      logger.warn('track frame park failed — the order did not reach the node', {
        tags: { deviceId: order.deviceId },
        meta: { ...meta, error: errMsg(err) },
      })
      return false
    }
  }

  const park = (order: ParkOrder): Promise<boolean> => {
    const key = inFlightKey(order.trackId, order.kind)
    const pending = inFlight.get(key)
    if (pending !== undefined) return pending
    const run = sendPark(order).finally(() => {
      if (inFlight.get(key) === run) inFlight.delete(key)
    })
    inFlight.set(key, run)
    return run
  }

  /** H1: a fused survivor's read can resolve to ANY member, so wait for every
   *  member's park of this kind — not only the survivor's own. */
  const awaitPark = async (trackId: string, kind: ParkedFrameKind): Promise<void> => {
    const pending: Promise<boolean>[] = []
    for (const id of candidateOrder(trackId, kind)) {
      const p = inFlight.get(inFlightKey(id, kind))
      if (p !== undefined) pending.push(p)
    }
    if (pending.length > 0) await Promise.all(pending)
  }

  const info = (trackId: string, kind: ParkedFrameKind): ParkedParcelInfo | undefined =>
    mirror.get(resolveCandidate(trackId, kind))?.get(kind)

  const fetch = async (trackId: string, kind: ParkedFrameKind): Promise<ParkedParcel | null> => {
    // D683: the id actually holding the parcel on the node — the survivor
    // itself, or the absorbed piece it fell back to (see `resolveCandidate`).
    // The wire query must address THAT id; the node never heard of a fusion.
    const resolvedId = resolveCandidate(trackId, kind)
    const known = mirror.get(resolvedId)?.get(kind)
    if (known === undefined || api === undefined) return null
    if (deps.isNodeOffline?.(known.nodeId) === true) {
      logger.warn('parked frame retrieval skipped — the holding node is offline in the registry', {
        tags: { deviceId: known.deviceId },
        meta: { trackId: resolvedId, kind, nodeId: known.nodeId },
      })
      return null
    }
    try {
      const parcel = await api.getParkedTrackFrame.query(
        // `acceptJpegBytes`: this side turns the answer straight into a
        // Buffer, so base64 bought a 2.5 MB string in the relay's heap per
        // call and nothing else (D462).
        { deviceId: known.deviceId, trackId: resolvedId, kind, acceptJpegBytes: true },
        nodePin(known.nodeId),
      )
      if (parcel === null) {
        // The node evicted it (bound, budget or age) — a loss the consumer
        // is about to report as missing media; this side names the node.
        logger.warn('parked frame gone at retrieval — the node no longer holds it', {
          tags: { deviceId: known.deviceId },
          meta: {
            trackId: resolvedId,
            kind,
            nodeId: known.nodeId,
            parkedTimestamp: known.timestamp,
          },
        })
        return null
      }
      // Exactly one of the two is present; a runner that predates D462 (or one
      // answering an older request) still sends base64.
      const jpeg =
        parcel.jpegBytes !== undefined
          ? Buffer.from(parcel.jpegBytes)
          : parcel.jpeg !== undefined
            ? Buffer.from(parcel.jpeg, 'base64')
            : null
      if (jpeg === null) {
        logger.warn('parked frame arrived with neither jpegBytes nor jpeg', {
          tags: { deviceId: known.deviceId },
          meta: { trackId: resolvedId, kind, nodeId: known.nodeId },
        })
        return null
      }
      return {
        jpeg,
        width: parcel.width,
        height: parcel.height,
        timestamp: parcel.timestamp,
        info: known,
      }
    } catch (err) {
      logger.warn('parked frame retrieval failed', {
        tags: { deviceId: known.deviceId },
        meta: { trackId: resolvedId, kind, nodeId: known.nodeId, error: errMsg(err) },
      })
      return null
    }
  }

  /** Release ONE id's parcels (the body `release` ran for every id before
   *  D683 added members — kept separate so `release(survivorId)` can repeat
   *  it per absorbed id, each still parked under its OWN id on the node). */
  const releaseOne = (trackId: string): void => {
    // A park still travelling would land AFTER this release and leave an
    // orphan record here and a parcel on the node: release it again once it
    // lands (the node's age ceiling stays the backstop for a lost one).
    for (const kind of PARKED_FRAME_KINDS) {
      const pending = inFlight.get(inFlightKey(trackId, kind))
      if (pending !== undefined) void pending.then(() => releaseOne(trackId))
    }
    const kinds = mirror.get(trackId)
    if (kinds === undefined) return
    mirror.delete(trackId)
    if (api === undefined) return
    // One RPC per node that holds a parcel of this track (in practice one).
    const targets = new Map<string, number>()
    for (const record of kinds.values()) targets.set(record.nodeId, record.deviceId)
    for (const [nodeId, deviceId] of targets) {
      api.releaseParkedTrackFrames.mutate({ deviceId, trackId }, nodePin(nodeId)).catch((err) => {
        // The node's own age ceiling reclaims a parcel whose release was
        // lost; this only says that it will be late.
        logger.debug('parked frame release did not reach the node', {
          tags: { deviceId },
          meta: { trackId, nodeId, error: errMsg(err) },
        })
      })
    }
  }

  const release = (trackId: string): void => {
    const entries = members.get(trackId)
    members.delete(trackId)
    holders.delete(trackId)
    releaseOne(trackId)
    for (const id of entries ?? []) releaseOne(id)
  }

  const adopt = (
    survivorId: string,
    absorbedId: string,
    bestShotFrom: 'survivor' | 'absorbed',
  ): void => {
    const kinds = new Map<ParkedFrameKind, string>()
    for (const kind of PARKED_FRAME_KINDS) {
      // The absorbed piece's own holder when it won (itself, or a piece IT
      // had absorbed), else whatever the survivor already held.
      const holder =
        bestShotFrom === 'absorbed' ? holderOf(absorbedId, kind) : holderOf(survivorId, kind)
      if (holder !== survivorId) kinds.set(kind, holder)
    }
    holders.delete(absorbedId)
    if (kinds.size > 0) holders.set(survivorId, kinds)
    else holders.delete(survivorId)
    members.set(survivorId, [
      ...(members.get(survivorId) ?? []),
      absorbedId,
      ...(members.get(absorbedId) ?? []),
    ])
    members.delete(absorbedId)
    // Insertion order is first-adopt order; bound like the mirror (D422) so a
    // runner that never closes a camera cannot grow this without limit.
    while (members.size > MAX_MIRRORED_TRACKS) {
      const oldest = members.keys().next().value
      if (oldest === undefined) break
      const dropped = members.get(oldest) ?? []
      members.delete(oldest)
      holders.delete(oldest)
      // L5: a dropped entry loses the survivor's fallback and its members'
      // release — the node's age ceiling reclaims them; say so.
      const deviceId = [...(mirror.get(oldest)?.values() ?? [])][0]?.deviceId
      logger.debug('parked frame fusion record evicted at the bound', {
        ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
        meta: { survivorId: oldest, members: dropped, bound: MAX_MIRRORED_TRACKS },
      })
    }
  }

  const dispose = (): void => {
    mirror.clear()
    inFlight.clear()
    skewWarnedAt.clear()
    members.clear()
    holders.clear()
  }

  return { park, awaitPark, info, fetch, release, adopt, dispose }
}
