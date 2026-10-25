/**
 * archive-debug-note — the half of the review that KEEPS the operator's words.
 *
 * D353 gave the hub one invariant: a patch carrying `debug: false` clears
 * `debugNote` in the same statement, so no surface can ever show a question
 * without the flag that explains it. That half is right and is untouched here.
 *
 * The other half — that the clear was a DELETE — is what D405 supersedes. The
 * viewer's "Analizzata" button sends exactly `debug: false`, so finishing a
 * review destroyed every note written during it: on 2026-09-08 the 25–27 notes
 * from the morning sweep were already gone by the afternoon, and the only ones
 * readable were the 11 marks still open. The corpus this product needs in order
 * to learn what keeps going wrong was being erased by the act of reviewing it.
 *
 * So the note is APPENDED to a durable archive first, and only then cleared.
 * This file is the boundary between the two: the port the archive implements,
 * and the ONE guarded call that decides what happens when it fails.
 */

import type { IScopedLogger } from '@camstack/types'
import type { ResolvedTrackFlags } from './track-flags.js'

/** What the archive is told about one note being retired. */
export interface DebugNoteArchiveAppendInput {
  readonly deviceId: number
  /** The track the note was written on. PROVENANCE, not ownership — see
   *  `ArchivedDebugNoteSchema`: the archive outlives the track. */
  readonly sourceTrackId: string
  readonly note: string
  /** Context the track row still knew, omitted when it did not. */
  readonly trackStartedAt?: number
  readonly trackClass?: string
  readonly trackLabel?: string
}

/** What the archive reports back: whether a NEW row landed, and its id. */
export interface DebugNoteArchiveAppendResult {
  /** `false` for an empty note and for a `(track, note)` pair already held —
   *  both are "nothing new", never a failure. */
  readonly archived: boolean
  readonly id: string | null
}

/**
 * The archive as `applyTrackFlags` sees it — one method.
 *
 * A PORT rather than the store class, because the flag body must stay decidable
 * from its own contract (the reason `track-flags.ts` was extracted at all), and
 * because a runner without an archive must still be able to write flags.
 */
export interface DebugNoteArchivePort {
  readonly append: (input: DebugNoteArchiveAppendInput) => Promise<DebugNoteArchiveAppendResult>
}

export interface ArchiveNoteBeforeClearInput {
  readonly deviceId: number
  readonly trackId: string
  readonly logger: IScopedLogger
  readonly archive: DebugNoteArchivePort | undefined
  readonly current: ResolvedTrackFlags
}

/**
 * Archive the note a clear is about to destroy. Never throws.
 *
 * **Which way this fails, stated once.** The operator pressed a flag button;
 * the archive is this system's own bookkeeping. So a failing archive does NOT
 * block the flag write — the button must do what it says even when SQLite is
 * busy — and it does NOT retry, because the caller is a synchronous cap method
 * an operator is waiting on.
 *
 * What it must never do is lose the sentence quietly. The failure line carries
 * the NOTE TEXT verbatim, plus `tags: { deviceId }` and the trackId, so the
 * words are recoverable from the log by hand and the loss is attributable to
 * one camera. A branch that drops work silently reads as "never happened", and
 * the 3-hour media blackout produced not one line.
 *
 * An EMPTY note archives nothing: there is nothing to keep, and a row of `''`
 * would be a permanent entry in a corpus meant to be mined for sentences.
 */
export async function archiveNoteBeforeClear(input: ArchiveNoteBeforeClearInput): Promise<void> {
  const note = input.current.debugNote
  if (note.trim() === '') return
  if (input.archive === undefined) {
    input.logger.warn('debug note dropped — no archive is wired on this runner', {
      tags: { deviceId: input.deviceId },
      meta: { deviceId: input.deviceId, trackId: input.trackId, note },
    })
    return
  }
  try {
    await input.archive.append({
      deviceId: input.deviceId,
      sourceTrackId: input.trackId,
      note,
      ...(input.current.startedAt !== undefined ? { trackStartedAt: input.current.startedAt } : {}),
      ...(input.current.className !== undefined ? { trackClass: input.current.className } : {}),
      ...(input.current.label !== undefined ? { trackLabel: input.current.label } : {}),
    })
  } catch (err) {
    input.logger.error('failed to archive a debug note — the text is in this line', {
      tags: { deviceId: input.deviceId },
      meta: {
        deviceId: input.deviceId,
        trackId: input.trackId,
        note,
        error: err instanceof Error ? err.message : String(err),
      },
    })
  }
}
