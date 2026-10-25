/**
 * The catalog reconcile's retract verdict, per stream (D689).
 *
 * A catalog pull is a fallible read of another process, and the retract it
 * drives DESTROYS work — the broker, its restreamer, every recording writer
 * and viewer attached to it. So one pull that omits a stream only MARKS it;
 * the retract needs a later successful pull, at least `confirmMinMs` after the
 * mark, to agree (D49). A stream the pull lists again is unmarked, and a mark
 * whose stream is no longer a candidate (retracted another way, or never the
 * provider's to begin with) is dropped so it cannot turn the next stream under
 * that id into an instant retract.
 *
 * Pure: the caller owns the marks and acts on the verdict. Only a SUCCESSFUL
 * pull is ever judged here — a failed or unanswered one never reaches it.
 */

/** `camStreamId` → wall-clock ms of the pull that first omitted it. */
export type CatalogAbsenceMarks = ReadonlyMap<string, number>

export interface CatalogAbsenceInput {
  /** The marks carried from earlier pulls of this device. */
  readonly marks: CatalogAbsenceMarks
  /** The stream ids this successful, NON-empty pull listed (an answered `[]` never reaches here). */
  readonly listed: ReadonlySet<string>
  /** The provider-declared streams the broker holds — the only ones a pull can retract. */
  readonly candidates: readonly string[]
  readonly nowMs: number
  /** How late the agreeing pull must be, after the mark. */
  readonly confirmMinMs: number
}

export interface CatalogAbsenceRetract {
  readonly camStreamId: string
  readonly absentForMs: number
}

export interface CatalogAbsenceVerdict {
  readonly nextMarks: CatalogAbsenceMarks
  /** Omitted for the first time by this pull. */
  readonly marked: readonly string[]
  /** Listed again after a pull had omitted them. */
  readonly cleared: readonly string[]
  /** Omitted by two pulls at least `confirmMinMs` apart. */
  readonly retract: readonly CatalogAbsenceRetract[]
}

export function judgeCatalogAbsence(input: CatalogAbsenceInput): CatalogAbsenceVerdict {
  const { marks, listed, candidates, nowMs, confirmMinMs } = input
  const nextMarks = new Map<string, number>()
  const marked: string[] = []
  const cleared: string[] = []
  const retract: CatalogAbsenceRetract[] = []
  for (const camStreamId of candidates) {
    const markedAt = marks.get(camStreamId)
    if (listed.has(camStreamId)) {
      if (markedAt !== undefined) cleared.push(camStreamId)
      continue
    }
    if (markedAt === undefined) {
      nextMarks.set(camStreamId, nowMs)
      marked.push(camStreamId)
      continue
    }
    // Two pulls this close — an event-driven pull next to a poll, the startup
    // pass's quick re-runs — are one observation, not two.
    if (nowMs - markedAt < confirmMinMs) {
      nextMarks.set(camStreamId, markedAt)
      continue
    }
    retract.push({ camStreamId, absentForMs: nowMs - markedAt })
  }
  return { nextMarks, marked, cleared, retract }
}
