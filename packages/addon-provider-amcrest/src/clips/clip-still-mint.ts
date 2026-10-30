/**
 * The mint POLICY: the order the questions are asked in, and what the camera's
 * one replay slot is spent on.
 *
 * It is a module of its own, and not four more closures inside
 * `clip-service.ts`, because it is the part with rules: which refusal DEFERS,
 * which question must come before which camera reach, and who gives the slot
 * back. Those are provable here against fakes; inside the service they would
 * only be reachable through an RPC2 login.
 *
 * ## The order, and why each step is where it is
 *
 * 1. **Is this our camera?** No reach. `unknown-device`, final.
 * 2. **Is this clip in the catalog?** No reach — the row is what the window is
 *    built from, and a key nobody listed cannot be one. `no-catalog-row`.
 * 3. **Does the row span anything?** No reach. A zero-length window has no
 *    midpoint, and guessing one would be a picture of nothing (D382/D393).
 *    `no-keyframe`, final.
 * 4. **Has this clip already failed, or is this camera resting?** No reach
 *    (`clip-still-guard.ts`): a remembered failure answers verbatim, a paused
 *    camera answers `camera-backoff`, DEFERRED.
 * 5. **Take the lane** (`replay-lane.ts`), declaring the mint PREEMPTIBLE. A
 *    held lane QUEUES the mint (FIFO, one camera replay at a time); only a
 *    full queue refuses `queue-full`, DEFERRED, and a caller that went away
 *    leaves the queue without dialling. The cheap questions above all happen
 *    first — never open a camera session to discover the work could not have
 *    run (D54). The pause is asked AGAIN once the lane is ours: a mint that
 *    queued behind the failure that opened it must not dial.
 * 6. **Build the replay URL**, which needs the camera's measured clock.
 *    A clock that could not be read refuses rather than guessing an offset:
 *    `/cam/playback` is addressed by the camera's own wall clock and a guessed
 *    window returns the WRONG FOOTAGE rather than an error.
 * 7. **Cut**, then release, then store. The release is in a `finally`: a
 *    refusal that kept the lane would wedge the camera against every later
 *    ask, which is worse than the missing picture it started as.
 *
 * ## Every exit says something (D391)
 *
 * A mint that drops work and a mint that accepts work and produces nothing are
 * the same branch. A final refusal WARNs, a deferred one DEBUGs — a screen of
 * tiles deferring would otherwise put a warn per tile on the log — and a
 * success DEBUGs with what it cost the camera. All of them carry
 * `tags: { deviceId }`, the numeric id, because "why is 3836 worse than 1436"
 * is the only question anyone asks of these lines.
 */
import type { IScopedLogger } from '@camstack/types'

import type { AmcrestClipRow } from './clip-search.js'
import { type ClipStillCut, type ClipStillWindow, clipStillWindow } from './clip-still.js'
import type { ClipStillGuard } from './clip-still-guard.js'
import { deferStill, type MintRefusal, type MintResult, refuseStill } from './clip-still-refusal.js'
import { REPLAY_LANE_WAIT_MS, type ReplayLane } from './replay-lane.js'

/** A credentialled `/cam/playback` URL, or why one could not be built. */
export type ReplayUrlOutcome =
  | { readonly kind: 'ok'; readonly url: string }
  | { readonly kind: 'refused'; readonly detail: string }

export interface MintClipStillDeps {
  readonly logger: IScopedLogger
  /** ONE replay per camera from this node. A mint is subordinate to it. */
  readonly lane: ReplayLane
  /** What this runner remembers about failed stills and failing cameras. */
  readonly guard: ClipStillGuard
  /** Cheap, and no camera: does this node own this device at all? */
  hasCamera(deviceId: number): Promise<boolean>
  /** The catalog row this runner listed, or `undefined`. Never a camera call:
   *  a key nobody listed is answered, not searched for. */
  rowFor(deviceId: number, clipKey: string): AmcrestClipRow | undefined
  /** The credentialled replay URL for one window. Never logged. */
  replayUrlFor(
    deviceId: number,
    row: AmcrestClipRow,
    window: ClipStillWindow,
  ): Promise<ReplayUrlOutcome>
  /** The VOUCHED still on disk, or `null`. Asked again once the lane is ours:
   *  the replay this mint queued behind may have cut this very clip. */
  readCached(deviceId: number, clipKey: string): Promise<Buffer | null>
  /** One bounded ffmpeg over the replay. Never throws. */
  cut(input: { readonly url: string; readonly signal: AbortSignal }): Promise<ClipStillCut>
  putStill(deviceId: number, clipKey: string, bytes: Buffer): Promise<void>
}

/**
 * Mint one still, or say why not. Never throws.
 *
 * The caller is the route, which has already answered a cached still from disk
 * — this is only ever reached for a clip whose picture does not exist yet.
 */
export async function mintClipStill(
  deviceId: number,
  clipKey: string,
  deps: MintClipStillDeps,
  signal?: AbortSignal,
): Promise<MintResult> {
  const tags = { deviceId }
  const meta = { clipKey }

  if (!(await deps.hasCamera(deviceId))) {
    deps.logger.warn('videoclips: no still — this node does not own that device', {
      tags,
      meta: { ...meta, branch: 'unknown-device' },
    })
    return refuseStill('unknown-device', `device ${String(deviceId)} is not an Amcrest camera`)
  }

  const row = deps.rowFor(deviceId, clipKey)
  if (row === undefined) {
    deps.logger.warn('videoclips: no still — this clip is not in this node’s catalog', {
      tags,
      meta: { ...meta, branch: 'no-catalog-row' },
    })
    return refuseStill(
      'no-catalog-row',
      'no-catalog-row: list the window that holds this clip first',
    )
  }

  const window = clipStillWindow(row)
  if (window === null) {
    deps.logger.warn('videoclips: no still — this clip’s row spans nothing', {
      tags,
      meta: {
        ...meta,
        branch: 'no-window',
        startMs: row.startMs,
        endMs: row.endMs,
      },
    })
    return refuseStill(
      'no-keyframe',
      'this clip has no window to take a midpoint of — its catalog row spans nothing, and a ' +
        'midpoint of nothing is a guess rather than a picture',
    )
  }

  const remembered = deps.guard.remembered(deviceId, clipKey)
  if (remembered !== null) {
    deps.logger.debug('videoclips: no still — this clip already failed recently', {
      tags,
      meta: { ...meta, branch: 'remembered-failure', code: remembered.code },
    })
    return remembered
  }
  const paused = pausedRefusal(deviceId, clipKey, deps)
  if (paused !== null) return paused

  // SPECULATIVE from here on. `evict` is what makes it subordinate: an
  // operator's tap aborts this mid-replay instead of queueing behind it.
  const evict = new AbortController()
  const lease = await deps.lane.acquire(
    deviceId,
    'still',
    () => {
      evict.abort()
    },
    signal,
  )
  if (lease.kind === 'abandoned') {
    deps.logger.debug('videoclips: no still — its caller went away while it queued', {
      tags,
      meta: { ...meta, branch: 'abandoned', waitedMs: lease.waitedMs },
    })
    return { ok: false, abandoned: true, waitedMs: lease.waitedMs }
  }
  if (lease.kind === 'busy') {
    // DEFERRED, not final: the camera's queue is full NOW. Worth asking again.
    deps.logger.debug('videoclips: no still yet — this camera’s replay queue is full', {
      tags,
      meta: {
        ...meta,
        branch: 'queue-full',
        holder: lease.holder,
        waitedMs: lease.waitedMs,
      },
    })
    return deferStill('queue-full', lease.detail, REPLAY_LANE_WAIT_MS)
  }
  // Asked again with the lane in hand: the failure that opened a pause may
  // have happened while this mint was queued behind it.
  const pausedWhileQueued = pausedRefusal(deviceId, clipKey, deps)
  if (pausedWhileQueued !== null) {
    lease.release()
    return pausedWhileQueued
  }
  // And the cache: two clients asking for one clip must not dial it twice.
  const mintedWhileQueued = await readCachedSafely(deviceId, clipKey, deps)
  if (mintedWhileQueued !== null) {
    lease.release()
    deps.logger.debug('videoclips: still minted while this ask queued — served from disk', {
      tags,
      meta: { ...meta, branch: 'cached-while-queued' },
    })
    return { ok: true, bytes: mintedWhileQueued }
  }

  let cut: ClipStillCut
  try {
    const replay = await deps.replayUrlFor(deviceId, row, window)
    if (replay.kind === 'refused') {
      deps.logger.warn('videoclips: no still — no replay URL could be built', {
        tags,
        meta: { ...meta, branch: 'no-replay-url', reason: replay.detail },
      })
      // Counted and remembered like a failed cut: the camera would not say
      // what time it is, and asking it again every remount is the same load.
      const refusal = refuseStill('camera-refused', replay.detail)
      deps.guard.recordFailure(deviceId, clipKey, refusal)
      return refusal
    }
    cut = await deps.cut({ url: replay.url, signal: evict.signal })
  } finally {
    // On every path, including a throw: the camera's slot is not ours to keep.
    lease.release()
  }

  if (cut.kind === 'refused') {
    if (cut.code === 'yielded') {
      // Nothing failed and nothing is wrong with this clip — an operator
      // wanted the camera, which is what the camera is for.
      deps.logger.debug('videoclips: a still gave the camera back to a playback', {
        tags,
        meta: { ...meta, branch: 'yielded', reason: cut.detail },
      })
      return deferStill('queue-full', cut.detail, REPLAY_LANE_WAIT_MS)
    }
    deps.logger.warn('videoclips: a still could not be cut', {
      tags,
      meta: { ...meta, branch: cut.code, reason: cut.detail },
    })
    const refusal = refuseStill(cut.code, cut.detail)
    deps.guard.recordFailure(deviceId, clipKey, refusal)
    return refusal
  }

  deps.guard.recordSuccess(deviceId)

  await deps.putStill(deviceId, clipKey, cut.bytes)
  deps.logger.debug('videoclips: minted a clip still from the camera’s replay', {
    tags,
    meta: {
      ...meta,
      bytes: cut.bytes.byteLength,
      // What it COST the camera, on every success — the number that says
      // whether a screen of tiles is affordable.
      slotMs: cut.slotMs,
      // The position really asked for, so a still that looks wrong can be
      // checked against its own row rather than guessed at.
      askedStartMs: window.startMs,
      rowStartMs: row.startMs,
      rowEndMs: row.endMs,
    },
  })
  return { ok: true, bytes: cut.bytes }
}

/** `camera-backoff` while this camera's stills are paused, else `null`. */
function pausedRefusal(
  deviceId: number,
  clipKey: string,
  deps: MintClipStillDeps,
): MintRefusal | null {
  const leftMs = deps.guard.pausedForMs(deviceId)
  if (leftMs === null) return null
  deps.logger.debug('videoclips: no still — this camera’s stills are paused', {
    tags: { deviceId },
    meta: { clipKey, branch: 'camera-backoff', leftMs },
  })
  return deferStill(
    'camera-backoff',
    `camera-backoff: this camera failed its last clip replays in a row, so clip stills ` +
      `are paused for another ${String(Math.ceil(leftMs / 1000))} s — nothing about this clip`,
    leftMs,
  )
}

/** A cache read that fails is not a still: answered as "not there". */
async function readCachedSafely(
  deviceId: number,
  clipKey: string,
  deps: MintClipStillDeps,
): Promise<Buffer | null> {
  try {
    return await deps.readCached(deviceId, clipKey)
  } catch (err: unknown) {
    deps.logger.debug('videoclips: the still cache could not be read after the queue', {
      tags: { deviceId },
      meta: { clipKey, error: err instanceof Error ? err.message : String(err) },
    })
    return null
  }
}
