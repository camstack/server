/**
 * Give every verdict-marked, frame-less retrain track the frame it should have
 * had (D987 procedure).
 *
 * Before the verdict tap copied a frame, an operator's Correct / Wrong answer
 * marked the track and wrote the ledger row, and nothing else: the track sat in
 * retrain staging with `frameCount: 0`, invisible to the screens that read the
 * copied-frames corpus. Two repairs, both over what is stored:
 *
 *  - a ledger row keyed on an id an L2 fusion later ABSORBED is also written
 *    under its survivor (the mark reached the survivor; the verdict did not);
 *  - every staged track that carries a verdict and holds no frame gets the
 *    track's best frame copied, exactly as a fresh tap would.
 *
 * Idempotent by what it reads: a re-keyed row is found under its survivor, a
 * track with a copy is no longer frame-less, so a rerun finds nothing and
 * reports `already-done`. A track whose media is gone is skipped with one log
 * line and stays staged, as it was.
 */
import type { IScopedLogger, MigrationProcedureResult } from '@camstack/types'
import type { NcDetectionVerdictRecord } from '../notification-center/detection-verdict-ledger.js'

/** A staged retrain track, as far as this migration needs to know it. */
export interface StagedRetrainTrack {
  readonly deviceId: number
  readonly trackId: string
  readonly frameCount: number
}

/** The world this migration reads and writes. */
export interface RetrainVerdictFramePorts {
  readonly verdicts: {
    all(): Promise<readonly NcDetectionVerdictRecord[]>
    record(row: NcDetectionVerdictRecord): Promise<void>
  }
  /** L2 fusion: the survivor an absorbed id lives on, or `null`. */
  readonly resolveTrackAlias: (trackId: string) => Promise<string | null>
  readonly listStagedTracks: () => Promise<readonly StagedRetrainTrack[]>
  /** Copy the track's best frame; never throws, answers a named reason when it cannot. */
  readonly copyBestFrame: (input: {
    readonly deviceId: number
    readonly trackId: string
  }) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>
  readonly logger: IScopedLogger
}

export async function backfillRetrainVerdictFrames(
  ports: RetrainVerdictFramePorts,
): Promise<MigrationProcedureResult> {
  const rows = await ports.verdicts.all()
  const answered = new Set(rows.map((row) => row.trackId))
  let rekeyed = 0
  for (const row of rows) {
    const survivor = await ports.resolveTrackAlias(row.trackId)
    if (survivor === null || survivor === row.trackId || answered.has(survivor)) continue
    await ports.verdicts.record({ ...row, trackId: survivor })
    answered.add(survivor)
    rekeyed += 1
  }
  const staged = await ports.listStagedTracks()
  let copied = 0
  let skipped = 0
  for (const track of staged) {
    if (track.frameCount > 0 || !answered.has(track.trackId)) continue
    const result = await ports.copyBestFrame({ deviceId: track.deviceId, trackId: track.trackId })
    if (result.ok) {
      copied += 1
      continue
    }
    skipped += 1
    ports.logger.warn('retrain verdict backfill — no frame could be copied, the track stays staged', {
      tags: { deviceId: track.deviceId },
      meta: { trackId: track.trackId, reason: result.reason },
    })
  }
  return {
    outcome: rekeyed + copied === 0 ? 'already-done' : 'done',
    summary: { rekeyed, copied, skipped },
  }
}
