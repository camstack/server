/**
 * Cut ONE notification clip out of the RECORDINGS, when the moment is older
 * than the broker's clip ring can serve.
 *
 * ## Why this exists
 *
 * The ring holds what that camera's own rules asked it to hold — 20 s for an
 * ordinary rule, a full minute where an occupancy rule made it necessary, and
 * nothing at all on a camera whose rules never cut footage
 * (`clip-retention-ask.ts`). Since the footage anchor
 * became the moment the change was OBSERVED rather than the moment it was
 * CONCLUDED (`media-anchor.ts`), an occupancy departure routinely asks for a
 * window minutes old — measured 6–10 minutes behind on device 102 — and the
 * ring correctly refuses it. The operator's answer: the pre-buffer is short,
 * the recordings are the right source for an old moment. `footage-source.ts`
 * owns the choice; this module is what happens when the choice is `recordings`.
 *
 * ## It renders nothing itself
 *
 * `recordingExport.createExport` already runs on the node that owns the
 * footage, already builds a source playlist across segments, already drives
 * ffmpeg, already bounds the file's life and already serves the bytes. The
 * timelapse renderer reached exactly this conclusion for exactly these reasons
 * (`timelapse/timelapse-renderer.ts`) and this module reuses the same surface —
 * including its `pickProfile`, so "the cheapest band that actually covers the
 * window" keeps having one implementation and cannot pick a 4K band here and a
 * low one there (D435).
 *
 * The one thing that made the recordings the WRONG source before is gone for
 * this caller. `NcDispatcherDeps.renderEventMedia` says of them: *"recorded
 * segments are only addressable once finalized, so a segment-cut clip shows
 * the seconds BEFORE the trigger"* — true, and decisive, for a moment that is
 * four seconds old. A moment ten minutes old was finalized long ago.
 *
 * ## Every way of not producing a clip has a NAME
 *
 * Three different things are being said and they are not the same news
 * (`NcRecordedClipRefusal`):
 *
 *  - `not-recorded` — this camera does not record. Nothing is broken and
 *    nothing will ever improve; the fix is an operator's setting.
 *  - `not-covered` — it records, but not that moment: a gap, a restart, or
 *    retention that has already walked past it. The camera is fine.
 *  - `cut-failed` — the recorder was asked and did not deliver. This is the
 *    only one of the three that is a FAULT, and folding the other two into it
 *    is how a working deployment looks broken.
 *
 * A fourth, `timed-out`, is the CALLER's bound (D686): the notification is
 * held for this cut, so a cut that is not ready when the wait ends is dropped
 * and named, and the notification ships without it.
 *
 * Each is logged with `tags: { deviceId }` — a missing clip is always asked
 * per-camera ("why does 102 get one and 101 not?") and a line without the tag
 * cannot answer it. The cheap question comes first (D54): availability is read
 * before any render is queued, so a camera that does not record never costs an
 * ffmpeg lane.
 */

import type { IScopedLogger } from '@camstack/types'
import { pickProfile, type TimelapseAvailabilityRange } from './timelapse/timelapse-renderer.js'

/** How often the render is polled while it runs. */
const NC_RECORDED_CLIP_POLL_MS = 1_000

/**
 * How long the recorder keeps the file we are about to read and delete.
 *
 * `maxLifeMs` is `z.number().int().positive()` on the capability, so "do not
 * keep it" is not expressible — this is the shortest life that still survives
 * a slow read, and the explicit `deleteExport` below is the real cleanup.
 */
const NC_RECORDED_CLIP_LIFE_MS = 15 * 60_000

/**
 * Why no recorded clip was produced. Four causes, four different fixes.
 *
 * `timed-out` is not a fault of the recorder: the caller is holding a
 * notification for this cut (D686) and its bound ran out first — typically a
 * render queued behind a timelapse on the one ffmpeg lane.
 */
export type NcRecordedClipRefusal = 'not-recorded' | 'not-covered' | 'cut-failed' | 'timed-out'

/** The cut, or the named reason there is none. */
export type NcRecordedClipResult =
  | { readonly ok: true; readonly mp4: Uint8Array<ArrayBuffer>; readonly profile: string }
  | { readonly ok: false; readonly reason: NcRecordedClipRefusal }

/** The window to cut, and who it is about. */
export interface NcRecordedClipRequest {
  readonly deviceId: number
  /** The anchored moment — `NcMediaAnchor.atMs`. */
  readonly aroundMs: number
  readonly preRollSec: number
  readonly postRollSec: number
  /** Playback rate the rule asked for. Absent ⇒ realtime. */
  readonly speed?: number
  /** For the log lines only — which rule/record is missing its clip. */
  readonly ruleId: string
  readonly recordId: string
  /**
   * When the caller stops waiting, on the `ports.now()` clock (D686). The
   * notification is HELD for this cut, so the cut owns the same bound: no
   * render is queued once it has passed, and a render still running at it is
   * abandoned and deleted rather than left finishing for nobody.
   */
  readonly deadlineMs: number
}

/** The slice of `RecordingAvailability` this reads. */
export interface NcRecordedAvailability {
  readonly ranges: readonly TimelapseAvailabilityRange[]
  /** Every profile this camera has footage in (D433). Empty ⇒ it records none. */
  readonly profilesWithFootage: readonly string[]
}

/** The slice of `ExportRecord` this reads. */
export interface NcRecordedExportRecord {
  readonly id: string
  readonly state: 'queued' | 'rendering' | 'ready' | 'failed' | 'expired' | 'deleted'
  readonly error: string | null
}

/** The `createExport` input this module builds. */
export interface NcRecordedExportOrder {
  readonly deviceId: number
  readonly profile: string
  readonly fromMs: number
  readonly toMs: number
  readonly options: {
    readonly includeAudio: boolean
    readonly maxLifeMs: number
    readonly deleteAfterDownload: boolean
    readonly title: string
    readonly speed?: number
  }
}

/**
 * Everything this reaches outside itself, as closures — the same injection
 * shape the timelapse renderer uses, bound by the wiring to `recording` and
 * `recording-export`.
 */
export interface NcRecordedClipPorts {
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  /** `recording.getAvailability` over the clip window. */
  readonly getAvailability: (input: {
    readonly deviceId: number
    readonly fromMs: number
    readonly toMs: number
  }) => Promise<NcRecordedAvailability>
  /** `recordingExport.createExport`. */
  readonly createExport: (input: NcRecordedExportOrder) => Promise<NcRecordedExportRecord>
  /** `recordingExport.getExport`. */
  readonly getExport: (input: { readonly exportId: string }) => Promise<NcRecordedExportRecord>
  /** `recordingExport.readExportBytes` — base64, bounded by the provider. */
  readonly readExportBytes: (input: {
    readonly exportId: string
  }) => Promise<{ readonly base64: string }>
  /**
   * `recordingExport.deleteExport`. Optional and best-effort: the file's own
   * `maxLifeMs` is the backstop, so a wiring without it leaks a temporary file
   * for fifteen minutes and nothing worse.
   */
  readonly deleteExport?: (input: { readonly exportId: string }) => Promise<unknown>
  /**
   * `recordingExport.cancelExport` — unqueue or kill a render. Called BEFORE
   * the delete when the caller's deadline passed: a delete alone removes the
   * row and file while the engine keeps the id queued (or ffmpeg running)
   * and renders it for nobody (D686 fix round, review H1). Optional and
   * best-effort, like the delete; the engine also skips an abandoned row.
   */
  readonly cancelExport?: (input: { readonly exportId: string }) => Promise<unknown>
  readonly pollMs?: number
}

/** The window a request describes, in wall clock. */
export function recordedClipWindow(req: NcRecordedClipRequest): {
  readonly fromMs: number
  readonly toMs: number
} {
  return {
    fromMs: Math.round(req.aroundMs - req.preRollSec * 1000),
    toMs: Math.round(req.aroundMs + req.postRollSec * 1000),
  }
}

/**
 * Cut the window from the recordings, or say — by name — why there is none.
 *
 * Never throws: every failure is a named refusal, because the caller's only
 * other option is to lose a notification over a missing attachment.
 */
export async function cutRecordedClip(
  ports: NcRecordedClipPorts,
  req: NcRecordedClipRequest,
): Promise<NcRecordedClipResult> {
  const tags = { deviceId: req.deviceId }
  const window = recordedClipWindow(req)
  const common = {
    ruleId: req.ruleId,
    eventId: req.recordId,
    fromMs: window.fromMs,
    toMs: window.toMs,
    ageSec: Math.round((ports.now() - req.aroundMs) / 1000),
  }

  // THE CHEAP QUESTION FIRST (D54): never queue a render before knowing the
  // footage can serve it.
  let availability: NcRecordedAvailability
  try {
    availability = await ports.getAvailability({
      deviceId: req.deviceId,
      fromMs: window.fromMs,
      toMs: window.toMs,
    })
  } catch (err) {
    ports.logger.warn('recorded clip: the recording availability read failed', {
      tags,
      meta: { ...common, cause: 'availability-read', error: String(err) },
    })
    return { ok: false, reason: 'cut-failed' }
  }

  if (availability.profilesWithFootage.length === 0 && availability.ranges.length === 0) {
    // NOT A FAULT. There is no footage in any band for this camera, which is
    // what "recording is off here" looks like from the outside. Saying
    // `cut-failed` for it would send the next reader after a broken recorder.
    ports.logger.info('recorded clip: this camera does not record — shipping without a clip', {
      tags,
      meta: { ...common, reason: 'not-recorded' },
    })
    return { ok: false, reason: 'not-recorded' }
  }

  // The availability read is an RPC and it spent part of the bound. A render
  // queued now would be abandoned at the first poll — never queue it.
  if (ports.now() >= req.deadlineMs) {
    ports.logger.info('recorded clip: the bound was spent before the render', {
      tags,
      meta: { ...common, reason: 'timed-out', deadlineMs: req.deadlineMs },
    })
    return { ok: false, reason: 'timed-out' }
  }

  // One band, chosen by the SAME rule the timelapse renderer uses: the cheapest
  // one that actually covers the window (D435 — a second rule here is how a
  // notification clip comes to read 4K off a spinning disk).
  const pick = pickProfile(availability.ranges, { startMs: window.fromMs, endMs: window.toMs })
  if (pick === null) {
    ports.logger.info('recorded clip: the recording does not cover that moment', {
      tags,
      meta: {
        ...common,
        reason: 'not-covered',
        // WHICH bands exist, so "it records but not then" is distinguishable
        // from "it records a band we did not ask about".
        profiles: [...availability.profilesWithFootage],
        rangeCount: availability.ranges.length,
      },
    })
    return { ok: false, reason: 'not-covered' }
  }

  let record: NcRecordedExportRecord
  try {
    record = await ports.createExport({
      deviceId: req.deviceId,
      profile: pick.profile,
      fromMs: window.fromMs,
      toMs: window.toMs,
      options: {
        includeAudio: false,
        maxLifeMs: NC_RECORDED_CLIP_LIFE_MS,
        deleteAfterDownload: false,
        title: `notification ${req.recordId}`,
        ...(req.speed !== undefined ? { speed: req.speed } : {}),
      },
    })
  } catch (err) {
    // `createExport` fails fast when no footage covers the range — which the
    // coverage check above should already have caught. Reaching here therefore
    // IS a fault, and it keeps the recorder's own words.
    ports.logger.warn('recorded clip: the recorder refused the render', {
      tags,
      meta: { ...common, cause: 'create-export', profile: pick.profile, error: String(err) },
    })
    return { ok: false, reason: 'cut-failed' }
  }

  const pollMs = ports.pollMs ?? NC_RECORDED_CLIP_POLL_MS
  let state = record.state
  let failure = record.error
  while (state === 'queued' || state === 'rendering') {
    if (ports.now() >= req.deadlineMs) {
      ports.logger.warn('recorded clip: the render did not finish inside its bound', {
        tags,
        meta: {
          ...common,
          reason: 'timed-out',
          exportId: record.id,
          profile: pick.profile,
          deadlineMs: req.deadlineMs,
          state,
        },
      })
      await abandon(ports, record.id)
      return { ok: false, reason: 'timed-out' }
    }
    await ports.sleep(pollMs)
    try {
      const next = await ports.getExport({ exportId: record.id })
      state = next.state
      failure = next.error
    } catch (err) {
      ports.logger.warn('recorded clip: the render status read failed', {
        tags,
        meta: { ...common, cause: 'get-export', exportId: record.id, error: String(err) },
      })
      return { ok: false, reason: 'cut-failed' }
    }
  }
  if (state !== 'ready') {
    ports.logger.warn('recorded clip: the render did not produce a file', {
      tags,
      meta: {
        ...common,
        cause: 'render-failed',
        exportId: record.id,
        profile: pick.profile,
        state,
        error: failure,
      },
    })
    await discard(ports, record.id)
    return { ok: false, reason: 'cut-failed' }
  }

  let base64: string
  try {
    base64 = (await ports.readExportBytes({ exportId: record.id })).base64
  } catch (err) {
    ports.logger.warn('recorded clip: the finished file could not be read', {
      tags,
      meta: { ...common, cause: 'read-bytes', exportId: record.id, error: String(err) },
    })
    await discard(ports, record.id)
    return { ok: false, reason: 'cut-failed' }
  }
  await discard(ports, record.id)

  const mp4 = decodeBase64(base64)
  if (mp4 === null || mp4.byteLength === 0) {
    // An empty attachment is worse than none: it ships, it plays nothing, and
    // it reads as a delivered clip on every line that counts attachments.
    ports.logger.warn('recorded clip: the finished file was empty', {
      tags,
      meta: { ...common, cause: 'empty-file', exportId: record.id, profile: pick.profile },
    })
    return { ok: false, reason: 'cut-failed' }
  }
  ports.logger.info('recorded clip: cut from the recordings', {
    tags,
    meta: {
      ...common,
      exportId: record.id,
      profile: pick.profile,
      coveragePct: pick.coverage.percent,
      bytes: mp4.byteLength,
    },
  })
  return { ok: true, mp4, profile: pick.profile }
}

/** Best-effort removal of the temporary file. Its `maxLifeMs` is the backstop,
 *  so a failure here costs disk for fifteen minutes and is worth one line. */
/** A render nobody waits for any more: cancel it, then delete its row and file. */
async function abandon(ports: NcRecordedClipPorts, exportId: string): Promise<void> {
  const cancel = ports.cancelExport
  if (cancel !== undefined) {
    try {
      await cancel({ exportId })
    } catch (err) {
      ports.logger.debug('recorded clip: could not cancel the abandoned export', {
        meta: { exportId, error: String(err) },
      })
    }
  }
  await discard(ports, exportId)
}

async function discard(ports: NcRecordedClipPorts, exportId: string): Promise<void> {
  const del = ports.deleteExport
  if (del === undefined) return
  try {
    await del({ exportId })
  } catch (err) {
    ports.logger.debug('recorded clip: could not delete the temporary export', {
      meta: { exportId, error: String(err) },
    })
  }
}

/** Base64 → bytes, or null when the string is not base64 at all. */
function decodeBase64(base64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const buf = Buffer.from(base64, 'base64')
    const out = new Uint8Array(new ArrayBuffer(buf.byteLength))
    out.set(buf)
    return out
  } catch {
    return null
  }
}
