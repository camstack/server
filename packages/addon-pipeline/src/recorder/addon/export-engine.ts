/**
 * Render engine for recording exports.
 *
 * A FIFO queue with a BOUNDED number of concurrent ffmpeg renders
 * ({@link EXPORT_MAX_CONCURRENT}, currently two) — never unbounded: exports are
 * heavy and the box they run on is a live NVR. This said "ONE concurrent
 * render" long after the constant had been raised to two, which is the worst
 * kind of comment: it reads as a guarantee nobody is holding. Each render is
 * itself capped at `EXPORT_FFMPEG_THREADS` cores, so the ceiling the machine
 * actually sees is concurrency × threads, and both halves are named. Each job: write the range's per-export source
 * playlist (`resolvePlaylist`) → spawn ffmpeg → parse `time=` from stderr for
 * progress → on exit 0 stat the file and mark `ready`; on non-zero mark
 * `failed` and remove the partial; drop the source playlist whatever the
 * outcome. A **timelapse** is two ffmpeg processes (concat remux, then
 * select) so the frame picker never walks `#EXT-X-DISCONTINUITY`. `cancel`
 * SIGKILLs the in-flight process.
 * State transitions patch the DurableState store and emit telemetry events.
 *
 * Unlike `SegmentWriter` there is NO auto-restart — a render runs once; boot
 * re-queue of interrupted jobs is the provider's concern.
 */

import type {
  CamProfile,
  ClipBytes,
  ClipWake,
  ExportClipSubject,
  ExportOptions,
  ExportRecord,
  IScopedLogger,
  PinnedFfmpegResolver,
} from '@camstack/types'
import {
  clipExportFailure,
  type ClipExportFailure,
  clipExportFailureOf,
  EventCategory,
  exportSubjectOf,
  RECORDING_EXPORT_MAX_READ_BYTES,
  VIDEOCLIPS_MAX_OFFER_BYTES,
} from '@camstack/types'
import {
  type DenseRangeMapReport,
  type ExportSegmentTiming,
  withStreamTimeDenseRanges,
} from './export-dense-map.js'
import {
  buildAssembleArgs,
  buildAssembleConcatList,
  buildConcatPassArgs,
  buildExportArgs,
  buildExportConcatList,
  concatPassOutPath,
  type ExportConcatSegment,
} from './export-ffmpeg-args.js'
import {
  getExportRecord,
  patchExport,
  patchExportUnless,
  type RecordingExportsState,
} from './export-store.js'
import { denseRangesForChunk, splitTimelapseChunks } from './export-timelapse-chunks.js'
import { readSpawnFailure } from './spawn-failure.js'

interface ProcLike {
  readonly kill: (signal?: NodeJS.Signals) => void
  readonly on: (ev: string, cb: (...a: unknown[]) => void) => void
  readonly stderr?: {
    readonly on: (ev: string, cb: (...a: unknown[]) => void) => void
  } | null
}

type EmitFn = (category: EventCategory, payload: Record<string, unknown>) => void

/**
 * What `resolvePlaylist` answers: the file ffmpeg reads, plus the wall-clock
 * timeline it was assembled from.
 *
 * The segments are not decoration. A dense-range overlay arrives in WALL
 * seconds (the only clock a track has) while ffmpeg's `t` runs over the
 * CONCATENATION with recording gaps removed, and the segment list is the only
 * thing that relates the two — see `export-dense-map.ts` for what believing
 * otherwise cost.
 */
export interface ResolvedExportPlaylist {
  readonly path: string
  /** The FFCONCAT twin of `path` — what the timelapse pass-1 remux reads, so
   *  ffmpeg's `t` runs on the same declared durations the dense map sums. */
  readonly concatPath?: string
  readonly segments: readonly ExportSegmentTiming[]
  /**
   * The concat list as structured rows. Present for a long timelapse so the
   * engine can cut hour-sized chunks; absent on a short export that still
   * uses the single written {@link concatPath}.
   */
  readonly concatEntries?: readonly ExportConcatSegment[]
}

/**
 * One by-handle clip read, as the engine asks for it. Mirrors
 * `videoclips.readClipBytes`'s input; the wiring is the only place that knows
 * it IS that method.
 */
export interface ClipFetchRequest {
  readonly deviceId: number
  readonly clipId: string
  /** The `addonId` that holds the bytes. Carried from the subject, never derived. */
  readonly provider: string
  readonly profile: 'high' | 'mid' | 'low'
  readonly maxBytes: number
  /** The operator's authorisation, passed through VERBATIM. Never invented. */
  readonly wake?: ClipWake
}

/**
 * How long an operator's authorised wake stays spendable.
 *
 * One authorised yes is ONE wake (D558 § 5.2 rule 3), and the two ways a job
 * outlives its yes without anybody meaning it are both real here: it can sit
 * behind {@link EXPORT_MAX_CONCURRENT} long renders, and it can be re-queued
 * after a restart. Five minutes is generous against a job measured at 4–6 s
 * end to end and short enough that a camera is never woken for a tap the
 * operator has forgotten making.
 *
 * Past it the export FAILS with `wake-expired` — a named row the operator can
 * retry with one tap, which re-asks for the authorisation — rather than
 * silently waking the camera on a yes from an hour ago.
 */
/**
 * One by-handle clip read that lands on DISK, as the engine asks for it
 * (D613). Mirrors `videoclips.offerClipBytes` plus the file to write; the
 * wiring is the only place that knows it IS that method and that the byte hop
 * is `ctx.peerBytes`.
 */
export interface ClipFetchToFileRequest extends ClipFetchRequest {
  /** Where the bytes land. Created, and removed again on every failure. */
  readonly outPath: string
}

export type ClipFetchToFileAnswer =
  | {
      readonly kind: 'written'
      readonly bytes: number
      readonly served: CamProfile
      /** MEASURED by the producer, or `null`. Never the row's span (D393). */
      readonly durationMs: number | null
    }
  /** The provider has no `offerClipBytes` — named, never silent. */
  | { readonly kind: 'unsupported'; readonly detail: string }

export const CLIP_WAKE_TTL_MS = 5 * 60_000

export interface ExportEngineDeps {
  readonly spawn: (cmd: string, args: readonly string[]) => ProcLike
  readonly logger: IScopedLogger
  readonly state: RecordingExportsState
  /**
   * The node's pinned ffmpeg (D540). A rejection fails the render with the
   * reason in its stderr tail, logged per camera — never a PATH lookup.
   */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  /**
   * Write (or otherwise resolve) the ffmpeg INPUT playlist for a record's range
   * and return it, or null when no footage covers the range. The playlist must
   * be per-export and its segment URIs must resolve on the LOCAL filesystem —
   * see `export-source-playlist.ts`.
   */
  readonly resolvePlaylist: (rec: ExportRecord) => Promise<ResolvedExportPlaylist | null>
  /**
   * Drop the transient input playlist `resolvePlaylist` produced. Called once
   * per render, on EVERY outcome (ready / failed / cancelled / spawn error), so
   * a render never leaks a file. Must not throw on ENOENT. Optional so a caller
   * whose `resolvePlaylist` returns a pre-existing file can omit it.
   */
  readonly cleanupPlaylist?: (path: string) => Promise<void>
  /** Write a transient concat list (per-hour chunk, final assemble). */
  readonly writeTextFile?: (path: string, contents: string) => Promise<void>
  /**
   * Kill an ffmpeg that has printed no `time=` for this long. The 10 h
   * concat hang printed nothing and sat at 0% until the 30 min renderer
   * timeout; 90 s is enough for a slow USB hour and short enough that the
   * sibling camera still ships before breakfast.
   */
  readonly stallMs?: number
  readonly faststartStallMs?: number
  /** Absolute output path for a record's MP4. */
  readonly outPath: (rec: ExportRecord) => string
  /** Stat the finished file's size in bytes. */
  readonly statBytes: (path: string) => Promise<number>
  /** Remove a (possibly partial) output file; must not throw on ENOENT. */
  readonly removeFile: (path: string) => Promise<void>
  readonly emit: EmitFn
  /** Wall clock, for the wake TTL. Injected so the rule is testable. */
  readonly now?: () => number
  /**
   * Pull a clip's bytes from the addon that owns the camera —
   * `videoclips.readClipBytes` in production. Absent on a recorder with no
   * clip seam wired, and a clip export then FAILS by name rather than sitting
   * queued forever.
   */
  readonly fetchClipBytes?: (req: ClipFetchRequest) => Promise<ClipBytes>
  /**
   * The SAME clip, streamed straight to `outPath` over the addon→addon byte
   * transport (D613) — the path this engine prefers whenever it is wired.
   *
   * Nothing is held: the provider writes its copy to a one-shot loopback
   * socket and this process writes each chunk through to the export file, so
   * the transfer contributes no heap on either side and the 50 MiB inline
   * refusal on a long `high` twin does not apply.
   *
   * An `unsupported` answer means the PROVIDER has no `offerClipBytes` — an
   * addon older than D613. The engine then falls back to {@link
   * fetchClipBytes}, and says so on its own line with the deploy hint,
   * because that fallback re-imposes the inline bound: a
   * `too-large-to-transfer` after D613 shipped is a stale addon, not a clip
   * that cannot be exported.
   */
  readonly fetchClipToFile?: (req: ClipFetchToFileRequest) => Promise<ClipFetchToFileAnswer>
  /** Write the fetched bytes to the export path (creating its directory). */
  readonly writeExportFile?: (path: string, bytes: Buffer) => Promise<void>
}

/** Stderr lines retained for the failure LOG. ffmpeg prints one line per failed
 *  segment before the decisive "Error opening input" summary, so a short tail can
 *  push the actual cause out of the window (it very nearly did — the line that
 *  identified the ENOENT'd segment paths was the 12th). Bounded, because a long
 *  render writes one progress line per second. */
const STDERR_TAIL_LINES = 40
/** Of that tail, the lines persisted into the record's `error` string. The
 *  durable blob and the UI card both want a summary, not the transcript — the
 *  full tail lives in the log. */
const ERROR_FIELD_LINES = 12
const TIME_RE = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/

/**
 * How far a delivered clip's duration may sit from its catalog span before it
 * is worth a line. A remux rounds, a GOP boundary moves a fraction of a
 * second; two seconds is past both and well under D568's own "materially
 * shorter" retry threshold, so this reports a disagreement the PRODUCER
 * already decided to serve rather than second-guessing its completion rule.
 */
const CLIP_DURATION_TOLERANCE_MS = 2_000

/**
 * The source id of the recorder's OWN `videoclips` provider — a visit over
 * footage we wrote, not a file a camera holds (D560).
 *
 * Duplicating the literal rather than importing `videoclips-provider.ts`
 * keeps the engine free of the provider (and of the analytics event reads it
 * carries); the two are pinned together by
 * `export-engine-clip-fetch.spec.ts`.
 */
const ANALYTICS_CLIP_SOURCE = 'analytics'

/**
 * Read a producer's refusal as one of the named clip-export failures.
 *
 * A producer that speaks the vocabulary is believed — `clipExportFailureOf`
 * recovers its token, so a `sleeping` stays `sleeping` all the way to the
 * modal. Anything else is `fetch-failed` **with the producer's words kept
 * verbatim**: inventing a more specific token from prose is how a surface's
 * table came to render every refusal on this fleet as `Refused: <prose>`
 * (ClipStillRefusalCode's own docblock). The one exception is the size bound,
 * which the producer states in numbers rather than in a token, and which the
 * operator must be able to tell from a network failure.
 */
function classifyClipFetchFailure(detail: string): ClipExportFailure {
  const spoken = clipExportFailureOf(detail)
  if (spoken !== null) return spoken
  if (/too large/i.test(detail)) return 'too-large-to-transfer'
  return 'fetch-failed'
}

/**
 * The floor under which an MP4 cannot hold a single decodable frame.
 *
 * **Exit 0 is not the same question as "the file holds a video".** A timelapse
 * whose frame-select predicate matched nothing produced a **262-byte** MP4 —
 * `ftyp` + `moov` + an EMPTY `mdat`, `nb_streams=0` to ffprobe — and ffmpeg
 * exited 0 while doing it. The row went `ready`, `readExportBytes` served the
 * 262 bytes, the notification centre republished them on the artifact plane
 * and a phone was handed a video no player can open (2026-08-12; the operator
 * reported it as "il video è danneggiato", and the served artifact was
 * byte-identical to the file on disk, so the render was the only suspect).
 *
 * A frame-free MP4 tops out around 300 bytes (the box headers and nothing
 * else); the smallest REAL one-frame 640×360 h264 export measured here is
 * several kilobytes. 1 KiB sits between the two with room on both sides, and
 * it is deliberately a byte floor and not an ffprobe call: the engine must be
 * able to refuse an empty render without a second process, on every node,
 * whatever ffmpeg build is installed.
 */
export const EXPORT_MIN_PLAUSIBLE_BYTES = 1024
/** Two cameras' morning windows used to queue behind one hung concat. */
export const EXPORT_MAX_CONCURRENT = 2
/** Default stall — overridable in tests. */
export const EXPORT_STALL_MS = 90_000
/**
 * The faststart pass gets its own, much larger budget.
 *
 * `-movflags +faststart` runs a SECOND pass that rewrites the whole file to
 * move the moov atom to the front, and it emits no `time=` line while it does
 * — the progress-armed watchdog therefore read the silence that pass is MADE
 * OF as a hang. Export 62232d7a (device 104, 2026-09-10) finished its first
 * pass and was SIGKILLed 90 s into the second, and the bigger the export the
 * more certain that kill was.
 *
 * The budget is not removed, because a genuinely wedged rewrite must still
 * die: it is sized for a rewrite of a long export on a spinning array.
 */
export const EXPORT_FASTSTART_STALL_MS = 900_000
/** ffmpeg's own announcement of that pass — the only signal it gives. */
const FASTSTART_RE = /Starting second pass: moving the moov atom/i

/** Expected OUTPUT duration (seconds) for progress scaling. */
function expectedOutSeconds(rec: ExportRecord): number {
  const rangeSec = Math.max(0.001, (rec.toMs - rec.fromMs) / 1000)
  if (rec.options.timelapse) {
    const everySec = rec.options.timelapse.everyMs / 1000
    const fps = rec.options.timelapse.outputFps ?? 30
    return Math.max(0.001, rangeSec / everySec / fps)
  }
  return rangeSec / (rec.options.speed ?? 1)
}

/**
 * A row nobody will read: its caller deleted it, it expired, or it already
 * failed (a cancel finalises as `failed`). The engine renders none of these.
 */
export function isAbandonedExportState(state: ExportRecord['state']): boolean {
  return state === 'deleted' || state === 'expired' || state === 'failed'
}

/** What {@link ExportEngine.memoryCensus} reports. */
export interface ExportEngineCensus {
  readonly queued: number
  readonly active: number
  readonly cancelled: number
}

export class ExportEngine {
  private readonly queue: string[] = []
  /** In-flight jobs → their current ffmpeg (null between the two timelapse passes). */
  private readonly active = new Map<string, ProcLike | null>()
  private readonly cancelled = new Set<string>()

  constructor(private readonly deps: ExportEngineDeps) {}

  /** Entry counts, for the recorder census. */
  memoryCensus(): ExportEngineCensus {
    return { queued: this.queue.length, active: this.active.size, cancelled: this.cancelled.size }
  }

  /** Queue a persisted `queued` record for rendering. */
  enqueue(id: string): void {
    if (this.queue.includes(id) || this.active.has(id)) return
    this.queue.push(id)
    this.pump()
  }

  /** Abort a queued or in-flight render. */
  async cancel(id: string): Promise<void> {
    this.cancelled.add(id)
    const idx = this.queue.indexOf(id)
    if (idx >= 0) this.queue.splice(idx, 1)
    const proc = this.active.get(id)
    if (proc) {
      try {
        proc.kill('SIGKILL')
      } catch {
        // already dead
      }
    } else if (idx >= 0) {
      // Was only queued — finalize as cancelled now (never becomes active).
      await this.fail(id, 'cancelled')
    }
  }

  private pump(): void {
    while (this.active.size < EXPORT_MAX_CONCURRENT && this.queue.length > 0) {
      const id = this.queue.shift()
      if (!id) return
      if (this.cancelled.has(id)) {
        this.cancelled.delete(id)
        void this.fail(id, 'cancelled')
        continue
      }
      this.active.set(id, null)
      void this.runOne(id)
    }
  }

  private async runOne(id: string): Promise<void> {
    try {
      await this.render(id)
    } catch (err: unknown) {
      await this.fail(id, err instanceof Error ? err.message : String(err))
    } finally {
      this.active.delete(id)
      this.pump()
    }
  }

  private async render(id: string): Promise<void> {
    const existing = await getExportRecord(this.deps.state, id)
    if (!existing) return
    // A row its caller already abandoned is never rendered for nobody. The
    // notification centre deletes a recorded cut it stopped waiting for
    // (D686); a queued id still in this queue used to be patched straight
    // back to `rendering` and cut, and its file then sat on disk for the
    // janitor. Named, because a skipped job is dropped work.
    if (isAbandonedExportState(existing.state)) {
      this.deps.logger.info('export render skipped: the export was abandoned before it ran', {
        tags: { deviceId: existing.deviceId },
        meta: { exportId: id, state: existing.state },
      })
      return
    }
    const subject = exportSubjectOf(existing)
    // ONE subject, TWO producers, chosen by the SOURCE NAMESPACE — exactly as
    // `getClipPlayback` already dispatches, and never by a flag a caller sets
    // (D558 § 5.4.3). A NATIVE clip is a file only the camera's owning addon
    // can hand over, so it takes the by-handle fetch. An ANALYTICS clip is a
    // window over footage THIS recorder wrote: it can span holes, and the
    // source playlist plus `export-dense-map` are the machinery that handles
    // them properly — asking ourselves for its bytes by handle would be a
    // second path to footage we already own.
    if (subject.kind === 'clip' && subject.source !== ANALYTICS_CLIP_SOURCE) {
      await this.fetchClip(id, existing, subject)
      return
    }
    // Claim the row for rendering in ONE serialized step with the abandoned
    // check: a delete that lands after the read above must not be patched
    // back to `rendering` (review R5).
    const claimed = await patchExportUnless(
      this.deps.state,
      id,
      { state: 'rendering', progressPct: 0 },
      (current) => isAbandonedExportState(current.state),
    )
    if (claimed.kind === 'missing') return
    if (claimed.kind === 'refused') {
      this.deps.logger.info('export render skipped: the export was abandoned before it ran', {
        tags: { deviceId: claimed.record.deviceId },
        meta: { exportId: id, state: claimed.record.state },
      })
      return
    }
    const rec = claimed.record
    const playlist = await this.deps.resolvePlaylist(rec)
    if (!playlist) {
      await this.fail(id, 'no footage for range')
      return
    }
    try {
      await this.spawnRender(id, rec, playlist, this.streamTimeOptions(rec, playlist.segments))
    } finally {
      // Transient per-export input files — dropped on every outcome so a
      // render never leaks a file (a cleanup failure must not mask the render's
      // own result, so it is swallowed after being logged).
      if (this.deps.cleanupPlaylist) {
        for (const file of [playlist.path, playlist.concatPath].filter(
          (p): p is string => typeof p === 'string' && p.length > 0,
        )) {
          try {
            await this.deps.cleanupPlaylist(file)
          } catch (err: unknown) {
            this.deps.logger.warn('export: source playlist cleanup failed', {
              tags: { deviceId: rec.deviceId },
              meta: {
                exportId: id,
                playlist: file,
                error: err instanceof Error ? err.message : String(err),
              },
            })
          }
        }
      }
    }
  }

  /**
   * The CLIP branch: one by-handle fetch, under a bound, written straight to
   * the export path. No playlist, no ffmpeg, no second completion rule.
   *
   * The recorder cannot produce these bytes itself — talking to the camera is
   * the owning addon's monopoly (one session per host, the sleep gate before
   * `getApi()`, a cmd-5 transfer whose completion is an idle window proved
   * against the catalog span, D549 17 / D568) — and there is no addon→addon
   * byte transport, so the producer's own cap read is the seam (D558 § 3).
   *
   * `progressPct` stays `null` for the whole fetch. The job is measured at
   * 4–6 s end to end and only two of its phases have a real denominator; a
   * ramp would be a number nothing measured (D558 § 5.1).
   *
   * Every exit is named. A branch that accepts work and produces nothing is
   * the branch this repo keeps losing work in (D391), and a clip export has
   * five such branches a footage render does not have.
   */
  private async fetchClip(
    id: string,
    rec: ExportRecord,
    subject: ExportClipSubject,
  ): Promise<void> {
    const tags = { deviceId: rec.deviceId }
    const now = (this.deps.now ?? Date.now)()
    // The wake TTL is checked BEFORE anything else that could reach the
    // camera, because reaching it IS the wake.
    if (subject.wake !== undefined && now - rec.createdAt > CLIP_WAKE_TTL_MS) {
      const waitedMs = now - rec.createdAt
      this.deps.logger.warn('clip export refused: it outlived the wake it was granted', {
        tags,
        meta: { exportId: id, clipId: subject.clipId, waitedMs, ttlMs: CLIP_WAKE_TTL_MS },
      })
      await this.fail(
        id,
        clipExportFailure(
          'wake-expired',
          `queued ${Math.round(waitedMs / 1000)}s ago, past the ${Math.round(
            CLIP_WAKE_TTL_MS / 1000,
          )}s an authorised wake stays spendable — ask again to wake the camera`,
        ),
      )
      return
    }
    const fetchClipToFile = this.deps.fetchClipToFile
    const fetchClipBytes = this.deps.fetchClipBytes
    const writeExportFile = this.deps.writeExportFile
    const inlineWired = fetchClipBytes !== undefined && writeExportFile !== undefined
    if (fetchClipToFile === undefined && !inlineWired) {
      this.deps.logger.error('clip export refused: this recorder has no clip byte reader wired', {
        tags,
        meta: { exportId: id, clipId: subject.clipId },
      })
      await this.fail(
        id,
        clipExportFailure('fetch-failed', 'this recorder has no clip byte reader wired'),
      )
      return
    }
    await patchExport(this.deps.state, id, { state: 'rendering', progressPct: null })
    this.deps.logger.info('clip export fetch starting', {
      tags,
      meta: {
        exportId: id,
        clipId: subject.clipId,
        source: subject.source,
        provider: subject.provider,
        profile: subject.profile,
        wake: subject.wake ?? 'none',
        transport: fetchClipToFile !== undefined ? 'peer-bytes' : 'inline',
      },
    })

    const outPath = this.deps.outPath(rec)
    const request: ClipFetchRequest = {
      deviceId: subject.deviceId,
      clipId: subject.clipId,
      // The subject has carried this all along and the fetch dropped it. A
      // read with no provider named resolves, in-process, to whichever
      // sibling the addon registers — for THIS addon that is the recorder's
      // own videoclips provider, which has no file behind an analytics
      // visit and says so (3628, 2026-09-21).
      provider: subject.provider,
      profile: subject.profile,
      maxBytes: RECORDING_EXPORT_MAX_READ_BYTES,
      ...(subject.wake !== undefined ? { wake: subject.wake } : {}),
    }

    /** What actually landed, whichever transport landed it. */
    let delivered: { bytes: number; served: CamProfile; durationMs: number | null } | null = null

    // The preferred path: the provider offers the bytes and they stream
    // straight to the export file (D613). Nothing is held, so the inline
    // bound does not apply and a long `high` twin is exportable.
    if (fetchClipToFile !== undefined) {
      try {
        const answer = await fetchClipToFile({
          ...request,
          outPath,
          maxBytes: VIDEOCLIPS_MAX_OFFER_BYTES,
        })
        if (answer.kind === 'written') {
          delivered = {
            bytes: answer.bytes,
            served: answer.served,
            durationMs: answer.durationMs,
          }
        } else if (!inlineWired) {
          // Nothing else to try, and saying "no bytes" would be a lie about
          // the clip.
          this.deps.logger.error('clip export refused: the provider offers no byte handle', {
            tags,
            meta: { exportId: id, clipId: subject.clipId, detail: answer.detail },
          })
          await this.fail(id, clipExportFailure('fetch-failed', answer.detail))
          return
        } else {
          // NAMED, never silent: the fallback re-imposes the inline bound, so
          // a `too-large-to-transfer` after this is a stale addon rather than
          // a clip that cannot be exported.
          this.deps.logger.warn(
            'clip export falling back to the inline read — this provider predates the byte transport',
            {
              tags,
              meta: {
                exportId: id,
                clipId: subject.clipId,
                provider: subject.provider,
                detail: answer.detail,
                inlineBound: RECORDING_EXPORT_MAX_READ_BYTES,
                hint: `camstack deploy ${subject.provider}`,
              },
            },
          )
        }
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err)
        const code = classifyClipFetchFailure(detail)
        this.deps.logger.warn('clip export fetch failed', {
          tags,
          meta: {
            exportId: id,
            clipId: subject.clipId,
            reason: code,
            error: detail,
            transport: 'peer-bytes',
          },
        })
        await this.deps.removeFile(outPath)
        await this.fail(id, clipExportFailure(code, detail))
        return
      }
    }

    if (delivered === null) {
      let answer: ClipBytes
      if (fetchClipBytes === undefined || writeExportFile === undefined) {
        // Unreachable: `inlineWired` gated the fallback above. Named anyway,
        // because a branch that drops work silently reads as never happened.
        await this.fail(
          id,
          clipExportFailure('fetch-failed', 'this recorder has no clip byte reader wired'),
        )
        return
      }
      try {
        answer = await fetchClipBytes(request)
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err)
        const code = classifyClipFetchFailure(detail)
        this.deps.logger.warn('clip export fetch failed', {
          tags,
          meta: {
            exportId: id,
            clipId: subject.clipId,
            reason: code,
            error: detail,
            transport: 'inline',
          },
        })
        await this.fail(id, clipExportFailure(code, detail))
        return
      }

      if (this.cancelled.has(id)) {
        this.cancelled.delete(id)
        await this.fail(id, 'cancelled')
        return
      }

      const bytes = Buffer.from(answer.base64, 'base64')
      if (bytes.byteLength > RECORDING_EXPORT_MAX_READ_BYTES) {
        // Belt and braces: the producer refuses first, before it encodes. If one
        // does not, the file is still never written — half a video is worse than
        // an honest refusal.
        this.deps.logger.warn('clip export refused: the answer exceeded the transfer bound', {
          tags,
          meta: {
            exportId: id,
            bytes: bytes.byteLength,
            maxBytes: RECORDING_EXPORT_MAX_READ_BYTES,
          },
        })
        await this.fail(
          id,
          clipExportFailure(
            'too-large-to-transfer',
            `${bytes.byteLength} > ${RECORDING_EXPORT_MAX_READ_BYTES} bytes`,
          ),
        )
        return
      }

      try {
        await writeExportFile(outPath, bytes)
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err)
        this.deps.logger.error('clip export could not be written', {
          tags,
          meta: { exportId: id, outPath, error: detail },
        })
        await this.deps.removeFile(outPath)
        await this.fail(
          id,
          clipExportFailure('fetch-failed', `could not write the export: ${detail}`),
        )
        return
      }
      delivered = {
        bytes: bytes.byteLength,
        served: answer.served,
        durationMs: answer.durationMs ?? null,
      }
    }

    if (this.cancelled.has(id)) {
      this.cancelled.delete(id)
      await this.deps.removeFile(outPath)
      await this.fail(id, 'cancelled')
      return
    }

    if (delivered.bytes < EXPORT_MIN_PLAUSIBLE_BYTES) {
      // The same floor the render path uses, and for the same incident: a
      // 262-byte MP4 is box headers and an empty `mdat`, and it reached a
      // phone once already.
      this.deps.logger.error('clip export produced no video', {
        tags,
        meta: {
          exportId: id,
          clipId: subject.clipId,
          bytes: delivered.bytes,
          minBytes: EXPORT_MIN_PLAUSIBLE_BYTES,
        },
      })
      await this.deps.removeFile(outPath)
      await this.fail(
        id,
        clipExportFailure(
          'fetch-failed',
          `the source answered ${delivered.bytes} bytes, under the ${EXPORT_MIN_PLAUSIBLE_BYTES} a playable MP4 needs`,
        ),
      )
      return
    }

    // What was SERVED, not what was projected. The catalog row answers this
    // before the fetch and is usually right; when it is not, the producer's
    // answer wins and the row is corrected — a divergence nobody can see is
    // the silent fallback D549 15 exists to prevent.
    const servedPatch =
      delivered.served !== rec.profile
        ? { profile: delivered.served }
        : ({} as Record<string, never>)
    if (delivered.served !== rec.profile) {
      this.deps.logger.warn('clip export served a different twin than the catalog projected', {
        tags,
        meta: {
          exportId: id,
          clipId: subject.clipId,
          asked: subject.profile,
          projected: rec.profile,
          served: delivered.served,
        },
      })
    }
    // A delivered file whose duration disagrees with the row is a row the
    // operator's `range` label is describing wrongly — and the row may simply
    // be stale (`catalogAsOf`). Say so; rewrite NEITHER number (D558 § 5.4.1).
    const claimedMs = rec.toMs - rec.fromMs
    if (
      delivered.durationMs !== null &&
      Math.abs(delivered.durationMs - claimedMs) > CLIP_DURATION_TOLERANCE_MS
    ) {
      this.deps.logger.warn('clip export duration disagrees with the catalog row', {
        tags,
        meta: {
          exportId: id,
          clipId: subject.clipId,
          catalogSpanMs: claimedMs,
          deliveredMs: delivered.durationMs,
        },
      })
    }

    await patchExport(this.deps.state, id, {
      state: 'ready',
      progressPct: 100,
      fileBytes: delivered.bytes,
      error: null,
      ...servedPatch,
    })
    this.deps.logger.info('clip export ready', {
      tags,
      meta: {
        exportId: id,
        clipId: subject.clipId,
        outPath,
        bytes: delivered.bytes,
        served: delivered.served,
      },
    })
    this.deps.emit(EventCategory.RecordingExportCompleted, {
      exportId: id,
      fileBytes: delivered.bytes,
      deviceId: rec.deviceId,
      ...(rec.options.title !== undefined ? { title: rec.options.title } : {}),
      ...(rec.options.notifyTargetIds !== undefined && rec.options.notifyTargetIds.length > 0
        ? { notifyTargetIds: rec.options.notifyTargetIds }
        : {}),
    })
  }

  /**
   * The record's options with any dense overlay moved onto ffmpeg's clock.
   *
   * The translation is reported on EVERY render that carries an overlay, not
   * only when something is dropped: `denseRangesRequested` vs
   * `denseRangesMapped` is the one line that can tell "the video is uniform
   * because the night was quiet" from "the video is uniform because every range
   * missed" — the distinction that went unnoticed for a full night because the
   * only line printed was the requested count.
   */
  private streamTimeOptions(
    rec: ExportRecord,
    segments: readonly ExportSegmentTiming[],
  ): ExportOptions {
    const { options, report } = withStreamTimeDenseRanges({
      options: rec.options,
      fromMs: rec.fromMs,
      segments,
    })
    if (report !== null) this.logDenseMapping(rec, report)
    return options
  }

  /** One line, whatever the outcome — `warn` when ranges were dropped, because
   *  a dropped range is footage the operator asked for and did not get. */
  private logDenseMapping(rec: ExportRecord, report: DenseRangeMapReport): void {
    const entry = {
      tags: { deviceId: rec.deviceId },
      meta: {
        exportId: rec.id,
        denseRangesRequested: report.requested,
        denseRangesMapped: report.mapped,
        ...(report.dropped.length > 0 ? { denseRangesDropped: report.dropped } : {}),
      },
    }
    const message = 'export dense ranges mapped onto the concatenated stream'
    if (report.dropped.length > 0) this.deps.logger.warn(message, entry)
    else this.deps.logger.info(message, entry)
  }

  /** Spawn ffmpeg for one render and resolve when it has exited + finalized. */
  private async spawnRender(
    id: string,
    rec: ExportRecord,
    playlist: ResolvedExportPlaylist,
    options: ExportOptions,
  ): Promise<void> {
    const outPath = this.deps.outPath(rec)
    this.deps.logger.info('export render starting', {
      tags: { deviceId: rec.deviceId },
      meta: {
        exportId: id,
        deviceId: rec.deviceId,
        profile: rec.profile,
        playlist: playlist.path,
        outPath,
      },
    })

    if (options.timelapse) {
      await this.spawnTimelapse(id, rec, playlist, outPath, options)
      return
    }

    const args = buildExportArgs({
      inputPlaylist: playlist.path,
      outPath,
      options,
    })
    const ran = await this.runFfmpeg(id, rec.deviceId, args, {
      totalSec: expectedOutSeconds(rec),
      floor: 0,
      ceil: 99,
    })
    await this.finish(id, ran.code, outPath, ran.stderrTail)
  }

  /**
   * Concat the recorded pieces into one continuous file, THEN select frames.
   * The select filter on a discontinuity-heavy playlist is what parked a
   * 30h job at `rendering 0%` — pass 1 is `-c copy` into mpegts so pass 2
   * sees a single timestamp line. The input is the export's FFCONCAT list
   * (declared per-segment durations), never the HLS playlist, so that single
   * timestamp line runs on the SAME clock the dense map summed — see
   * `export-ffmpeg-args.ts` for what the HLS demuxer's content-stitching cost.
   */
  private async spawnTimelapse(
    id: string,
    rec: ExportRecord,
    playlist: ResolvedExportPlaylist,
    outPath: string,
    options: ExportOptions,
  ): Promise<void> {
    const entries = playlist.concatEntries ?? []
    const chunks = splitTimelapseChunks(entries)
    if (chunks.length <= 1) {
      const concatList = playlist.concatPath
      if (concatList === undefined) {
        await this.fail(id, 'no concat list for timelapse')
        return
      }
      await this.spawnTimelapsePair(id, rec, concatList, outPath, options, {
        floor: 0,
        ceil: 99,
      })
      return
    }
    if (this.deps.writeTextFile === undefined) {
      const concatList = playlist.concatPath
      if (concatList === undefined) {
        await this.fail(id, 'no concat list for timelapse')
        return
      }
      await this.spawnTimelapsePair(id, rec, concatList, outPath, options, {
        floor: 0,
        ceil: 99,
      })
      return
    }

    const survivors: string[] = []
    const sidecars: string[] = []
    try {
      // `chunks.entries()` rather than an index loop: indexing yields
      // `T | undefined` under `noUncheckedIndexedAccess`, and the bound check
      // that makes it safe is not one the compiler can follow.
      for (const [i, chunk] of chunks.entries()) {
        if (this.cancelled.has(id)) {
          await this.fail(id, 'cancelled')
          return
        }
        const chunkDur = chunk.entries.reduce((s, e) => s + e.durMs, 0)
        const listPath = `${outPath}.chunk${i}.ffconcat`
        const concatPath = `${outPath}.chunk${i}.concat.ts`
        const chunkMp4 = `${outPath}.chunk${i}.mp4`
        sidecars.push(listPath, concatPath, chunkMp4)
        await this.deps.writeTextFile(listPath, buildExportConcatList(chunk.entries))
        const span = 90 / chunks.length
        const floor = Math.round(i * span)
        const ran = await this.spawnTimelapsePair(
          id,
          rec,
          listPath,
          chunkMp4,
          {
            ...options,
            timelapse: options.timelapse
              ? {
                  ...options.timelapse,
                  dense: denseRangesForChunk(
                    options.timelapse.dense,
                    chunk.streamStartMs,
                    chunkDur,
                  ),
                }
              : options.timelapse,
          },
          { floor, ceil: floor + Math.round(span * 0.95), finish: false },
        )
        if (ran === 'ok') survivors.push(chunkMp4)
        else {
          this.deps.logger.warn('export timelapse hour skipped', {
            tags: { deviceId: rec.deviceId },
            meta: { exportId: id, chunk: i, streamStartMs: chunk.streamStartMs },
          })
        }
      }
      if (survivors.length === 0) {
        await this.fail(id, 'every timelapse hour failed')
        return
      }
      const only = survivors[0]
      if (survivors.length === 1 && only !== undefined) {
        const copyArgs = buildExportArgs({
          inputPlaylist: only,
          outPath,
          options: { includeAudio: false, maxLifeMs: 1, deleteAfterDownload: false, speed: 1 },
        })
        const copied = await this.runFfmpeg(id, rec.deviceId, copyArgs, {
          totalSec: expectedOutSeconds(rec),
          floor: 95,
          ceil: 99,
        })
        await this.finish(id, copied.code, outPath, copied.stderrTail)
        return
      }
      const assembleList = `${outPath}.assemble.ffconcat`
      sidecars.push(assembleList)
      await this.deps.writeTextFile(assembleList, buildAssembleConcatList(survivors))
      const assembled = await this.runFfmpeg(
        id,
        rec.deviceId,
        buildAssembleArgs({ inputConcatList: assembleList, outPath }),
        { totalSec: expectedOutSeconds(rec), floor: 95, ceil: 99 },
      )
      await this.finish(id, assembled.code, outPath, assembled.stderrTail)
    } finally {
      for (const file of sidecars) {
        try {
          await this.deps.removeFile(file)
        } catch {
          // sidecar must not mask the render result
        }
      }
    }
  }

  /**
   * Concat remux then select. `finish: false` lets the chunk walker skip a
   * dead hour without failing the whole night.
   */
  private async spawnTimelapsePair(
    id: string,
    rec: ExportRecord,
    concatList: string,
    outPath: string,
    options: ExportOptions,
    progress: { readonly floor: number; readonly ceil: number; readonly finish?: boolean },
  ): Promise<'ok' | 'fail'> {
    const concatPath = concatPassOutPath(outPath)
    const mid = progress.floor + Math.round((progress.ceil - progress.floor) / 2)
    try {
      const concatArgs = buildConcatPassArgs({
        inputConcatList: concatList,
        outPath: concatPath,
      })
      const concatRan = await this.runFfmpeg(id, rec.deviceId, concatArgs, {
        totalSec: Math.max(0.001, (rec.toMs - rec.fromMs) / 1000),
        floor: progress.floor,
        ceil: mid,
      })
      if (this.cancelled.has(id) || concatRan.code !== 0) {
        if (progress.finish !== false) {
          await this.finish(id, concatRan.code, concatPath, concatRan.stderrTail)
        }
        return 'fail'
      }
      const selectArgs = buildExportArgs({
        inputPlaylist: concatPath,
        outPath,
        options,
      })
      const selectRan = await this.runFfmpeg(id, rec.deviceId, selectArgs, {
        totalSec: expectedOutSeconds(rec),
        floor: mid,
        ceil: progress.ceil,
      })
      if (progress.finish !== false) {
        await this.finish(id, selectRan.code, outPath, selectRan.stderrTail)
      }
      return selectRan.code === 0 ? 'ok' : 'fail'
    } finally {
      try {
        await this.deps.removeFile(concatPath)
      } catch {
        // sidecar must not mask the render result
      }
    }
  }

  private async runFfmpeg(
    id: string,
    deviceId: number,
    args: readonly string[],
    progress: {
      readonly totalSec: number
      readonly floor: number
      readonly ceil: number
    },
  ): Promise<{ code: number | null; stderrTail: string[] }> {
    let ffmpegPath: string
    try {
      ffmpegPath = await this.deps.resolveFfmpeg()
    } catch (err: unknown) {
      const reason = `no pinned ffmpeg on this node: ${err instanceof Error ? err.message : String(err)}`
      this.deps.logger.error('export render refused — no pinned ffmpeg on this node (D540)', {
        tags: { deviceId },
        meta: { exportId: id, error: reason },
      })
      return { code: null, stderrTail: [reason] }
    }
    this.deps.logger.debug('export ffmpeg argv', {
      meta: { exportId: id, args },
    })
    const stallMs = this.deps.stallMs ?? EXPORT_STALL_MS
    const faststartStallMs = this.deps.faststartStallMs ?? EXPORT_FASTSTART_STALL_MS
    return await new Promise((resolve) => {
      const proc = this.deps.spawn(ffmpegPath, args)
      this.active.set(id, proc)
      const stderrTail: string[] = []
      let stallTimer: ReturnType<typeof setTimeout> | null = null
      const clearStall = (): void => {
        if (stallTimer !== null) {
          clearTimeout(stallTimer)
          stallTimer = null
        }
      }
      let budgetMs = stallMs
      const armStall = (): void => {
        clearStall()
        const armedFor = budgetMs
        stallTimer = setTimeout(() => {
          stderrTail.push(`ffmpeg stalled: no progress for ${armedFor}ms`)
          try {
            proc.kill('SIGKILL')
          } catch {
            // already dead
          }
        }, armedFor)
      }
      armStall()
      proc.stderr?.on('data', (chunk: unknown) => {
        const text = chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk)
        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (trimmed) {
            stderrTail.push(trimmed)
            if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift()
          }
          // The faststart pass announces itself once and then works in
          // silence. Widen the budget rather than letting that silence read as
          // a hang — and re-arm here, because this line is the last output
          // ffmpeg will produce before the file is done.
          if (FASTSTART_RE.test(line)) {
            budgetMs = faststartStallMs
            armStall()
          }
          const m = TIME_RE.exec(line)
          if (m) {
            armStall()
            const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
            const span = progress.ceil - progress.floor
            const pct = Math.min(
              progress.ceil,
              progress.floor + Math.round((sec / progress.totalSec) * span),
            )
            void patchExport(this.deps.state, id, { progressPct: pct })
            this.deps.emit(EventCategory.RecordingExportProgress, {
              exportId: id,
              progressPct: pct,
            })
          }
        }
      })
      proc.on('exit', (code: unknown) => {
        clearStall()
        this.active.set(id, null)
        resolve({ code: typeof code === 'number' ? code : null, stderrTail })
      })
      // ffmpeg could not be STARTED (EAGAIN under fork pressure, ENOENT with no
      // binary). Node re-throws an unhandled `'error'` as an uncaught
      // exception, and this engine shares the `recorder` runner with every
      // camera's segment writers — so without this listener a failed export
      // spawn takes FLEET-WIDE RECORDING down (2026-08-18, three hours). The
      // failure is reported as the render failing, through the one existing
      // `finish` path: `code: null` is already "did not exit 0".
      proc.on('error', (raw: unknown) => {
        clearStall()
        this.active.set(id, null)
        const failure = readSpawnFailure(raw)
        this.deps.logger.error('export ffmpeg could not be spawned', {
          tags: { deviceId },
          meta: {
            exportId: id,
            errorCode: failure.code,
            error: failure.message,
            permanent: failure.permanent,
          },
        })
        stderrTail.push(
          `ffmpeg spawn failed: ${failure.message}` +
            (failure.code === undefined ? '' : ` (${failure.code})`),
        )
        resolve({ code: null, stderrTail })
      })
    })
  }

  private async finish(
    id: string,
    code: number | null,
    outPath: string,
    stderrTail: string[],
  ): Promise<void> {
    if (this.cancelled.has(id)) {
      this.cancelled.delete(id)
      await this.deps.removeFile(outPath)
      await this.fail(id, 'cancelled')
      return
    }
    if (code !== 0) {
      // The record's `error` string is truncated by the UI, so the full tail
      // only survives here — log it before anything can drop it.
      this.deps.logger.error('export ffmpeg failed', {
        meta: { exportId: id, code, outPath, stderr: stderrTail.join('\n') },
      })
      await this.deps.removeFile(outPath)
      await this.fail(
        id,
        `ffmpeg exited ${code}: ${stderrTail.slice(-ERROR_FIELD_LINES).join(' | ')}`,
      )
      return
    }
    let bytes = 0
    try {
      bytes = await this.deps.statBytes(outPath)
    } catch (err: unknown) {
      await this.fail(id, err instanceof Error ? err.message : String(err))
      return
    }
    if (bytes < EXPORT_MIN_PLAUSIBLE_BYTES) {
      // A branch that drops work logs it. This one used to drop it SILENTLY —
      // by calling it a success — which is how an unplayable file reached a
      // phone (see EXPORT_MIN_PLAUSIBLE_BYTES).
      this.deps.logger.error('export produced no video frames', {
        meta: {
          exportId: id,
          outPath,
          bytes,
          minBytes: EXPORT_MIN_PLAUSIBLE_BYTES,
        },
      })
      await this.deps.removeFile(outPath)
      await this.fail(
        id,
        `render produced no video frames (${bytes} bytes, < ${EXPORT_MIN_PLAUSIBLE_BYTES})`,
      )
      return
    }
    // The row may have been abandoned WHILE ffmpeg ran (a caller that deletes
    // without cancelling). Publishing it `ready` would resurrect a deleted
    // export and keep a file nobody will read.
    const current = await getExportRecord(this.deps.state, id)
    if (current !== null && isAbandonedExportState(current.state)) {
      await this.deps.removeFile(outPath)
      this.deps.logger.info('export render discarded: the export was abandoned while it ran', {
        tags: { deviceId: current.deviceId },
        meta: { exportId: id, state: current.state, bytes },
      })
      return
    }
    await patchExport(this.deps.state, id, {
      state: 'ready',
      progressPct: 100,
      fileBytes: bytes,
      error: null,
    })
    this.deps.logger.info('export render ready', {
      meta: { exportId: id, outPath, bytes },
    })
    const rec = await getExportRecord(this.deps.state, id)
    this.deps.emit(EventCategory.RecordingExportCompleted, {
      exportId: id,
      fileBytes: bytes,
      ...(rec !== null
        ? {
            deviceId: rec.deviceId,
            ...(rec.options.title !== undefined ? { title: rec.options.title } : {}),
            ...(rec.options.notifyTargetIds !== undefined && rec.options.notifyTargetIds.length > 0
              ? { notifyTargetIds: rec.options.notifyTargetIds }
              : {}),
          }
        : {}),
    })
  }

  private async fail(id: string, error: string): Promise<void> {
    this.deps.logger.warn('export render failed', {
      meta: { exportId: id, error },
    })
    // A deleted row stays deleted: a cancel that finalises after the caller's
    // delete must not turn the row back into a `failed` export.
    const current = await getExportRecord(this.deps.state, id)
    if (current !== null && current.state === 'deleted') return
    await patchExport(this.deps.state, id, {
      state: 'failed',
      progressPct: null,
      error,
    })
    this.deps.emit(EventCategory.RecordingExportFailed, {
      exportId: id,
      error,
    })
  }
}
