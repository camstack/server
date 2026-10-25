/**
 * Debug-note archive — the durable corpus of what operators asked to be
 * checked, and the ONE thing about a debug note that outlives its track.
 *
 * D353 bound `debugNote` to the `debug` flag: turning the flag off clears the
 * note in the same statement, so a track can never present a question without
 * the flag that explains it. That invariant is right and stays. Its side
 * effect was not: the act of REVIEWING a debug set destroyed every note in it,
 * and the notes that survived a sweep aged out with their tracks anyway. On
 * 2026-09-08 the notes from one morning's review — 25 to 27 of them — were
 * already unreadable by the afternoon, leaving 11.
 *
 * So the clear now ARCHIVES first (D405). A row here is:
 *
 *  - written ONLY by the hub, from `applyTrackFlags`, immediately before the
 *    note is cleared off the track row;
 *  - keyed by ITS OWN id, derived from `(sourceTrackId, note)` so reviewing
 *    the same track twice cannot double the corpus;
 *  - NOT a track row, NOT subject to track retention, and NOT a durability pin
 *    on anything — the track it names is expected to be gone.
 *
 * `sourceTrackId` is deliberately not called `trackId`. The analytics
 * retention model derives track OWNERSHIP from a declared `trackId` column
 * (`collection-classification.ts`), and a row that the cascade would delete
 * with its track is exactly the row this table exists to keep. The name says
 * PROVENANCE — the same distinction the stationary registry draws for the same
 * reason.
 */
import { z } from 'zod'

/**
 * How many archived notes the cluster keeps, across every camera.
 *
 * GLOBAL, not per-device, and a COUNT, not an age. Both halves are deliberate:
 *
 *  - A per-device bound multiplies by the fleet — 30 cameras at 500 each is
 *    15 000 rows to protect a corpus that only ever gets read fleet-wide (the
 *    thing being mined is "what keeps going wrong", not "what goes wrong on
 *    102"). One global ceiling is one number to reason about.
 *  - An AGE bound would delete the corpus for being old, which is the failure
 *    being fixed: a note from six months ago is the most valuable row in the
 *    table precisely because the pattern it describes has had time to repeat.
 *
 * The number is sized off the measured rate. The 2026-09-08 sweep produced
 * 25–27 notes; call a heavy day 100. 5 000 rows is roughly fifty such days,
 * and at the observed rate (a few sweeps a week) several years. The cost is
 * bounded by construction: a note is capped at `MAX_TRACK_DEBUG_NOTE_LEN`
 * (500 chars) and the metadata beside it is under 100 bytes, so the ceiling is
 * ~3 MB of text and the realistic occupancy is well under 1 MB — against a
 * `tracks` table measured at 4.6 MB for a single 501-row page.
 */
export const MAX_ARCHIVED_DEBUG_NOTES = 5000

/** Default page size for `listArchivedDebugNotes` when the caller omits one. */
export const ARCHIVED_DEBUG_NOTES_DEFAULT_LIMIT = 200

/** One archived note — the operator's words plus enough context to find what
 *  they were looking at, after the track itself is gone. */
export const ArchivedDebugNoteSchema = z.object({
  /** Archive row id. Derived from `(sourceTrackId, note)`, so re-archiving the
   *  same sentence about the same track lands on the row already there. */
  id: z.string(),
  /** The operator's own words, verbatim. */
  note: z.string(),
  /** The camera. Required — every question here is asked per-camera. */
  deviceId: z.number().int(),
  /** The track the note was written on. PROVENANCE, not ownership: the track
   *  is expected to be gone, and this row is not a reference to it. */
  sourceTrackId: z.string(),
  /** Epoch ms the note was moved here, i.e. when the operator reviewed it. */
  archivedAt: z.number().int(),
  /** The track's `firstSeen`, when the row still knew it; `null` otherwise. */
  trackStartedAt: z.number().int().nullable(),
  /** The track's detector class (`person`, `car`, …); `null` when unknown. */
  trackClass: z.string().nullable(),
  /** The track's display label at review time; `null` when it had none. */
  trackLabel: z.string().nullable(),
})
export type ArchivedDebugNote = z.infer<typeof ArchivedDebugNoteSchema>

/** Query input for `listArchivedDebugNotes` — newest first, one camera or all. */
export const ArchivedDebugNoteQueryInputSchema = z.object({
  /** Restrict to a single camera; omit for every row. */
  deviceId: z.number().int().optional(),
  /** Max rows returned, newest-first. */
  limit: z.number().int().min(1).max(1000).optional(),
})
export type ArchivedDebugNoteQueryInput = z.infer<typeof ArchivedDebugNoteQueryInputSchema>
