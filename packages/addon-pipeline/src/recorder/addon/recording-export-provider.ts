/**
 * `recording-export` cap provider — the thin façade the recorder registers on the
 * designated recording node. It validates a requested range against the local
 * recording index (fail-fast when no footage covers it), persists a `queued`
 * {@link ExportRecord} in the DurableState store, and hands the id to the
 * {@link ExportEngine} for rendering. Reads/list/cancel/delete/download-url all
 * flow through the store + engine; the actual ffmpeg work and retention live in
 * `export-engine.ts` / `export-janitor.ts`.
 *
 * Every side-effecting dependency (clock, id generator, file remove, download
 * url formatting, the index lookup) is injected so the provider is unit-testable
 * without disk, an addon context, or a real engine.
 */
import type {
  ExportBytes,
  ExportClipSubject,
  ExportOptions,
  ExportRecord,
  IRecordingExportProvider,
  IScopedLogger,
} from '@camstack/types'
import {
  clipExportFailure,
  RECORDING_EXPORT_MAX_READ_BYTES,
  resolveCreateExportSubject,
} from '@camstack/types'
import {
  EXPORT_CLIP_CATALOG_LIMIT,
  type ExportClipCatalog,
  judgeClipRow,
} from './export-clip-catalog.js'
import {
  getExportRecord,
  listExportsFor,
  patchExport,
  upsertExport,
  type RecordingExportsState,
} from './export-store.js'
import { userError } from '@camstack/types'

/** Minimal engine surface the provider drives (satisfied by {@link ExportEngine}). */
export interface ExportEngineHandle {
  /** Queue a persisted `queued` record for rendering. */
  enqueue(id: string): void
  /** Abort a queued or in-flight render. */
  cancel(id: string): void | Promise<void>
}

/** One indexed segment, reduced to the fields the range-overlap check needs. */
export interface ExportIndexSegment {
  readonly startMs: number
  readonly durMs: number
}

/**
 * Minimal recording-index surface: segments for a (device, profile) pair
 * **within a window that has been hydrated first**.
 *
 * The hydration is not optional and not the caller's business to remember.
 * `RecordingIndex` is populated per hour off disk; after a restart the
 * archive-wide walk takes minutes, and until it reaches an hour that hour reads
 * EMPTY over footage that is on disk. `collectRangeSegments` — what the export
 * RENDERER goes through — hydrates the window before it reads, and says so:
 * *"The skip lives HERE, at the read site, not only inside the walker."* The
 * fail-fast gate used to read the raw index instead, so a freshly restarted
 * recorder refused every export of a window it had not yet walked.
 *
 * Making the window part of the signature is what stops that from coming back:
 * there is no way to ask this interface a question that skips the hydrate.
 */
export interface ExportRecordingIndex {
  segmentsInWindow(
    deviceId: number,
    profile: string,
    fromMs: number,
    toMs: number,
  ): Promise<readonly ExportIndexSegment[]>
}

export interface RecordingExportProviderDeps {
  readonly state: RecordingExportsState
  readonly engine: ExportEngineHandle
  /** Recording index used to fail-fast when no footage covers the range. */
  readonly index: ExportRecordingIndex
  /**
   * Clip catalog used to fail-fast on a `kind:'clip'` subject — the recording
   * index cannot answer for bytes the recorder never wrote (D558 § 2.1).
   */
  readonly clipCatalog: ExportClipCatalog
  /** Wall-clock now (ms). Injected for deterministic tests. */
  readonly now: () => number
  /** Unique export id generator. */
  readonly newId: () => string
  /** Resolves the requesting principal for the audit row. */
  readonly createdBy: () => string
  /** Absolute output path for a record's MP4 (for delete). */
  readonly outPath: (rec: ExportRecord) => string
  /** Remove a (possibly absent) file; must not throw on ENOENT. */
  readonly removeFile: (path: string) => Promise<void>
  /** Client download URL through the hub data-plane for an export id. */
  readonly downloadUrlFor: (exportId: string) => string
  /**
   * Size of a rendered file, in bytes. THROWS when the file is not there —
   * which is the point: it is how `readExportBytes` learns the size before
   * committing to the read, and how it learns the file is gone.
   */
  readonly statBytes: (path: string) => Promise<number>
  /** Read a rendered file whole. Only ever called under the size bound. */
  readonly readFile: (path: string) => Promise<Buffer>
  /**
   * Re-encode `path` so the returned buffer is ≤ `maxBytes`. Absent or `null`
   * ⇒ the oversized read is refused (the historical behaviour). The original
   * file is never replaced — the authenticated download still serves it.
   */
  readonly shrinkToBound?: (path: string, maxBytes: number) => Promise<Buffer | null>
  readonly logger: Pick<IScopedLogger, 'info' | 'warn' | 'debug'>
}

/** Content type of every rendered export — the engine only ever writes MP4. */
const EXPORT_CONTENT_TYPE = 'video/mp4'
/** Filename bound, extension included. Long enough to stay recognisable. */
const EXPORT_NAME_MAX = 64

/**
 * The filename a RECIPIENT sees on the attachment.
 *
 * Derived from the operator's own export title so a delivered video is
 * identifiable in a chat thread, but slugified and BOUNDED: the title field
 * accepts 200 characters and several notifier backends silently mangle a
 * filename that long. No usable title degrades to the export id, never to an
 * empty name.
 */
export function exportFileName(rec: { readonly id: string; readonly title?: string }): string {
  const slug = (rec.title ?? '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, EXPORT_NAME_MAX - '.mp4'.length)
    .replace(/-+$/g, '')
  return slug.length > 0 ? `${slug}.mp4` : `export-${rec.id}.mp4`
}

/**
 * True when at least one indexed segment overlaps `[fromMs, toMs)`. Mirrors the
 * `buildPlaybackManifest` overlap idiom: a segment `[startMs, startMs+durMs)`
 * overlaps the window iff it starts before the window ends AND ends after the
 * window starts.
 */
async function hasFootage(
  index: ExportRecordingIndex,
  deviceId: number,
  profile: string,
  fromMs: number,
  toMs: number,
): Promise<boolean> {
  const segments = await index.segmentsInWindow(deviceId, profile, fromMs, toMs)
  return segments.some((s) => s.startMs < toMs && s.startMs + s.durMs > fromMs)
}

/** Load a record or throw a clear NOT_FOUND-style error. */
async function requireRecord(
  state: RecordingExportsState,
  exportId: string,
): Promise<ExportRecord> {
  const rec = await getExportRecord(state, exportId)
  if (!rec)
    throw userError(
      'recording.export-unknown',
      { id: exportId },
      `recording-export: unknown export "${exportId}"`,
    )
  return rec
}

/** Build the `recordingExport` provider over the injected deps. */
export function buildRecordingExportProvider(
  deps: RecordingExportProviderDeps,
): IRecordingExportProvider {
  /**
   * Persist one `queued` row and hand it to the engine. The ONE place a record
   * is born, for both kinds — so the fields nothing about the subject decides
   * (the lifetime, the audit stamp, the null progress) cannot drift apart.
   */
  const queueOne = async (
    fields: Pick<ExportRecord, 'deviceId' | 'profile' | 'fromMs' | 'toMs' | 'subject'>,
    options: ExportOptions,
    now: number,
  ): Promise<ExportRecord> => {
    const saved = await upsertExport(deps.state, {
      ...fields,
      id: deps.newId(),
      options,
      state: 'queued',
      progressPct: null,
      fileBytes: null,
      expiresAt: now + options.maxLifeMs,
      deleteAfterDownload: options.deleteAfterDownload,
      downloadedAt: null,
      createdAt: now,
      createdBy: deps.createdBy(),
      error: null,
    })
    deps.engine.enqueue(saved.id)
    return saved
  }

  /**
   * The clip branch's fail-fast gate — the catalog, never the recording index.
   *
   * Refuses BEFORE a row exists, so an operator gets the reason in the answer
   * to his own tap instead of discovering it on a `failed` row a minute later,
   * and so a refusal never spends a wake.
   */
  const createClipExport = async (
    subject: ExportClipSubject,
    options: ExportOptions,
  ): Promise<ExportRecord> => {
    const tags = { deviceId: subject.deviceId }
    // Nothing on this path is re-timed: the file is fetched and remuxed, so a
    // speed or a timelapse is not "ignored", it is REFUSED. Silently dropping
    // one would leave the record claiming a variant for its whole life, and
    // the modal rendering "Real time (1×)" for a file nobody timed.
    if (options.timelapse !== undefined || (options.speed !== undefined && options.speed !== 1)) {
      const detail = 'a clip is remuxed, never re-timed — drop speed/timelapse'
      deps.logger.warn('clip export refused: a render option a remux cannot honour', {
        tags,
        meta: { clipId: subject.clipId, speed: options.speed, timelapse: options.timelapse },
      })
      throw new Error(clipExportFailure('unsupported-option', detail))
    }
    let rows: readonly Awaited<ReturnType<ExportClipCatalog['listClips']>>[number][]
    try {
      rows = await deps.clipCatalog.listClips({
        deviceId: subject.deviceId,
        since: subject.catalogWindow.sinceMs,
        until: subject.catalogWindow.untilMs,
        provider: subject.provider,
        limit: EXPORT_CLIP_CATALOG_LIMIT,
      })
    } catch (err: unknown) {
      // A read that FAILED is not an empty answer (D49). "This clip is gone"
      // and "we could not look" are different facts and the operator acts on
      // them differently.
      const detail = err instanceof Error ? err.message : String(err)
      deps.logger.warn('clip export refused: the clip catalog could not be read', {
        tags,
        meta: { clipId: subject.clipId, provider: subject.provider, error: detail },
      })
      throw new Error(clipExportFailure('catalog-unreachable', detail), { cause: err })
    }
    const outcome = judgeClipRow(subject, rows)
    if (!outcome.ok) {
      deps.logger.warn('clip export refused by the catalog gate', {
        tags,
        meta: {
          clipId: subject.clipId,
          provider: subject.provider,
          reason: outcome.refusal.code,
          detail: outcome.refusal.detail,
        },
      })
      throw new Error(clipExportFailure(outcome.refusal.code, outcome.refusal.detail))
    }
    const { clip, served } = outcome.accepted
    const record = await queueOne(
      {
        deviceId: subject.deviceId,
        // The PROJECTION: the camera's own boundaries, and the twin the row
        // says will be served. `subject.profile` keeps the ask.
        profile: served,
        fromMs: clip.timeRange.startMs,
        toMs: clip.timeRange.endMs,
        subject,
      },
      options,
      deps.now(),
    )
    deps.logger.info('clip export queued', {
      tags,
      meta: {
        exportId: record.id,
        clipId: subject.clipId,
        source: subject.source,
        provider: subject.provider,
        askedProfile: subject.profile,
        servedProfile: served,
        wake: subject.wake ?? 'none',
        fromMs: record.fromMs,
        toMs: record.toMs,
      },
    })
    return record
  }

  return {
    createExport: async (input): Promise<ExportRecord> => {
      const subject = resolveCreateExportSubject(input)
      if (subject.kind === 'clip') return await createClipExport(subject, input.options)

      const { deviceId, profiles, fromMs, toMs } = subject
      const { options } = input
      if (!(fromMs < toMs)) {
        throw userError(
          'recording.export-invalid-range',
          { fromMs, toMs },
          `recording-export: invalid range ${fromMs}..${toMs}`,
        )
      }
      for (const profile of profiles) {
        if (!(await hasFootage(deps.index, deviceId, profile, fromMs, toMs))) {
          throw new Error(
            `recording-export: no footage for ${deviceId}/${profile} in ${fromMs}..${toMs}`,
          )
        }
      }
      const now = deps.now()
      // One job per profile, and only the FIRST id comes back — a caller that
      // asked for two twins cannot reach the second except through
      // `listExports` (D558 § 6.3). Left as it is, deliberately: changing the
      // return shape is a wire break for every existing caller. What is fixed
      // is the `as ExportRecord` cast that used to express the non-null — the
      // loop now yields it structurally, so the guarantee is the compiler's.
      const [head, ...rest] = profiles
      if (head === undefined) {
        throw userError(
          'recording.export-no-profiles',
          undefined,
          'recording-export: profiles must contain at least one profile',
        )
      }
      const first = await queueOne({ deviceId, profile: head, fromMs, toMs, subject }, options, now)
      for (const profile of rest) {
        await queueOne({ deviceId, profile, fromMs, toMs, subject }, options, now)
      }
      return first
    },

    listExports: ({ deviceId }): Promise<ExportRecord[]> => listExportsFor(deps.state, deviceId),

    getExport: ({ exportId }): Promise<ExportRecord> => requireRecord(deps.state, exportId),

    cancelExport: async ({ exportId }): Promise<ExportRecord> => {
      const existing = await requireRecord(deps.state, exportId)
      await deps.engine.cancel(exportId)
      // The engine's finalize flips state asynchronously; return the freshest row
      // we can read (falling back to the pre-cancel snapshot).
      return (await getExportRecord(deps.state, exportId)) ?? existing
    },

    deleteExport: async ({ exportId }): Promise<ExportRecord> => {
      const existing = await requireRecord(deps.state, exportId)
      await deps.removeFile(deps.outPath(existing))
      const patched = await patchExport(deps.state, exportId, {
        state: 'deleted',
        fileBytes: null,
      })
      return patched ?? existing
    },

    getDownloadUrl: async ({ exportId }): Promise<{ url: string; endpoints: string[] }> => {
      await requireRecord(deps.state, exportId)
      const url = deps.downloadUrlFor(exportId)
      return { url, endpoints: [url] }
    },

    readExportBytes: async ({ exportId }): Promise<ExportBytes> => {
      const rec = await requireRecord(deps.state, exportId)
      const tags = { deviceId: rec.deviceId }
      // The CHEAP questions first, in the order that costs least: the row, then
      // the clock, then one stat — and only then the bytes. Every refusal is
      // logged before it is thrown, because a caller sees the message and the
      // OPERATOR of this node sees only the log.
      if (rec.state !== 'ready') {
        deps.logger.warn('export byte read refused: export is not ready', {
          tags,
          meta: { exportId, state: rec.state },
        })
        throw userError(
          'recording.export-not-ready',
          { id: exportId, state: rec.state },
          `recording-export: export "${exportId}" is not ready (${rec.state})`,
        )
      }
      if (deps.now() >= rec.expiresAt) {
        // The janitor sweeps on its own schedule, so `state: 'ready'` on a row
        // past its expiry is an ordinary race, not a corruption — and serving
        // the file anyway would let a link outlive the retention the operator
        // set.
        deps.logger.warn('export byte read refused: export has expired', {
          tags,
          meta: { exportId, expiresAt: rec.expiresAt },
        })
        throw userError(
          'recording.export-expired',
          { id: exportId },
          `recording-export: export "${exportId}" has expired`,
        )
      }
      const file = deps.outPath(rec)
      let size: number
      try {
        size = await deps.statBytes(file)
      } catch (err: unknown) {
        deps.logger.warn('export byte read refused: file is missing', {
          tags,
          meta: { exportId, error: String(err) },
        })
        throw Object.assign(
          userError(
            'recording.export-no-file',
            { id: exportId },
            `recording-export: export "${exportId}" has no file on disk`,
          ),
          { cause: err },
        )
      }
      if (size > RECORDING_EXPORT_MAX_READ_BYTES) {
        const shrink = deps.shrinkToBound
        if (shrink !== undefined) {
          deps.logger.info('export byte read: shrinking oversized file for inline delivery', {
            tags,
            meta: { exportId, bytes: size, maxBytes: RECORDING_EXPORT_MAX_READ_BYTES },
          })
          const shrunk = await shrink(file, RECORDING_EXPORT_MAX_READ_BYTES)
          if (shrunk !== null && shrunk.byteLength <= RECORDING_EXPORT_MAX_READ_BYTES) {
            deps.logger.info('export byte read: shrink fitted under the inline ceiling', {
              tags,
              meta: {
                exportId,
                originalBytes: size,
                bytes: shrunk.byteLength,
                maxBytes: RECORDING_EXPORT_MAX_READ_BYTES,
              },
            })
            return {
              base64: shrunk.toString('base64'),
              contentType: EXPORT_CONTENT_TYPE,
              name: exportFileName({
                id: rec.id,
                ...(rec.options.title !== undefined ? { title: rec.options.title } : {}),
              }),
              bytes: shrunk.byteLength,
            }
          }
          deps.logger.warn('export byte read: shrink could not fit under the inline ceiling', {
            tags,
            meta: {
              exportId,
              originalBytes: size,
              shrunkBytes: shrunk?.byteLength ?? null,
              maxBytes: RECORDING_EXPORT_MAX_READ_BYTES,
            },
          })
        }
        deps.logger.warn('export byte read refused: file is too large to inline', {
          tags,
          meta: { exportId, bytes: size, maxBytes: RECORDING_EXPORT_MAX_READ_BYTES },
        })
        throw new Error(
          `recording-export: export "${exportId}" is too large to read inline ` +
            `(${size} > ${RECORDING_EXPORT_MAX_READ_BYTES} bytes)`,
        )
      }
      const bytes = await deps.readFile(file)
      return {
        base64: bytes.toString('base64'),
        contentType: EXPORT_CONTENT_TYPE,
        name: exportFileName({
          id: rec.id,
          ...(rec.options.title !== undefined ? { title: rec.options.title } : {}),
        }),
        bytes: bytes.byteLength,
      }
    },
  }
}
