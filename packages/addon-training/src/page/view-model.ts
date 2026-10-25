/**
 * The Training page's view-model: pure functions from the orchestrator's job
 * and result records to what the page draws. No React, no tRPC — every rule
 * the page shows lives here so it can be tested.
 */
import type {
  TrainingEvalClass,
  TrainingEvalReport,
  TrainingJob,
  TrainingJobState,
  TrainingResult,
} from '@camstack/types'

/** The happy path, in order. Terminal side states are drawn as a failure marker. */
export const TIMELINE: readonly TrainingJobState[] = [
  'uploading',
  'submitted',
  'starting',
  'running',
  'collecting',
  'ready',
  'registered',
  'canary',
]

const JOB_STATES: Readonly<Record<TrainingJobState, true>> = {
  queued: true,
  uploading: true,
  submitted: true,
  starting: true,
  running: true,
  collecting: true,
  ready: true,
  registered: true,
  canary: true,
  failed: true,
  cancelling: true,
  cancelled: true,
  lost: true,
  expired: true,
  discarded: true,
}

/** Narrow a facet value (a string) to a job state. */
export function isJobState(value: string): value is TrainingJobState {
  return Object.hasOwn(JOB_STATES, value)
}

const SETTLED: ReadonlySet<TrainingJobState> = new Set([
  'ready',
  'registered',
  'canary',
  'failed',
  'cancelled',
  'lost',
  'expired',
  'discarded',
])

export type StepStatus = 'done' | 'current' | 'failed' | 'todo'

export interface TimelineStep {
  readonly state: TrainingJobState
  readonly status: StepStatus
}

export function isSettled(state: TrainingJobState): boolean {
  return SETTLED.has(state)
}

/** Poll while any job can still move on its own. */
export function shouldPoll(jobs: readonly TrainingJob[]): boolean {
  return jobs.some((j) => !isSettled(j.state))
}

/** Where on the happy path an off-path state (failed, cancelled, lost) happened. */
function reachedIndex(job: TrainingJob): number {
  const own = TIMELINE.indexOf(job.state)
  if (own >= 0) return own
  if (job.artifacts !== null || job.registeredModelIds.length > 0) return TIMELINE.indexOf('ready')
  switch (job.provider.state) {
    case 'succeeded':
      return TIMELINE.indexOf('collecting')
    case 'running':
    case 'failed':
    case 'cancelled':
      return TIMELINE.indexOf('running')
    case 'starting':
      return TIMELINE.indexOf('starting')
    case 'pending':
      return TIMELINE.indexOf('submitted')
    default:
      return 0
  }
}

export function timelineSteps(job: TrainingJob): readonly TimelineStep[] {
  if (job.state === 'queued') {
    return TIMELINE.map((state) => ({
      state,
      status: 'todo' as const,
    }))
  }
  const offPath = !TIMELINE.includes(job.state)
  const at = reachedIndex(job)
  return TIMELINE.map((state, i) => {
    let status: StepStatus = 'todo'
    if (i < at) status = 'done'
    else if (i === at) status = offPath && job.state !== 'expired' ? 'failed' : 'current'
    return { state, status }
  })
}

export function formatCost(usd: number, estimate: boolean): string {
  const text = `$${usd.toFixed(2)}`
  return estimate ? `≈ ${text}` : text
}

export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec))
  if (s < 60) return `${String(s)} s`
  if (s < 3600) return `${String(Math.floor(s / 60))} min ${String(s % 60)} s`
  return `${String(Math.floor(s / 3600))} h ${String(Math.floor((s % 3600) / 60))} min`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function formatPct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
}

/** Seconds the job has run (or ran), from the provider's start. */
export function elapsedSec(job: TrainingJob, now: number): number | null {
  const start = job.provider.startedAt
  if (start === null) return null
  return ((job.provider.endedAt ?? now) - start) / 1000
}

export interface ComparisonRow {
  readonly cls: string
  readonly baseline: TrainingEvalClass | null
  readonly candidate: TrainingEvalClass | null
  readonly int8: TrainingEvalClass | null
}

function classOf(
  report: TrainingEvalReport | null | undefined,
  cls: string,
): TrainingEvalClass | null {
  return report?.classes[cls] ?? null
}

export function comparisonRows(result: TrainingResult): readonly ComparisonRow[] {
  const ev = result.evaluation
  if (ev === undefined) return []
  const classes = new Set<string>([
    ...Object.keys(ev.baseline?.classes ?? {}),
    ...Object.keys(ev.candidate?.classes ?? {}),
    ...Object.keys(ev.candidateInt8?.classes ?? {}),
  ])
  return [...classes].toSorted().map((cls) => ({
    cls,
    baseline: classOf(ev.baseline, cls),
    candidate: classOf(ev.candidate, cls),
    int8: classOf(ev.candidateInt8, cls),
  }))
}

/** A per-camera recall change smaller than this is noise, not a verdict. */
export const RECALL_DELTA_TOLERANCE = 0.01

export type DeltaTone = 'better' | 'worse' | 'same'

export interface RecallDeltaRow {
  readonly cls: string
  readonly deviceId: number
  readonly delta: number
  readonly tone: DeltaTone
}

export function recallDeltaRows(result: TrainingResult): readonly RecallDeltaRow[] {
  const byClass = result.evaluation?.recallDeltaByCamera ?? {}
  const rows: RecallDeltaRow[] = []
  for (const [cls, cams] of Object.entries(byClass)) {
    for (const [device, delta] of Object.entries(cams)) {
      const tone: DeltaTone =
        delta < -RECALL_DELTA_TOLERANCE
          ? 'worse'
          : delta > RECALL_DELTA_TOLERANCE
            ? 'better'
            : 'same'
      rows.push({ cls, deviceId: Number(device), delta, tone })
    }
  }
  return rows.toSorted((a, b) => a.cls.localeCompare(b.cls) || a.deviceId - b.deviceId)
}

/** The badge colour a job state reads as. */
export function stateTone(
  state: TrainingJobState,
): 'success' | 'warning' | 'danger' | 'info' | 'default' {
  if (state === 'ready' || state === 'registered' || state === 'canary') return 'success'
  if (state === 'failed' || state === 'lost') return 'danger'
  if (
    state === 'cancelling' ||
    state === 'cancelled' ||
    state === 'expired' ||
    state === 'discarded'
  ) {
    return 'default'
  }
  return 'info'
}
