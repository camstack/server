/**
 * `recording-export` cap — render a footage time range into a single downloadable
 * MP4 (regular / accelerated / decelerated / timelapse, ± audio), kept for a
 * bounded lifetime with a durable history, auto-expiry, and optional
 * delete-after-download.
 *
 * Like `recording` this is a `scope:'system', mode:'singleton'` cap: the
 * recorder self-gates so exactly ONE node (the designated `recordingNodeId`,
 * default `hub`) registers it. Device-scoped methods carry `deviceId` in their
 * input and dispatch to that single provider; the render runs on the node that
 * owns the footage (no cross-node segment transfer). Download rides the
 * framework addon data-plane. State persists in a DurableState blob (NOT
 * SQLite); history rows survive file deletion for audit.
 */
import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { ClipWakeSchema } from './videoclips.cap.js'

/** Playback-speed multiplier for the render (1 = realtime). */
export const ExportSpeedSchema = z.number().min(0.25).max(32)

/**
 * One dense interval, in WALL-CLOCK SECONDS FROM THE EXPORT'S OWN `fromMs`.
 *
 * **Wall clock, not ffmpeg's `t`** — and the recorder translates. A caller
 * derives these bounds from things that happened at a TIME (a track's
 * `firstSeen`), while `t` runs over the source playlist: the concatenation of
 * every segment present for the range, with each recording GAP removed. The
 * two agree only on a window that recorded without one interruption, and only
 * the render side knows the segments, so the translation lives there
 * (`export-dense-map.ts`, addon-pipeline).
 *
 * It was not always so. These seconds were fed to `between(t,…)` verbatim, and
 * on a 10 h window holding 29,393 s of footage every range landed late by the
 * gap accumulated before it — up to 6,607 s, well past EOF. Nothing matched,
 * the video was a uniform timelapse, and the log line reported the five ranges
 * that had been ASKED for (2026-08-13, export `57d14363`, camera 101).
 *
 * Relative and not absolute epoch, because an absolute epoch would make every
 * call site responsible for the same subtraction.
 */
export const ExportDenseRangeSchema = z
  .object({
    fromSec: z.number().nonnegative(),
    toSec: z.number().nonnegative(),
  })
  .refine((r) => r.toSec > r.fromSec, { message: 'dense range must have toSec > fromSec' })
export type ExportDenseRange = z.infer<typeof ExportDenseRangeSchema>

/**
 * Hard ceiling on dense ranges in ONE render.
 *
 * The ranges become terms of a single ffmpeg `select` expression, so the count
 * is the length of a command-line argument. The producer (the timelapse
 * scheduler) coalesces and then falls back to the base cadence alone rather
 * than trimming — a truncated range list is a video that quietly omits the
 * evening.
 */
export const EXPORT_DENSE_MAX_RANGES = 200

/**
 * Dense-interval overlay for a timelapse: sample at `dense.everyMs` INSIDE the
 * listed ranges and at the base `everyMs` everywhere else.
 *
 * `everyMs` must be strictly smaller than the base cadence — a dense rate that
 * is not denser renders a uniform timelapse the operator believes is two-rate.
 */
export const ExportDenseSchema = z.object({
  everyMs: z.number().int().positive(),
  ranges: z.array(ExportDenseRangeSchema).min(1).max(EXPORT_DENSE_MAX_RANGES),
})
export type ExportDense = z.infer<typeof ExportDenseSchema>

/** Timelapse cadence — sample one source frame per `everyMs`, output at `outputFps`. */
export const ExportTimelapseSchema = z
  .object({
    everyMs: z.number().int().positive(),
    outputFps: z.number().int().min(1).max(60).optional(),
    /** Optional second, FASTER rate over the intervals that matter. */
    dense: ExportDenseSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.dense !== undefined && v.dense.everyMs >= v.everyMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'dense.everyMs must be strictly smaller than the base everyMs',
        path: ['dense', 'everyMs'],
      })
    }
  })

/**
 * Render options. `speed` and `timelapse` are mutually exclusive. `includeAudio`
 * is honoured only for a realtime-ish speed (0.5–2×); timelapse is always
 * silent. `maxLifeMs` bounds how long the finished file is kept;
 * `deleteAfterDownload` removes it shortly after the first complete download.
 */
export const ExportOptionsSchema = z
  .object({
    speed: ExportSpeedSchema.optional(),
    timelapse: ExportTimelapseSchema.optional(),
    includeAudio: z.boolean(),
    maxLifeMs: z.number().int().positive(),
    deleteAfterDownload: z.boolean(),
    title: z.string().max(200).optional(),
    /** Notification-output target ids to ping when this export becomes ready. */
    notifyTargetIds: z.array(z.string().min(1)).max(20).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.speed !== undefined && v.timelapse !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'speed and timelapse are mutually exclusive',
        path: ['timelapse'],
      })
    }
  })
export type ExportOptions = z.infer<typeof ExportOptionsSchema>

export const ExportStateSchema = z.enum([
  'queued',
  'rendering',
  'ready',
  'failed',
  'expired',
  'deleted',
])
export type ExportState = z.infer<typeof ExportStateSchema>

/**
 * A stretch of footage THIS system recorded — the only thing `createExport`
 * could export before D558, and still the shape every legacy caller sends.
 */
export const ExportFootageSubjectSchema = z.object({
  kind: z.literal('footage'),
  deviceId: z.number(),
  profiles: z.array(z.string()).min(1),
  fromMs: z.number(),
  toMs: z.number(),
})
export type ExportFootageSubject = z.infer<typeof ExportFootageSubjectSchema>

/**
 * A CLIP — a finished file with boundaries the camera chose, listed by one of
 * the device's `videoclips` sources.
 *
 * There is deliberately **no `fromMs`/`toMs` here**. The camera chose them,
 * no surface on this path asks for them (there is no drag and no
 * `datetime-local` pair — D558 § 5.4.3), and they reach the record only as the
 * projection. A range in the subject would be a second place the boundaries
 * live and the one a caller could get wrong.
 *
 * `provider` is the **addonId** of the source's serving addon — the `provider`
 * pin `videoclips.listClips` REQUIRES since D554 was amended on 2026-09-20.
 * There was never a default: a bare call fanned out and returned the union of
 * every source with `limit` meaning `limit × sources`. The catalog check that
 * validates this subject names it, so it asks exactly the source the operator
 * picked.
 *
 * `source` is that source's id (the namespace `clipId` is prefixed with), and
 * `sourceLabel` is its operator-facing name FROZEN at creation — a history row
 * still reads "SD card" after the source is unbound.
 *
 * `profile` is exactly ONE, and it is what was ASKED. What was SERVED lands on
 * the record's top-level `profile`, so a clip with no main twin renders the
 * divergence instead of hiding it (D549 15; measured on 592, 17 of 546 clips
 * had no main twin, so a silent fallback would be right 96.9 % of the time).
 * `auto` is not a member: a stored file has no broker session, so the adaptive
 * tier cannot be resolved for it.
 */
export const ExportClipSubjectSchema = z.object({
  kind: z.literal('clip'),
  deviceId: z.number(),
  provider: z.string().min(1),
  source: z.string().min(1),
  sourceLabel: z.string().min(1),
  clipId: z.string().min(1),
  /**
   * WHERE IN THE CATALOG to confirm this clip — the day window the surface was
   * already listing when the operator picked the segment.
   *
   * It is **not** a time range control and it never becomes one: the record's
   * `fromMs`/`toMs` come from the catalog ROW and from nothing a caller
   * supplied (D558 § 5.4.3), and a window that does not contain the clip is a
   * `catalog-miss`, not a silently wider search. It exists because
   * `videoclips.listClips` takes `since`/`until` and has no by-handle twin:
   * the catalog check D558 asks for is literally that call, and a call needs a
   * window. The surface has one — `ClipsBrowser`'s `dayWindow`, one local
   * wall-clock day, which is also the only width measured to be cheap (one
   * day on 592 lists 171 clips in 712 ms, a busy day 546 in 2.0 s; twenty days
   * of one child's events took 3.6–5.4 s).
   */
  catalogWindow: z.object({ sinceMs: z.number(), untilMs: z.number() }),
  profile: z.enum(['high', 'mid', 'low']),
  /**
   * The operator's authorisation to wake a sleeping camera for this export.
   * ONE definition, in the cap that owns the clip read ({@link ClipWakeSchema}),
   * because the gate that honours it is the clip provider's sleep gate — a
   * second enum here would be a second contract. Absent by default; never
   * settable by a scheduler or a retry.
   *
   * **One authorised yes is ONE wake.** A failed clip export is retried only by
   * an operator act that asks again; a queued job that outlived its wake fails
   * with a reason rather than waking on its turn; and this subject carries
   * exactly one profile precisely so one tap is never two fetches (D558 § 5.2).
   */
  wake: ClipWakeSchema.optional(),
})
export type ExportClipSubject = z.infer<typeof ExportClipSubjectSchema>

/**
 * WHAT an export is — the authority, as opposed to the four top-level fields
 * the Library sorts and labels on (D558 § 2.2).
 *
 * Read it through {@link exportSubjectOf}, never off the record directly: the
 * field is optional for the history rows written before it existed, and that
 * absence has exactly one interpreter.
 */
export const ExportSubjectSchema = z.discriminatedUnion('kind', [
  ExportFootageSubjectSchema,
  ExportClipSubjectSchema,
])
export type ExportSubject = z.infer<typeof ExportSubjectSchema>

/**
 * One export job / history row.
 *
 * **`subject` is the AUTHORITY on what was exported. `deviceId`, `profile`,
 * `fromMs` and `toMs` are its PROJECTION** — kept top-level because the whole
 * Library sorts and labels on them (`library-items.ts` orders an export by
 * `fromMs`; `export-format.ts` draws `rangeLabel` from the pair), and a row
 * that did not fill them would sort under the epoch and render a blank range.
 * Write to the subject and read from the projection and the two will disagree;
 * the projection is derived at creation and never edited afterwards.
 *
 * And they mean DIFFERENT FACTS for the two kinds, which is the part a reader
 * who knows only the recording export will get wrong:
 *
 * | field | `kind:'footage'` | `kind:'clip'` |
 * | --- | --- | --- |
 * | `fromMs`/`toMs` | the stretch the operator ASKED for | the camera's own boundaries, always `clip.timeRange`, never anything a caller supplied |
 * | `profile` | the stream rendered | the twin actually SERVED (`subject.profile` is the one asked for) |
 *
 * Same type, different fact — the shape this repo keeps getting wrong (D385's
 * two authorities, D224's second copy).
 */
export const ExportRecordSchema = z.object({
  id: z.string(),
  deviceId: z.number(),
  profile: z.string(),
  fromMs: z.number(),
  toMs: z.number(),
  /**
   * What this export IS. Optional ONLY for the rows written before D558: the
   * store parses every row through this schema on every read, so a required
   * field would make the export AUDIT — which is the whole reason rows survive
   * file deletion — unreadable in one release. Absence means `footage`, and
   * {@link exportSubjectOf} is the one place that says so.
   */
  subject: ExportSubjectSchema.optional(),
  options: ExportOptionsSchema,
  state: ExportStateSchema,
  /** 0–100 while rendering; null otherwise. */
  progressPct: z.number().nullable(),
  /** File size once ready; null before. */
  fileBytes: z.number().nullable(),
  expiresAt: z.number(),
  deleteAfterDownload: z.boolean(),
  /** Epoch of the first complete download; null until then. */
  downloadedAt: z.number().nullable(),
  createdAt: z.number(),
  /** User id/name that requested the export. */
  createdBy: z.string(),
  /** Failure reason when state is 'failed'; null otherwise. */
  error: z.string().nullable(),
})
export type ExportRecord = z.infer<typeof ExportRecordSchema>

/**
 * Every way a clip export can fail, as a TOKEN — never prose.
 *
 * A branch that accepts work and produces nothing is the branch this repo
 * keeps losing work in (D391), and a clip export has five places to lose it
 * that a recording export does not have. The token is what a surface may key
 * a table on; the PROSE — the camera's own words, the source's verbatim
 * refusal — travels with it, in the same `ExportRecord.error` string, after a
 * `: `. Two separate things in one field because the field is one field:
 * `ClipStillRefusalCodeSchema` split them across two HTTP headers for the same
 * reason, and the surface that keyed on the whole header rendered every
 * refusal on this fleet as `Refused: <prose>`.
 *
 * Compose with {@link clipExportFailure}, read back with
 * {@link clipExportFailureOf}. Never hand-spell the separator.
 */
export const ClipExportFailureSchema = z.enum([
  /** The source no longer lists this clip in the window that was asked. */
  'catalog-miss',
  /** The catalog READ failed. Not an answer, so not "no such clip" (D49). */
  'catalog-unreachable',
  /** The row is listed and has no bytes behind it (`Clip.playable: false`). */
  'no-file-for-window',
  /** Still being written: its `endMs` is a frozen guess, so it has no end to export. */
  'clip-in-progress',
  /** A render option a remux cannot honour (a speed, a timelapse). */
  'unsupported-option',
  /** A standalone battery camera, and no operator wake on the subject. */
  'sleeping',
  /** The camera answered the fetch with a refusal — its words follow. */
  'camera-refused',
  /** The fetch or the mux failed on the producing side. */
  'fetch-failed',
  /** Above {@link RECORDING_EXPORT_MAX_READ_BYTES} — refused, never truncated. */
  'too-large-to-transfer',
  /**
   * The job outlived the wake it was granted. One authorised yes is ONE wake,
   * so a job that waited too long — behind other renders, or across a restart
   * — fails rather than waking the camera a second time on it (D558 § 5.2
   * rule 3).
   */
  'wake-expired',
])
export type ClipExportFailure = z.infer<typeof ClipExportFailureSchema>

/** `<token>: <prose>` — the ONE composition of a clip export's failure string. */
export function clipExportFailure(code: ClipExportFailure, detail: string): string {
  return detail.length > 0 ? `${code}: ${detail}` : code
}

/**
 * The token out of an {@link ExportRecord.error}, or null when the string did
 * not come from {@link clipExportFailure} (every footage failure, and every
 * error thrown by something that never heard of this vocabulary).
 */
export function clipExportFailureOf(error: string | null): ClipExportFailure | null {
  if (error === null) return null
  const head = error.split(':', 1)[0] ?? ''
  const parsed = ClipExportFailureSchema.safeParse(head.trim())
  return parsed.success ? parsed.data : null
}

/** Candidate download URLs (LAN first, then operator extra hosts). */
export const ExportDownloadSchema = z.object({
  url: z.string(),
  endpoints: z.array(z.string()),
})
export type ExportDownload = z.infer<typeof ExportDownloadSchema>

/**
 * Hard ceiling on ONE {@link recordingExportCapability} byte read — 50 MiB.
 *
 * Two independent reasons land on the same number, which is why it is this one
 * and not a rounder guess:
 *
 *  - **Nobody would accept more.** The roomiest byte cap any notifier backend
 *    declares is telegram's 50 MiB, and the degrade engine DROPS an over-cap
 *    attachment outright rather than degrading it to a link. Bytes above this
 *    are read, encoded and moved to be thrown away at the last step.
 *  - **The envelope is unary.** A base64 payload is held whole, ~1.33× its
 *    size, in the provider AND in the caller — on a hub this repo has already
 *    OOM'd once (D9/D18). A bounded on-demand read at human speed is the shape
 *    those records permit; an unbounded one is the shape they forbid.
 *
 * Above it the provider REFUSES with a log line rather than truncating: half a
 * video is worse than a notification that says there is no attachment.
 */
export const RECORDING_EXPORT_MAX_READ_BYTES = 50 * 1024 * 1024

/**
 * A finished export's bytes, inline.
 *
 * `bytes` is the DECODED length — the number the caller bounds and logs
 * against, so nobody has to infer it from the base64 length.
 */
export const ExportBytesSchema = z.object({
  base64: z.string(),
  contentType: z.string(),
  /** Suggested filename, extension included. */
  name: z.string(),
  bytes: z.number().int().nonnegative(),
})
export type ExportBytes = z.infer<typeof ExportBytesSchema>

/** Canonical `profiles[]`, falling back to the legacy singular `profile`. */
export function resolveExportProfiles(input: {
  readonly profile?: string
  readonly profiles?: readonly string[]
}): string[] {
  if (input.profiles !== undefined && input.profiles.length > 0) return [...input.profiles]
  if (typeof input.profile === 'string' && input.profile.length > 0) return [input.profile]
  return []
}

/**
 * `createExport` input — ONE object carrying an optional {@link ExportSubject},
 * never a union of two inputs.
 *
 * It has to be a ZodObject: generated routers call `.input.loose()` so the
 * out-of-band `nodeId` selector survives the wire parse, and `.loose()` is a
 * ZodObject method a `z.discriminatedUnion` does not have. That is why the
 * discriminant sits one level down, in `subject`, and why
 * {@link resolveCreateExportSubject} — not a `z.preprocess` wrapper, which
 * would have produced a schema with no `.loose()` — is the one reading of a
 * legacy flat input as a subject.
 *
 * **`deviceId` stays REQUIRED at the top level**, for both kinds, and a clip
 * subject naming a different one is REFUSED. Not symmetry: `METHOD_DEVICE_SELECTORS`
 * (generated) maps top-level fields and one-level object arrays, so per-device
 * scope enforcement in `scope-access.ts` reads THIS field and cannot see
 * `subject.deviceId`. A deviceId that lived only in the subject would let a
 * principal scoped to one camera create an export — and, on the clip path, a
 * WAKE — for another.
 *
 * **A clip carries no time range**, and one supplied alongside a clip subject
 * is refused rather than ignored: there is no drag on this path and nothing to
 * normalise (D558 § 5.4.3). The record's `fromMs`/`toMs` come from the clip's
 * own `timeRange` and from nowhere else.
 */
export const CreateExportInputSchema = z
  .object({
    deviceId: z.number(),
    /** @deprecated Prefer `profiles`. Kept so timelapse/notifiers keep working. */
    profile: z.string().optional(),
    profiles: z.array(z.string()).min(1).optional(),
    /** Footage only — a clip's boundaries are the camera's. */
    fromMs: z.number().optional(),
    toMs: z.number().optional(),
    /** What to export. Absent means the legacy flat footage request. */
    subject: ExportSubjectSchema.optional(),
    options: ExportOptionsSchema,
  })
  .superRefine((v, ctx) => {
    if (v.subject?.kind === 'clip') {
      if (v.subject.deviceId !== v.deviceId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `subject.deviceId (${v.subject.deviceId}) must equal deviceId (${v.deviceId}) — the top-level field is what per-device scope enforcement reads`,
          path: ['subject', 'deviceId'],
        })
      }
      if (v.fromMs !== undefined || v.toMs !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'a clip export asks for no time range: the camera chose the boundaries and they are read from the catalog row',
          path: ['fromMs'],
        })
      }
      return
    }
    if (v.subject?.kind === 'footage' && v.subject.deviceId !== v.deviceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `subject.deviceId (${v.subject.deviceId}) must equal deviceId (${v.deviceId})`,
        path: ['subject', 'deviceId'],
      })
    }
    const fromMs = v.subject?.kind === 'footage' ? v.subject.fromMs : v.fromMs
    const toMs = v.subject?.kind === 'footage' ? v.subject.toMs : v.toMs
    if (typeof fromMs !== 'number' || typeof toMs !== 'number') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a footage export needs fromMs and toMs',
        path: ['fromMs'],
      })
    }
    const profiles =
      v.subject?.kind === 'footage' ? [...v.subject.profiles] : resolveExportProfiles(v)
    if (profiles.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pass profiles[] (min 1) or legacy profile',
        path: ['profiles'],
      })
    }
  })
export type CreateExportInput = z.infer<typeof CreateExportInputSchema>

/**
 * The ONE reading of a `createExport` input as a {@link ExportSubject}.
 *
 * Every consumer goes through this: a provider that branched on
 * `input.subject !== undefined` in one place and on `input.fromMs` in another
 * would be two authorities on what was asked for, which is how the flat fields
 * and the subject drift apart.
 *
 * Throws on a footage input with no range — an input that parsed cannot reach
 * that, and a caller that skipped the parse gets a named refusal rather than
 * `NaN` boundaries on a durable row.
 */
export function resolveCreateExportSubject(input: CreateExportInput): ExportSubject {
  if (input.subject !== undefined) return input.subject
  const profiles = resolveExportProfiles(input)
  if (typeof input.fromMs !== 'number' || typeof input.toMs !== 'number') {
    throw new Error('recording-export: a footage export needs fromMs and toMs')
  }
  return {
    kind: 'footage',
    deviceId: input.deviceId,
    profiles,
    fromMs: input.fromMs,
    toMs: input.toMs,
  }
}

/**
 * The ONE interpreter of a stored row's subject.
 *
 * `ExportRecord.subject` is optional for exactly one reason — the history rows
 * written before D558 — and "absent means footage, built from the projection"
 * is a statement that must live in one place. Anything that reads
 * `rec.subject` directly and falls back inline is the second authority.
 */
export function exportSubjectOf(rec: ExportRecord): ExportSubject {
  if (rec.subject !== undefined) return rec.subject
  return {
    kind: 'footage',
    deviceId: rec.deviceId,
    profiles: [rec.profile],
    fromMs: rec.fromMs,
    toMs: rec.toMs,
  }
}

export const recordingExportCapability = {
  // Kebab-case, like every other cap name. This was `recordingExport` until
  // 2026-08-12: the camel name made the ctx.api router key (`kebabToCamel`)
  // unrecoverable by the transport's inverse (`toKebab` in `trpc-links.ts`
  // `parsePath`), so every forked-addon call resolved to a cap named
  // `recording-export` that nothing registered. The generated router key is
  // `recordingExport` either way — the tRPC path clients use did not change.
  // Guarded by `scripts/check-cap-name-kebab.ts`.
  name: 'recording-export',
  scope: 'system',
  mode: 'singleton',
  methods: {
    /**
     * Queue an export of {@link ExportSubjectSchema}.
     *
     * `kind:'footage'` — a render of `[fromMs,toMs)` for `deviceId`/`profiles`
     * (legacy flat input, singular `profile` included, still accepted and
     * rewritten). Fails fast when no footage covers the range. One job per
     * profile; **returns the first queued record and the others are reachable
     * only through `listExports`** — a defect named in D558 § 6.3 and the
     * reason a clip subject carries exactly ONE profile.
     *
     * `kind:'clip'` — a finished file the camera holds, validated against the
     * device's clip CATALOG (`videoclips.listClips`, at the subject's
     * `provider`) instead of the recording index, and fetched once by handle
     * under a bound. Its `fromMs`/`toMs` come from the catalog row and from
     * nowhere else; a caller supplying a range is refused.
     *
     * A clip export reuses the six {@link ExportStateSchema} members and adds
     * none: the viewer maps an unknown state string to `failed`, so a seventh
     * member renders every live export — of both kinds — as FAILED on every
     * installed app (D558 § 6.1, pinned by `export-state-members.spec.ts`).
     * `subject.kind` is what tells a surface what `rendering` means.
     */
    createExport: method(CreateExportInputSchema, ExportRecordSchema, {
      role: 'viewer',
      kind: 'mutation',
      auth: 'protected',
    }),
    /** All export rows (history included), optionally scoped to one device. */
    listExports: method(
      z.object({ deviceId: z.number().optional() }),
      z.array(ExportRecordSchema),
      { role: 'viewer', kind: 'query', auth: 'protected' },
    ),
    getExport: method(z.object({ exportId: z.string() }), ExportRecordSchema, {
      role: 'viewer',
      kind: 'query',
      auth: 'protected',
    }),
    /** Abort a queued/rendering export; the partial file is removed. */
    cancelExport: method(z.object({ exportId: z.string() }), ExportRecordSchema, {
      role: 'viewer',
      kind: 'mutation',
      auth: 'protected',
    }),
    /** Remove the file but keep the history row (state → 'deleted'). */
    deleteExport: method(z.object({ exportId: z.string() }), ExportRecordSchema, {
      role: 'viewer',
      kind: 'mutation',
      auth: 'protected',
    }),
    getDownloadUrl: method(z.object({ exportId: z.string() }), ExportDownloadSchema, {
      role: 'viewer',
      kind: 'query',
      auth: 'protected',
    }),
    /**
     * The finished file's BYTES, base64, for a caller that must republish them
     * somewhere a session-less fetcher can reach.
     *
     * `getDownloadUrl` is the right answer for a human: the download route is
     * served `access: 'authenticated'`, which a browser satisfies and a
     * notifier BACKEND does not. It answers a RELATIVE path, so it is not even
     * a URL an outside fetcher could try. This method exists for the one case
     * that needs the other thing — a scheduled timelapse whose video has to
     * become a public attachment on the notification artifact plane.
     *
     * Deliberately narrow: `ready` only (a queued, rendering, failed, expired
     * or deleted export has no file, and answering "0 bytes" for one is how a
     * caller ships an empty attachment), still inside its lifetime, and under
     * {@link RECORDING_EXPORT_MAX_READ_BYTES}. Every refusal throws with the
     * reason — none of them is silent.
     */
    readExportBytes: method(z.object({ exportId: z.string() }), ExportBytesSchema, {
      kind: 'query',
      auth: 'protected',
    }),
  },
} as const satisfies CapabilityDefinition

export type IRecordingExportProvider = InferProvider<typeof recordingExportCapability>
