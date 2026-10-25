/**
 * Where the automatic face rescore remembers its last COMPLETED run (D866):
 * the fingerprint it ran under and the report it produced.
 *
 * One KV row, written once per completed run (manual or scheduled). The
 * fingerprint is what makes the hourly job free when nothing changed; the
 * report is what the operator reads in the status call after a respawn.
 *
 * Losing the row costs one extra run (the next tick sees "no previous
 * fingerprint" and rescores) — never a wrong suggestion, because a rescore is
 * idempotent over an unchanged gallery.
 */
import type { IScopedLogger, RecordKindHandle, RecordsAccess } from '@camstack/types'
import {
  type FaceRescoreJobStatus,
  FaceRescoreJobStatusSchema,
} from '../face-rescore-job-status.js'
import { type FaceRescoreStateBody, pipelineAnalyticsRecordKinds } from '../record-kinds.js'

/** Legacy collection name — kept for the classification, the adoption mapper and docs. */
export const FACE_RESCORE_STATE_COLLECTION = 'pipeline-analytics:face-rescore-state'

const STATE_KEY = 'last-run'

export interface FaceRescoreRunState {
  /** Combined fingerprint taken at the START of the completed run. */
  readonly fingerprint: string
  readonly finishedAt: number
  readonly report: FaceRescoreJobStatus
}

/** The seam the scheduler reads/writes through, so its specs need no store. */
export interface FaceRescoreStatePort {
  readonly load: () => Promise<FaceRescoreRunState | null>
  readonly save: (state: FaceRescoreRunState) => Promise<void>
}

export class FaceRescoreStateStore implements FaceRescoreStatePort {
  constructor(
    private readonly deps: {
      readonly kind: RecordKindHandle<FaceRescoreStateBody>
      readonly logger: IScopedLogger
    },
  ) {}

  static of(records: Pick<RecordsAccess, 'kind'>, logger: IScopedLogger): FaceRescoreStateStore {
    return new FaceRescoreStateStore({
      kind: records.kind(pipelineAnalyticsRecordKinds['face-rescore-state']),
      logger,
    })
  }

  /** `null` on no row OR an unreadable one: either way the next tick reruns. */
  readonly load = async (): Promise<FaceRescoreRunState | null> => {
    try {
      const row = await this.deps.kind.get(STATE_KEY)
      return decodeRunState(row?.data ?? null)
    } catch (err) {
      this.deps.logger.warn('face rescore state unreadable — treating as never run', {
        meta: { error: String(err) },
      })
      return null
    }
  }

  /** THROWS: a state that did not land must be visible to the caller. */
  readonly save = async (state: FaceRescoreRunState): Promise<void> => {
    await this.deps.kind.put({
      id: STATE_KEY,
      data: {
        fingerprint: state.fingerprint,
        finishedAt: state.finishedAt,
        report: state.report,
      },
    })
  }
}

/** Narrow a stored row; anything malformed is "no previous run". */
function decodeRunState(value: unknown): FaceRescoreRunState | null {
  if (value === null || typeof value !== 'object') return null
  const row: Record<string, unknown> = { ...value }
  const fingerprint = row['fingerprint']
  const finishedAt = row['finishedAt']
  const report = row['report']
  if (typeof fingerprint !== 'string' || fingerprint === '') return null
  if (typeof finishedAt !== 'number') return null
  const parsed = FaceRescoreJobStatusSchema.safeParse(report)
  return parsed.success ? { fingerprint, finishedAt, report: parsed.data } : null
}
