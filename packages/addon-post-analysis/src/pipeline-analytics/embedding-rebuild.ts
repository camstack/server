/**
 * Rebuild per-track CLIP vectors from the stored key frames.
 *
 * ## Why this has to exist
 *
 * Every knob that decides what a vector MEANS — the encoder model, the crop
 * margin, the aspect handling — is only changeable if the existing vectors can
 * be regenerated. Without it, changing the crop policy leaves old and new
 * vectors in one index and their cosine scores are no longer comparable: a
 * search would silently rank two different feature spaces against each other
 * and the result would look like a quality regression with no cause.
 *
 * So this is not a maintenance script, it is the thing that makes the crop
 * policy tunable at all.
 *
 * ## Why this module no longer cuts a crop
 *
 * It used to. It widened the box by its own `DEFAULT_CROP_MARGIN = 0.2`,
 * squared it by default, encoded the result through `embeddingEncoder.encode`
 * directly, and wrote it into the same `object-clip` index the LIVE path was
 * filling with 0.15-padded, unsquared crops encoded through the pipeline. Two
 * feature spaces in one index — the exact condition described above, produced
 * by the tool that exists to prevent it, on every run.
 *
 * The rectangle is now derived in exactly one place for both paths: the
 * runner, from the cluster-wide crop convention. This module ships the key
 * frame and the box and receives a vector; it never sees a pixel rectangle.
 *
 * ## Why the pass is no longer bound to the camera's runner
 *
 * The first version of that fix routed through `pipelineRunner.runDetailSubtree`,
 * which resolves its step tree from the LIVE ATTACH STATE. Cameras run
 * `detectionMode: 'on-motion'` and detach ~30 s after motion stops, so a pass
 * walking historical tracks found most of the fleet detached. Measured on the
 * live hub, 2026-08-06: 1125 scanned, 121 rebuilt, 601 refused with "camera is
 * not attached". Attachment exists to make FRAME HANDLES resolvable; this pass
 * supplies its own frame and needs none of it.
 *
 * The step now runs through `pipelineRunner.runStatelessStep` on whichever node
 * the dispatcher pins — see `rebuild-step-dispatch.ts` for the placement rules
 * and `rebuild-node-rotation.ts` for why the rotation is plain round-robin.
 * ONE model is pinned for the whole pass and a node that cannot serve it
 * refuses rather than substituting; without that, spreading the work across
 * nodes would recreate the two-feature-space defect one level down.
 *
 * ## Where the pixels come from
 *
 * The track's `keyFrame` — the FULL frame at native resolution captured at the
 * track's best detection — plus that detection's bbox. Sending the full frame
 * rather than a pre-cut tile is what allows a WIDER crop than the one
 * originally embedded; the stored tight crop cannot be widened after the fact,
 * only shrunk.
 *
 * A track with no key frame is skipped and counted, never silently dropped.
 */

import type { TrackSource } from '@camstack/types'
import type { EmbeddingWriteOutcome } from './store/object-embedding-store.js'

/**
 * Track sources a rebuild never lists (D664). An audio track and a synthetic
 * sensor track have no object event and no subject to embed — on the live hub
 * 6,726 + 180 of 42,254 tracks — and walking them only inflated the skip
 * counters an operator reads to judge media coverage.
 */
export const REBUILD_EXCLUDED_SOURCES: readonly TrackSource[] = ['audio', 'sensor']

/** The window and cursor of one rebuild listing page. */
export interface RebuildPageWindow {
  readonly deviceIds: readonly number[]
  readonly since?: number
  readonly until?: number
  readonly cursor?: string
  readonly limit: number
}

/** The track-store query for one rebuild page — the window plus the exclusion. */
export interface RebuildPageQuery extends RebuildPageWindow {
  readonly excludeSources: readonly TrackSource[]
}

/**
 * One page of the rebuild listing as a `queryRecentIds` query. Pure, so the
 * exclusion is assertable: dropping it would look identical in every result
 * except the skip counters.
 */
export function rebuildTrackPageQuery(window: RebuildPageWindow): RebuildPageQuery {
  return { ...window, excludeSources: REBUILD_EXCLUDED_SOURCES }
}

/**
 * Why a track has no box on the pixels the rebuild would cut (D664, D303).
 *
 *  - `no-position-at-key-frame` — a key frame from before `subjectBox`
 *    (2026-09-16T12:32Z) whose track has no position at EXACTLY its instant;
 *  - `track-frame-size-unknown` — positions exist but the frame they were
 *    measured in does not, so they cannot be placed;
 *  - `track-row-missing` — the track row itself is gone;
 *  - `event-without-box` — no key frame at all, and the event the recording
 *    recovery would decode at carries no box.
 */
export type RebuildBoxRefusal =
  | 'no-position-at-key-frame'
  | 'track-frame-size-unknown'
  | 'track-row-missing'
  | 'event-without-box'

/** Which rule placed the box — or the named refusal (D664). */
export type RebuildBoxSource =
  | { readonly kind: 'subjectBox' }
  | { readonly kind: 'positions' }
  | { readonly kind: 'event' }
  | { readonly kind: 'refused'; readonly reason: RebuildBoxRefusal }

/** Per-rule box counts: which rule each scanned track's box came from. */
export interface RebuildBoxSourceCounts {
  /** The key frame row's own `subjectBox` (D510) — exact by construction. */
  readonly subjectBox: number
  /** `track.positions` at exactly the key frame's instant (pre-D510 rows). */
  readonly positions: number
  /** The event box, only for a key frame recovered from the recording. */
  readonly event: number
  /** No box measured on the pixels — refused, never guessed (D303). */
  readonly refused: number
}

/** A refused box is logged for the first refusal per camera, then every Nth. */
export const BOX_REFUSAL_LOG_EVERY = 100

/** Normalised bounding box, as events carry it. */
export interface NormalisedBbox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Tracks between progress callbacks. */
export const PROGRESS_EVERY = 25

/** Progress and outcome of one rebuild pass. */
export interface RebuildOutcome {
  readonly scanned: number
  readonly rebuilt: number
  /**
   * Tracks whose KEY FRAME was missing AND could not be recovered from the
   * recording — the only case in which the pixels are genuinely gone.
   *
   * Before R3 (2026-08-13) this counted every track whose capture missed, and
   * the note beside it said there could be no backfill. That was true only
   * while the key frame was the sole source: the recorder runs `-c:v copy`, so
   * wherever footage still covers the track's peak instant the native frame can
   * be re-decoded. What remains here is a camera that was not recording, a gap,
   * or footage aged out — a RETENTION question now, not a capture one.
   */
  readonly missingKeyFrame: number
  /**
   * Tracks embedded from a frame RE-DECODED out of the recording because no
   * key frame was ever stored.
   *
   * Its own counter because it is the number that says whether R3 is earning
   * its cost, and because a recovered vector and a captured one must never
   * become indistinguishable in the reporting — they are equally valid (the
   * pixels are the same native frame) but they answer different questions about
   * the capture path's health.
   */
  readonly recoveredKeyFrame: number
  /**
   * Tracks with no OBJECT EVENT at all — nothing to describe, so the pass
   * never even asked for pixels. A track-store question, and a different
   * person's problem from the one above.
   *
   * Its own counter since 2026-08-06: both used to increment `missingKeyFrame`,
   * so the number an operator watches to judge media coverage silently
   * included tracks whose media was never the issue. Only ~6 tracks fleet-wide
   * hit this, which is exactly why it must not hide inside a number in the
   * hundreds. Since D664 the cap-facing status reports it on its OWN field too:
   * it used to be added into `missingKeyFrame` there, and once audio and
   * sensor tracks (no object event, ever) were in the listing that sum read as
   * a media-coverage hole of thousands. Those sources are no longer listed at
   * all (`REBUILD_EXCLUDED_SOURCES`).
   */
  readonly missingEvent: number
  /** Tracks with no usable bbox (degenerate or absent). */
  readonly missingBbox: number
  /** Where each judged track's box came from (D664). */
  readonly boxSource: RebuildBoxSourceCounts
  /**
   * `force` passes only: in-space tracks re-embedded on purpose, and the
   * out-of-space tracks a forced pass left for a normal one (D664).
   */
  readonly forcedInSpace: number
  readonly skippedOutOfSpace: number
  /**
   * Tracks whose stored vector was ALREADY produced by the pinned model, so the
   * pass had nothing to do. Its own counter because it is the number that says
   * the mechanism is reading the right state: after a model change it falls to
   * zero and climbs back as the pass runs, and a pass with an unchanged model
   * is nothing BUT this counter.
   */
  readonly alreadyInSpace: number
  /**
   * Tracks an executing node REFUSED, not tracks that broke: an unreadable key
   * frame, a degenerate box. Distinct from `failed` because the remedy is the
   * stored media rather than the engine, and because it must never absorb the
   * case below.
   */
  readonly notRunnable: number
  /**
   * Set when the pass STOPPED because no node could serve the pinned model.
   *
   * Its own counter because it answers a different question from every other
   * one here: not "how much of the fleet was covered" but "could this work have
   * been done at all". Non-zero here always comes with `complete: false`, and
   * the closing log names every node that left and why.
   */
  readonly noCapableNode: number
  readonly failed: number
  /** False when the pass stopped at `maxTracks`, or ran out of nodes, with more left. */
  readonly complete: boolean
}

/** One track's rebuild inputs, as the caller resolves them. */
export interface RebuildSource {
  readonly trackId: string
  readonly deviceId: number
  readonly timestamp: number
  readonly className: string
  readonly confidence: number
  /** JPEG bytes of the track's native key frame — a FULL frame, never a crop. */
  readonly keyFrame: Buffer | null
  /**
   * The subject's box ON `keyFrame`, normalised — measured on those pixels
   * (D303, D664). `null` when no rule could place one; `boxSource` says why.
   */
  readonly bbox: NormalisedBbox | null
  /** Which rule placed `bbox`, or the named refusal. */
  readonly boxSource: RebuildBoxSource
  readonly mediaId?: number
  readonly keyFrameMediaId?: number
}

/**
 * What {@link RebuildDeps.embed} answers.
 *
 * A discriminated union rather than `number[] | null`, because the three cases
 * lead to three different counters and a nullable vector cannot tell them
 * apart. `not-runnable` in particular used to be indistinguishable from a
 * crash, and both were indistinguishable from success in the pre-outcome
 * version of the store call.
 */
export type RebuildEmbedOutcome =
  | { readonly kind: 'embedded'; readonly embeddingBase64: string }
  | { readonly kind: 'not-runnable'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }
  /**
   * No node in the cluster can do this work — every candidate lacked the step,
   * lacked a build of the pinned model, or dropped out. Terminal for the PASS,
   * not for the track: continuing would repeat the same discovery per track
   * while loading media for each one.
   */
  | { readonly kind: 'no-capable-node'; readonly reason: string }

/** One page of track ids, newest-first. */
export interface TrackIdPage {
  readonly trackIds: readonly string[]
  /** Cursor for the next page, or null when this was the last. */
  readonly nextCursor: string | null
}

/** What the rebuild needs from its surroundings. Injected so it is testable. */
export interface RebuildDeps {
  /**
   * One page of track ids, newest-first.
   *
   * PAGED, not a flat list. The first version asked for a bounded list, which
   * meant `maxTracks` selected the newest N and every repeated pass re-embedded
   * exactly those — idempotent, so the index never grew past them (372 → 384
   * across three 150-track passes on the live hub, against 2,596 live tracks).
   * A rebuild that cannot walk past its own first page is a rebuild that
   * reports success while doing nothing.
   */
  listTrackIdPage(cursor: string | null): Promise<TrackIdPage>
  /**
   * Can this pass still dispatch anywhere? Answered WITHOUT touching media.
   *
   * This exists because of the order the loop used to run in: it loaded a
   * track's media, then discovered nothing could run it. On the live hub,
   * 2026-08-06, a pass scanned 3,611 tracks, wrote 198 vectors and rejected
   * 2,598 — every rejection after a full media load. That was ~90% of the
   * pass's I/O and allocation buying nothing, on hub-main's only thread, for
   * 43 minutes (`nodes.topology` degraded 0.25 s → 26 s).
   *
   * So the cheap question is asked first. `false` ends the pass immediately:
   * the answer cannot change mid-pass — nodes only ever leave the rotation —
   * and re-asking it per track is what made it expensive in the first place.
   */
  canDispatch(): boolean
  /**
   * OPTIONAL: which of this PAGE's tracks are not yet in the pass's model
   * space — one batch call per page, before any media is touched.
   *
   * The cheap question, again. Without it a re-run after a model change
   * re-embeds tracks it already re-embedded, at ~1s and one blob read each, and
   * a pass with an UNCHANGED model is a full fleet walk that produces exactly
   * the vectors that were already there. With it, that pass is a declared
   * no-op — which is also the only way to tell "the mechanism read the right
   * state" from "the mechanism did nothing", since both look identical in the
   * index afterwards.
   *
   * `null` means the lookup FAILED. The pass then re-embeds the whole page
   * rather than skipping it: doing redundant work is a cost, skipping work
   * because a read failed is data loss.
   */
  filterOutOfSpace?(trackIds: readonly string[]): Promise<{
    readonly outOfSpace: readonly string[]
    readonly alreadyInSpace: number
    /** The in-space ids themselves — what a `force` pass re-embeds. */
    readonly inSpace: readonly string[]
  } | null>
  /**
   * Resolve one track's pixels and metadata; null to skip it.
   *
   * Implementations MUST read only the blob they need. `listByOwner` reads and
   * base64-encodes EVERY blob of the track (23 files / 7.67 MB / ~10 MB of
   * string on one measured 140 s track) to select two of them; the index rows
   * already carry `kind` and the key.
   */
  loadSource(trackId: string): Promise<RebuildSource | null>
  /**
   * OPTIONAL: recover a track's native frame by re-decoding it from the
   * recording, when no key frame was ever stored (R3).
   *
   * Optional so the pass runs unchanged where recovery is not wired, and so the
   * recovery's cost is never paid by a track that has its pixels already — it
   * is reached ONLY from the `keyFrame === null` branch.
   *
   * `null` means "still nothing", and the caller counts it exactly as it did
   * before this existed. It must never throw: a maintenance pass does not end
   * because one track's footage was pruned.
   *
   * This is a BACKGROUND path by construction. A GOP decode must never sit on a
   * notification's critical path — see `recorded-still.ts` and the guard that
   * enforces it.
   */
  recoverKeyFrame?(source: RebuildSource): Promise<Buffer | null>
  /**
   * Turn one track's key frame + box into a vector, THROUGH THE PIPELINE.
   *
   * Takes the whole source rather than a crop: choosing the rectangle is the
   * runner's job, and handing this function pixels it had already cut is
   * exactly how the two feature spaces appeared. The returned vector is
   * base64 float32 — the wire form `runDetailSubtree` produces and the form
   * the vector store writes — so nothing on this path decodes and re-encodes
   * it just to hand it back.
   */
  embed(source: RebuildSource): Promise<RebuildEmbedOutcome>
  /**
   * Store the vector for this track, reporting whether the row actually landed.
   *
   * The outcome is load-bearing: `rebuilt` used to be incremented on RETURN, so
   * a store that logged a failure and returned normally still counted. A live
   * pass reported 704 rebuilt against an index holding 0.
   */
  store(source: RebuildSource, embeddingBase64: string): Promise<EmbeddingWriteOutcome>
  /**
   * Yield the thread between tracks. Injected so the pacing is testable without
   * real time; the caller supplies the timer.
   */
  pause(ms: number): Promise<void>
  readonly logger: {
    info: (message: string, extras?: { meta?: Record<string, unknown> }) => void
    warn: (
      message: string,
      extras?: { tags?: { deviceId?: number }; meta?: Record<string, unknown> },
    ) => void
  }
}

/** Periodic progress, emitted while a pass runs. */
export interface RebuildProgress {
  readonly scanned: number
  readonly rebuilt: number
  readonly missingKeyFrame: number
  /** Tracks embedded from a frame re-decoded out of the recording (R3). */
  readonly recoveredKeyFrame: number
  readonly missingEvent: number
  readonly missingBbox: number
  readonly boxSource: RebuildBoxSourceCounts
  readonly forcedInSpace: number
  readonly skippedOutOfSpace: number
  readonly alreadyInSpace: number
  readonly notRunnable: number
  readonly noCapableNode: number
  readonly failed: number
}

export interface RebuildOptions {
  /**
   * Re-embed ONLY the tracks whose vector is ALREADY in the target space (D664).
   *
   * The in-space filter is what makes a re-run cheap, and it is also what
   * makes a vector written from the WRONG box permanent: the 2026-09-27 pass
   * wrote ~111 SigLIP2 vectors cut from another frame's box, and every later
   * pass skips them as done. A forced pass inverts the filter — in-space
   * tracks only — so it redoes exactly those and leaves the rest to a normal
   * pass. The caller bounds it (`maxTracks`); a failed lookup processes the
   * page in full, as a normal pass does.
   */
  readonly force?: boolean
  /**
   * Called every {@link PROGRESS_EVERY} tracks.
   *
   * A pass takes ~1s per track — 45 minutes for a 2,600-track fleet — so a run
   * with no progress signal is indistinguishable from a wedged one.
   */
  readonly onProgress?: (progress: RebuildProgress) => void
  /** Stop after this many tracks. */
  readonly maxTracks?: number
  /**
   * Milliseconds to wait between tracks. Defaults to
   * {@link DEFAULT_REBUILD_PACING_MS}.
   *
   * A rebuild is bulk maintenance sharing hub-main's single thread with every
   * live request. Measured on 2026-08-06 the main thread was busy 82.2 s out of
   * 120, with 42 s inside uninterrupted synchronous blocks of 2–7.3 s, and a
   * running pass was the dominant contributor. The delay is a floor on how
   * often the loop hands the thread back — cheap insurance whose only cost is
   * wall-clock on a job that already runs detached.
   *
   * `0` disables it. The value in force is logged at start and at finish, so a
   * deliberately slow pass is distinguishable from a stalled one.
   */
  readonly pacingMs?: number
}

/**
 * Default inter-track pause. Small enough that a fleet pass stays on the order
 * of its inference cost, large enough that the loop cannot hold the event loop
 * across thousands of iterations.
 */
export const DEFAULT_REBUILD_PACING_MS = 50

// NOTE — there is deliberately no `cropMargin` / `square` option here any more,
// and no `DEFAULT_CROP_MARGIN` constant. Those were a per-CALL crop convention,
// which is what let one rebuild disagree with the live path and with the
// previous rebuild. The convention is now a single cluster-wide
// `pipeline-orchestrator` setting read by the runner; a per-call override would
// reintroduce the split with a nicer name.

/**
 * Re-embed every listed track from its key frame.
 *
 * Every skip is COUNTED and the counts are returned, because the caller's next
 * decision — whether the index is now consistent enough to trust — depends on
 * knowing how much was not rebuilt, not just how much was.
 */
export async function rebuildObjectEmbeddings(
  deps: RebuildDeps,
  options: RebuildOptions = {},
): Promise<RebuildOutcome> {
  const maxTracks = options.maxTracks ?? Number.POSITIVE_INFINITY
  const pacingMs = options.pacingMs ?? DEFAULT_REBUILD_PACING_MS

  let rebuilt = 0
  let missingKeyFrame = 0
  let recoveredKeyFrame = 0
  let missingEvent = 0
  let missingBbox = 0
  let boxSubject = 0
  let boxPositions = 0
  let boxEvent = 0
  let boxRefused = 0
  let forcedInSpace = 0
  let skippedOutOfSpace = 0
  const refusalsByDevice = new Map<number, number>()
  const force = options.force === true
  let alreadyInSpace = 0
  let notRunnable = 0
  let noCapableNode = 0
  let failed = 0
  let scanned = 0
  let cursor: string | null = null
  let exhausted = false
  let budgetExhausted = false
  /** Set when the cluster ran out of nodes — the pass stops, `complete` is false. */
  let abandoned: string | null = null
  const boxSourceCounts = (): RebuildBoxSourceCounts => ({
    subjectBox: boxSubject,
    positions: boxPositions,
    event: boxEvent,
    refused: boxRefused,
  })

  // Walk pages until the store runs out or the budget does. `complete` means
  // "the store had nothing left", NOT "we hit the ceiling" — the caller decides
  // whether to run again based on that distinction.
  while (scanned < maxTracks && abandoned === null) {
    const page: TrackIdPage = await deps.listTrackIdPage(cursor)
    if (page.trackIds.length === 0) {
      exhausted = true
      break
    }

    // THE CHEAP QUESTION, PER PAGE. Asked before any media read, in one call,
    // so a re-run after a partial pass costs a batch lookup instead of a fleet
    // of blob reads. A failed lookup returns null and the page is processed in
    // full: redundant work is a cost, skipped work is data loss.
    let pageIds: readonly string[] = page.trackIds
    let forcedPage = false
    if (deps.filterOutOfSpace) {
      const split = await deps.filterOutOfSpace(page.trackIds)
      if (split !== null && force) {
        // Inverted on purpose — see `RebuildOptions.force`.
        skippedOutOfSpace += split.outOfSpace.length
        pageIds = split.inSpace
        forcedPage = true
      } else if (split !== null) {
        alreadyInSpace += split.alreadyInSpace
        pageIds = split.outOfSpace
      }
    }
    if (pageIds.length === 0) {
      cursor = page.nextCursor
      if (cursor === null) {
        exhausted = true
        break
      }
      continue
    }

    const room = maxTracks - scanned
    const batch = pageIds.slice(0, Number.isFinite(room) ? room : undefined)
    // Truncating a page means the budget ran out INSIDE it, so the pass did not
    // cover everything even if the store happens to have no further pages.
    if (batch.length < pageIds.length) budgetExhausted = true
    if (forcedPage) forcedInSpace += batch.length

    for (const trackId of batch) {
      // THE CHEAP QUESTION FIRST. Asked before `loadSource`, which reads a blob
      // off disk: a pass with nowhere to dispatch must cost nothing per track,
      // not a full media load per track. This ordering is the fix for the
      // 43-minute hub-main saturation of 2026-08-06 — see `canDispatch`.
      if (!deps.canDispatch()) {
        abandoned =
          'no node left in the rotation can serve the pinned model — stopped before loading any further media'
        noCapableNode += 1
        deps.logger.warn(
          'embedding rebuild ABANDONED: nowhere left to dispatch, stopping before the next media read',
          { meta: { trackId, scanned } },
        )
        break
      }
      scanned += 1
      // The per-track body is an inner async block so its early exits are
      // `return`s, not `continue`s. A `continue` here jumped straight to the
      // next track and SKIPPED the pacing yield below — so exactly the tracks
      // that are cheapest to reject (no key frame, no box) were the ones that
      // ran back-to-back with no yield, which is the shape that saturates a
      // single-threaded event loop.
      await (async (): Promise<void> => {
        try {
          const source = await deps.loadSource(trackId)
          if (source === null) {
            // No object event — the track cannot be DESCRIBED, which is not
            // the same failure as having no pixels to describe it with.
            missingEvent += 1
            return
          }
          // THE BOX BEFORE THE PIXELS (D664). A track with no box measured on
          // the frame it would be cut from is refused before a recording is
          // decoded for it — and counted, and logged, by name.
          if (source.bbox === null || source.bbox.w <= 0 || source.bbox.h <= 0) {
            missingBbox += 1
            boxRefused += 1
            const reason =
              source.boxSource.kind === 'refused' ? source.boxSource.reason : 'degenerate-box'
            const n = (refusalsByDevice.get(source.deviceId) ?? 0) + 1
            refusalsByDevice.set(source.deviceId, n)
            if (n === 1 || n % BOX_REFUSAL_LOG_EVERY === 0) {
              deps.logger.warn(
                'embedding rebuild: no box measured on the key frame — track refused (D303)',
                {
                  tags: { deviceId: source.deviceId },
                  meta: { trackId, reason, refusedOnThisCamera: n },
                },
              )
            }
            return
          }
          if (source.boxSource.kind === 'subjectBox') boxSubject += 1
          else if (source.boxSource.kind === 'positions') boxPositions += 1
          else boxEvent += 1
          // R3 — the key frame was never stored, so re-derive it from the
          // recording. The cheap question already ran (the track HAS an event,
          // so there is something to describe); this is the one read that can
          // still turn a permanently unsearchable track into a searchable one.
          let keyFrame = source.keyFrame
          let recovered = false
          if (keyFrame === null && deps.recoverKeyFrame) {
            keyFrame = await deps.recoverKeyFrame(source)
            recovered = keyFrame !== null
          }
          if (keyFrame === null) {
            missingKeyFrame += 1
            return
          }
          if (recovered) recoveredKeyFrame += 1

          const outcome = await deps.embed(recovered ? { ...source, keyFrame } : source)
          if (outcome.kind === 'no-capable-node') {
            // Terminal for the PASS. Carrying on would re-discover the same
            // answer on every remaining track, paying a media load each time,
            // and would bury the one line that explains the whole run.
            noCapableNode += 1
            abandoned = outcome.reason
            deps.logger.warn(
              'embedding rebuild ABANDONED: no node can run the pinned embedding model',
              {
                tags: { deviceId: source.deviceId },
                meta: { trackId, reason: outcome.reason, scanned },
              },
            )
            return
          }
          if (outcome.kind === 'not-runnable') {
            notRunnable += 1
            // LOUD, per track: a detail dispatch that produced nothing is
            // otherwise indistinguishable from one that was never made, and a
            // whole camera silently contributing zero vectors is exactly the
            // shape of failure a rebuild must never hide.
            deps.logger.warn('embedding rebuild: track could not be re-embedded by the pipeline', {
              tags: { deviceId: source.deviceId },
              meta: { trackId, reason: outcome.reason },
            })
            return
          }
          if (outcome.kind === 'failed') {
            failed += 1
            deps.logger.warn('embedding rebuild: the pipeline returned no vector for a track', {
              tags: { deviceId: source.deviceId },
              meta: { trackId, reason: outcome.reason },
            })
            return
          }

          const written = await deps.store(source, outcome.embeddingBase64)
          if (written === 'persisted') {
            rebuilt += 1
          } else {
            // `skipped` cannot happen on this path — the rebuild forces past the
            // best-confidence gate — so anything that is not a write is a loss,
            // and a loss the operator must see in the number they are watching.
            failed += 1
            deps.logger.warn('embedding rebuild wrote nothing for a track', {
              tags: { deviceId: source.deviceId },
              meta: { trackId, outcome: written },
            })
          }
        } catch (err) {
          failed += 1
          deps.logger.warn('embedding rebuild failed for a track', {
            meta: { trackId, error: String(err) },
          })
        }
      })()

      // Hand the thread back between tracks. A rebuild shares hub-main's only
      // thread with every live request, and an unpaced loop over thousands of
      // tracks is what turned a maintenance job into an outage.
      if (pacingMs > 0) await deps.pause(pacingMs)

      if (scanned % PROGRESS_EVERY === 0) {
        options.onProgress?.({
          scanned,
          rebuilt,
          missingKeyFrame,
          recoveredKeyFrame,
          missingEvent,
          missingBbox,
          boxSource: boxSourceCounts(),
          forcedInSpace,
          skippedOutOfSpace,
          alreadyInSpace,
          notRunnable,
          noCapableNode,
          failed,
        })
      }

      // The pass-terminal outcome is checked HERE rather than with a `break`
      // inside the body, because the body is now a function.
      if (abandoned !== null) break
    }

    if (abandoned !== null) break
    if (page.nextCursor === null) {
      exhausted = true
      break
    }
    cursor = page.nextCursor
  }

  // `complete` means EVERYTHING was covered — the store ran out AND the budget
  // never cut a page short. Reporting completion after a budget stop would tell
  // the caller there is nothing left to do when there is.
  const complete = exhausted && !budgetExhausted && abandoned === null

  deps.logger.info('object embedding rebuild finished', {
    meta: {
      pacingMs,
      scanned,
      rebuilt,
      missingKeyFrame,
      recoveredKeyFrame,
      missingEvent,
      missingBbox,
      boxSource: boxSourceCounts(),
      force,
      forcedInSpace,
      skippedOutOfSpace,
      alreadyInSpace,
      notRunnable,
      noCapableNode,
      failed,
      complete,
      ...(abandoned !== null ? { abandoned } : {}),
    },
  })

  return {
    scanned,
    rebuilt,
    missingKeyFrame,
    recoveredKeyFrame,
    missingEvent,
    missingBbox,
    boxSource: boxSourceCounts(),
    forcedInSpace,
    skippedOutOfSpace,
    alreadyInSpace,
    notRunnable,
    noCapableNode,
    failed,
    complete,
  }
}

/**
 * Read a normalised bbox off an object event.
 *
 * Events carry the box in FRAME PIXELS alongside `frameWidth`/`frameHeight`,
 * not normalised — normalising here rather than at the call site keeps the
 * conversion in one place, next to the code that consumes it.
 * Returns null when the frame dimensions are missing, because a box without
 * them cannot be placed on a differently-sized key frame.
 */
export function normaliseEventBbox(event: {
  readonly bbox?: { x: number; y: number; w: number; h: number }
  readonly frameWidth?: number
  readonly frameHeight?: number
}): NormalisedBbox | null {
  const { bbox, frameWidth, frameHeight } = event
  if (bbox === undefined) return null
  if (frameWidth === undefined || frameHeight === undefined) return null
  if (frameWidth <= 0 || frameHeight <= 0) return null
  if (bbox.w <= 0 || bbox.h <= 0) return null
  return {
    x: bbox.x / frameWidth,
    y: bbox.y / frameHeight,
    w: bbox.w / frameWidth,
    h: bbox.h / frameHeight,
  }
}
