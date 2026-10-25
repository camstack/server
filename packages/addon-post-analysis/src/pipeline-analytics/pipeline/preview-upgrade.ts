/**
 * preview-upgrade — the "stand-in is provisional" completion of the close path
 * (D276).
 *
 * A track can close before its native captures land: the lease dies, the
 * capture queue sheds, and the last keyFrame exec finishes AFTER
 * `closeExpired` ran (observed live 2026-08-28, track 413c69ff… — its
 * keyFrame row landed 8 s after close while its tile stayed a 5 KB face
 * crop forever). The close path can no longer help — its derive already ran —
 * so the close path RECORDS what it still wanted here, and the late keyFrame
 * landing REDEEMS it: one derive, one overwrite of a below-`native` tile,
 * once.
 *
 * Contract (the operator's, verbatim: "va bene mostrare quei crop quando
 * mancano migliori elementi, ma l'intera storia deve sopravvivere" [it is fine to show those crops when better elements are missing, but the whole story must survive]):
 *  - only a tile whose provenance ranks BELOW `native` is ever replaced —
 *    a live-ranked or legacy (NULL-provenance) tile is untouchable;
 *  - the upgrade fires at most ONCE per track (`take` removes the entry), so
 *    tiles never thrash as rows trickle in;
 *  - every outcome that leaves the stand-in in place says why, at `info`,
 *    with `tags: { deviceId }`.
 *
 * The registry is bounded (TTL + cap): D58's "retried until it LANDS, under a
 * bound" — the bound here is the registry window, sized to outlive any queued
 * capture exec by an order of magnitude.
 */

import type { IScopedLogger } from '@camstack/types'
import { type MediaProvenance, mediaProvenanceRank } from '../store/media-store.js'
import type { KeyFrameCropMotionVerdict } from './keyframe-crop.js'
import type { SubjectPathSample } from './subject-agreement.js'

/** Best-seen subject bbox as the close path held it (detection-frame px). */
export interface PendingPreviewBbox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly frameWidth: number
  readonly frameHeight: number
  /**
   * The instant this box was MEASURED (ms). Carried because the redeem cuts it
   * out of a keyFrame from ANOTHER instant, and the guard needs both — passing
   * the keyFrame's own timestamp as the measure makes the skew 0 by
   * construction and disarms the guard, which is exactly the close-path
   * regression of 2026-08-24. Optional only for version-skew entries recorded
   * by an older build; absent leaves the redeem unable to bound the cut and it
   * says so rather than guessing.
   */
  readonly timestamp?: number
}

/** One closed track still owed a native tile. */
export interface PendingPreviewUpgrade {
  readonly deviceId: number
  readonly trackId: string
  /** Absent when no plausible subject box was ever observed — a late keyFrame
   *  then has nothing to crop and the miss stays (logged, never guessed). */
  readonly bestSeen?: PendingPreviewBbox
  readonly recordedAtMs: number
}

/** How long a closed track stays redeemable. Queued capture execs settle in
 *  seconds; 15 min covers a saturated lane many times over without letting
 *  the registry hold tracks from another era. */
export const PENDING_PREVIEW_TTL_MS = 15 * 60_000

/** Registry cap — a hard bound on memory however the TTL is configured. */
const PENDING_PREVIEW_MAX_ENTRIES = 512

interface PendingPreviewUpgradesOptions {
  readonly ttlMs?: number
  readonly maxEntries?: number
  readonly now?: () => number
}

/** Bounded trackId → pending-upgrade map. Insertion-ordered, so the cap
 *  evicts the oldest record. */
export class PendingPreviewUpgrades {
  private readonly entries = new Map<string, PendingPreviewUpgrade>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: PendingPreviewUpgradesOptions = {}) {
    this.ttlMs = options.ttlMs ?? PENDING_PREVIEW_TTL_MS
    this.maxEntries = Math.max(1, options.maxEntries ?? PENDING_PREVIEW_MAX_ENTRIES)
    this.now = options.now ?? ((): number => Date.now())
  }

  /** Record (or replace) a closed track's pending upgrade. Prunes expired
   *  entries first, then evicts the oldest while over the cap. */
  record(entry: PendingPreviewUpgrade): void {
    this.prune()
    this.entries.delete(entry.trackId)
    this.entries.set(entry.trackId, entry)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  /** Claim a track's pending upgrade — removes it, so a second landing (or a
   *  concurrent racer) finds nothing and the tile is rewritten at most once. */
  take(trackId: string): PendingPreviewUpgrade | undefined {
    this.prune()
    const entry = this.entries.get(trackId)
    if (entry === undefined) return undefined
    this.entries.delete(trackId)
    return entry
  }

  get size(): number {
    return this.entries.size
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [trackId, entry] of this.entries) {
      if (entry.recordedAtMs < cutoff) this.entries.delete(trackId)
    }
  }
}

/** Derive input — mirrors `TrackCloseKeyFrameThumbnailInput` (same closure). */
export interface PreviewUpgradeDeriveInput {
  readonly deviceId: number
  /** Media id (D482) of the persisted native `keyFrame`. */
  readonly mediaId: number
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  readonly frameWidth: number
  readonly frameHeight: number
  /** The instant the bbox was measured — NEVER the keyFrame's own timestamp. */
  readonly timestamp: number
  /** The track's position trail, when the caller still has it. The redeem runs
   *  after the close, so it usually does not — the temporal bound then carries
   *  the guard on its own. */
  readonly subjectPath?: readonly SubjectPathSample[]
}

/** Both derived variants (same shape the close-time derive returns). */
export interface PreviewUpgradeDerived {
  readonly thumbnail: Buffer
  readonly thumbnailSmall: Buffer
  readonly skewMs: number
  /** Which bound admitted the cross-time cut — see `KeyFrameCropMotionVerdict`. */
  readonly motion?: KeyFrameCropMotionVerdict
  readonly subjectIou?: number
}

/** A thumbnail-variant write. `provenance` is always `native` here — the
 *  upgrade exists to install a native tile, nothing else. */
export interface PreviewUpgradePut {
  readonly deviceId: number
  readonly trackId: string
  readonly kind: 'thumbnail' | 'thumbnailSmall'
  readonly timestamp: number
  readonly data: Buffer
  readonly provenance: MediaProvenance
}

export interface PreviewUpgradeDeps {
  /** `PendingPreviewUpgrades.take` — claim-once. */
  takePending(trackId: string): PendingPreviewUpgrade | undefined
  /** `MediaStore.trackThumbnailProvenance` — the never-overwrite gate. */
  heldThumbnailProvenance(trackId: string): Promise<MediaProvenance | null>
  /** The close-time keyFrame→thumbnail derive closure (skew-guarded). */
  derive(input: PreviewUpgradeDeriveInput): Promise<PreviewUpgradeDerived | null>
  put(input: PreviewUpgradePut): Promise<unknown>
  /** Clear the track row's `previewMissReason` — the story got its image. */
  clearPreviewMiss(deviceId: number, trackId: string): Promise<void>
  readonly logger: IScopedLogger
}

/** A late keyFrame landing for a (possibly closed) track. */
export interface PreviewUpgradeInput {
  readonly deviceId: number
  readonly trackId: string
  /** Media id (D482) of the keyFrame that just persisted. */
  readonly keyFrameMediaId: number
  /** The keyFrame's media instant (the capture's frame timestamp). */
  readonly timestamp: number
}

export type PreviewUpgradeOutcome =
  | 'no-pending'
  | 'held-native'
  | 'no-bbox'
  | 'derive-miss'
  | 'upgraded'

/**
 * Redeem a closed track's pending preview off a keyFrame that landed late.
 * Every non-`upgraded` outcome that had a pending entry logs itself — a
 * branch that leaves the stand-in in place must say so.
 */
export async function runPreviewUpgrade(
  deps: PreviewUpgradeDeps,
  input: PreviewUpgradeInput,
): Promise<PreviewUpgradeOutcome> {
  const { deviceId, trackId } = input
  const pending = deps.takePending(trackId)
  if (pending === undefined) return 'no-pending'
  const held = await deps.heldThumbnailProvenance(trackId)
  if (held !== null && mediaProvenanceRank(held) >= mediaProvenanceRank('native')) {
    // A native tile landed since the close recorded the pending entry (a
    // still-running live capture won the race). Nothing to do — and nothing
    // may EVER overwrite a native-ranked tile from here.
    deps.logger.info('late keyFrame: preview already native — no upgrade', {
      tags: { deviceId },
      meta: { trackId },
    })
    return 'held-native'
  }
  if (pending.bestSeen === undefined) {
    deps.logger.info('late keyFrame landed but no subject bbox was ever seen — tile kept as-is', {
      tags: { deviceId },
      meta: { trackId, heldProvenance: held },
    })
    return 'no-bbox'
  }
  // A version-skew entry recorded before the box carried its own instant
  // cannot be bounded: cutting it would be the disarmed guard again, with the
  // keyFrame compared to itself. Refuse and SAY so — the stand-in stays, and
  // the entry ages out of the registry. Self-clearing: every entry recorded by
  // this build carries the instant.
  if (pending.bestSeen.timestamp === undefined) {
    deps.logger.info('late keyFrame: pending entry predates the motion guard — tile kept as-is', {
      tags: { deviceId },
      meta: { trackId, keyFrameMediaId: input.keyFrameMediaId, heldProvenance: held },
    })
    return 'no-bbox'
  }
  const derived = await deps.derive({
    deviceId,
    mediaId: input.keyFrameMediaId,
    bbox: {
      x: pending.bestSeen.x,
      y: pending.bestSeen.y,
      w: pending.bestSeen.w,
      h: pending.bestSeen.h,
    },
    frameWidth: pending.bestSeen.frameWidth,
    frameHeight: pending.bestSeen.frameHeight,
    // The bbox's OWN instant. `input.timestamp` (the keyFrame's) was passed
    // here until 2026-08-30 and made the guard compare a frame with itself.
    timestamp: pending.bestSeen.timestamp,
  })
  if (derived === null) {
    deps.logger.info('late keyFrame preview upgrade failed (derive miss) — tile kept as-is', {
      tags: { deviceId },
      meta: { trackId, keyFrameMediaId: input.keyFrameMediaId, heldProvenance: held },
    })
    return 'derive-miss'
  }
  await deps.put({
    deviceId,
    trackId,
    kind: 'thumbnail',
    timestamp: input.timestamp,
    data: derived.thumbnail,
    provenance: 'native',
  })
  await deps.put({
    deviceId,
    trackId,
    kind: 'thumbnailSmall',
    timestamp: input.timestamp,
    data: derived.thumbnailSmall,
    provenance: 'native',
  })
  await deps.clearPreviewMiss(deviceId, trackId)
  deps.logger.info('best-shot upgraded from late keyFrame (stand-in replaced)', {
    tags: { deviceId },
    meta: {
      trackId,
      keyFrameMediaId: input.keyFrameMediaId,
      replaced: held ?? 'none',
      skewMs: derived.skewMs,
    },
  })
  return 'upgraded'
}
