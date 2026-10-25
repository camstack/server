/**
 * The clip CATALOG, as the export provider needs it — and the pure decisions
 * it makes about one row.
 *
 * A clip export's fail-fast gate is not the recording index: the recorder did
 * not write those bytes and has no segment for them. It is the question
 * *"does this source still list this clip, and may we have it"*, asked of the
 * ONE provider the subject names (D558 § 2.1).
 *
 * The cheap question comes first (D54): everything here runs BEFORE any byte
 * is fetched, any camera session is opened and any wake is spent.
 */
import type { Clip, ClipExportFailure, ExportClipSubject } from '@camstack/types'

/**
 * The slice of `videoclips` this gate reads. Narrower than the cap on purpose:
 * nothing here may fetch bytes, and the byte read is a separate dep on the
 * ENGINE, reached only after this gate says yes.
 */
export interface ExportClipCatalog {
  listClips(input: {
    readonly deviceId: number
    readonly since: number
    readonly until: number
    readonly provider: string
    readonly limit?: number
  }): Promise<readonly Clip[]>
}

/**
 * Catalog page size for the confirm.
 *
 * One local day is the window (`ExportClipSubject.catalogWindow`) and a busy
 * day on 592 measured 546 rows, so 1 000 holds a day with room and still
 * bounds a pathological camera. A truncated page would read as "this clip is
 * gone", which is the one answer this gate must never give wrongly.
 */
export const EXPORT_CLIP_CATALOG_LIMIT = 1_000

/** A refusal this gate raises: the token plus the words that explain it. */
export interface ClipGateRefusal {
  readonly code: ClipExportFailure
  readonly detail: string
}

/** The gate's answer: the confirmed row and the twin that will be served. */
export interface ClipGateAccepted {
  readonly clip: Clip
  /** What the operator will actually get, decided from the row's own twins. */
  readonly served: 'high' | 'mid' | 'low'
}

export type ClipGateOutcome =
  | { readonly ok: true; readonly accepted: ClipGateAccepted }
  | { readonly ok: false; readonly refusal: ClipGateRefusal }

/**
 * Which twin this row can actually serve for the asked profile.
 *
 * The mapping is the one D549 15 already fixed — `low | mid` → the sub file,
 * `high` → the main twin — and both ids are resolved at LISTING time, so this
 * never re-searches the camera. A row that holds only one twin answers with
 * the one it has and the caller SAYS so: the ask stays on `subject.profile`
 * and this lands on the record's top-level `profile`, so a week later the row
 * still tells the operator he was handed the sub stream.
 *
 * A row with no `streams` block at all is not a fallback and not a guess: the
 * ask is carried through and the producer's own `served` is what corrects it.
 */
export function servedTwinFor(clip: Clip, asked: 'high' | 'mid' | 'low'): 'high' | 'mid' | 'low' {
  const streams = clip.streams
  if (streams === undefined) return asked
  const hasMain = streams.main !== undefined
  const hasSub = streams.sub !== undefined
  if (asked === 'high') return hasMain ? 'high' : hasSub ? 'low' : asked
  return hasSub ? asked : hasMain ? 'high' : asked
}

/**
 * Judge one catalog answer for one clip subject. Pure — the I/O is the
 * caller's, so every refusal below is unit-testable without a camera.
 */
export function judgeClipRow(subject: ExportClipSubject, rows: readonly Clip[]): ClipGateOutcome {
  const clip = rows.find((row) => row.id === subject.clipId)
  if (clip === undefined) {
    return {
      ok: false,
      refusal: {
        code: 'catalog-miss',
        detail:
          `"${subject.sourceLabel}" does not list ${subject.clipId} between ` +
          `${subject.catalogWindow.sinceMs} and ${subject.catalogWindow.untilMs}`,
      },
    }
  }
  if (clip.playable === false) {
    // The row exists and has nothing behind it — the measured case is an event
    // that fell inside no file (1 of 29 hub events on 3628). The source's own
    // words travel verbatim; we do not re-word them.
    return {
      ok: false,
      refusal: { code: 'no-file-for-window', detail: clip.unplayableReason ?? 'no bytes' },
    }
  }
  if (clip.inProgress === true) {
    // `endMs` is not this clip's end and the source says so. Exporting it
    // would project a duration nobody knows onto a durable row, and D568's
    // completion rule — prove the decoded duration against the catalog span —
    // would have nothing true to prove itself against.
    return {
      ok: false,
      refusal: {
        code: 'clip-in-progress',
        detail: 'the camera is still writing this recording, so it has no end to export yet',
      },
    }
  }
  const { startMs, endMs } = clip.timeRange
  if (!(startMs < endMs)) {
    return {
      ok: false,
      refusal: {
        code: 'catalog-miss',
        detail: `the row carries no usable span (${startMs}..${endMs})`,
      },
    }
  }
  return { ok: true, accepted: { clip, served: servedTwinFor(clip, subject.profile) } }
}
