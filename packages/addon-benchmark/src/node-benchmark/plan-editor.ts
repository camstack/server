/**
 * The Node benchmark section's pure view model (D791): what the operator
 * picks becomes a plan, a preflight becomes the confirmation text, a run
 * becomes a status line, and a stored result becomes a table row. No React,
 * no trpc — so "does this choice reach the run" is a unit assertion.
 */
import type {
  NodeBenchmarkCandidates,
  NodeBenchmarkPhase,
  NodeBenchmarkPlanInput,
  NodeBenchmarkPreflight,
  NodeBenchmarkResultView,
  NodeBenchmarkRun,
  NodeBenchProgress,
} from '@camstack/types'
import { translate } from '../i18n/index.js'

/** One device's selection in the editor. */
export interface DeviceSelection {
  readonly deviceKey: string
  readonly included: boolean
  /** Candidates to measure, in order; the first runs the pipeline measurement. */
  readonly modelIds: readonly string[]
}

export interface PlanDraft {
  readonly nodeId: string
  readonly devices: readonly DeviceSelection[]
  readonly phases: readonly NodeBenchmarkPhase[]
  readonly steps: readonly string[]
  readonly fpsPerStream: number
  readonly budgetMinutes: number
  readonly keepDownloadedModels: boolean
  readonly acceptInsufficientHeadroom: boolean
}

export const DEFAULT_PHASES: readonly NodeBenchmarkPhase[] = ['device', 'pipeline']

/**
 * The editor's starting point for a node: every enabled, available device
 * with its first suggested candidate; disabled or unavailable devices are
 * listed but left out.
 */
export function initialDraft(candidates: NodeBenchmarkCandidates): PlanDraft {
  return {
    nodeId: candidates.nodeId,
    devices: candidates.devices.map((d) => {
      const first = d.suggested[0] ?? d.currentModelId ?? d.all[0]
      return {
        deviceKey: d.deviceKey,
        included: d.enabled && d.available && first !== undefined,
        modelIds: first === undefined ? [] : [first],
      }
    }),
    phases: DEFAULT_PHASES,
    steps: [],
    fpsPerStream: 10,
    budgetMinutes: 45,
    keepDownloadedModels: false,
    acceptInsufficientHeadroom: false,
  }
}

/** Toggle one candidate on a device, keeping the order the operator picked them in. */
export function toggleModel(draft: PlanDraft, deviceKey: string, modelId: string): PlanDraft {
  return {
    ...draft,
    devices: draft.devices.map((d) => {
      if (d.deviceKey !== deviceKey) return d
      const has = d.modelIds.includes(modelId)
      return {
        ...d,
        modelIds: has ? d.modelIds.filter((m) => m !== modelId) : [...d.modelIds, modelId],
      }
    }),
  }
}

export function toggleDevice(draft: PlanDraft, deviceKey: string): PlanDraft {
  return {
    ...draft,
    devices: draft.devices.map((d) =>
      d.deviceKey === deviceKey ? { ...d, included: !d.included } : d,
    ),
  }
}

function toggle<T>(list: readonly T[], item: T): readonly T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item]
}

export function togglePhase(draft: PlanDraft, phase: NodeBenchmarkPhase): PlanDraft {
  return { ...draft, phases: toggle(draft.phases, phase) }
}

export function toggleStep(draft: PlanDraft, stepId: string): PlanDraft {
  return { ...draft, steps: toggle(draft.steps, stepId) }
}

/** The plan the draft describes, or the reason it cannot be one yet. */
export function planOf(
  draft: PlanDraft,
):
  | { readonly kind: 'plan'; readonly plan: NodeBenchmarkPlanInput }
  | { readonly kind: 'incomplete'; readonly why: string } {
  const devices = draft.devices
    .filter((d) => d.included && d.modelIds.length > 0)
    .map((d) => ({ deviceKey: d.deviceKey, modelIds: [...d.modelIds] }))
  if (devices.length === 0) return { kind: 'incomplete', why: translate('plan.chooseDevice') }
  if (draft.phases.length === 0)
    return { kind: 'incomplete', why: translate('plan.chooseMeasurement') }
  return {
    kind: 'plan',
    plan: {
      nodeId: draft.nodeId,
      devices,
      phases: [...draft.phases],
      steps: draft.phases.includes('pipeline') ? [...draft.steps] : [],
      fpsPerStream: draft.fpsPerStream,
      budgetMinutes: draft.budgetMinutes,
      keepDownloadedModels: draft.keepDownloadedModels,
      acceptInsufficientHeadroom: draft.acceptInsufficientHeadroom,
    },
  }
}

/** `1 h 05 min`, `12 min`, `40 s`. */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  if (totalSec < 60) return `${totalSec} s`
  const min = Math.round(totalSec / 60)
  if (min < 60) return `${min} min`
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`
}

/** The confirmation's lines, in reading order. */
export function preflightLines(p: NodeBenchmarkPreflight): readonly string[] {
  const lines = [
    translate('preflight.node', { node: p.nodeId }),
    p.moving.length === 0
      ? translate('preflight.noneMoving')
      : translate('preflight.moving', {
          count: p.moving.length,
          list: p.moving
            .map((c) => `#${c.deviceId}${c.pinnedToNode ? translate('preflight.pinned') : ''}`)
            .join(', '),
        }),
  ]
  if (p.staying.length > 0) {
    lines.push(
      translate('preflight.staying', {
        count: p.staying.length,
        list: p.staying.map((c) => `#${c.deviceId}`).join(', '),
      }),
    )
  }
  lines.push(
    translate('preflight.measurements', {
      list: p.phases
        .map((ph) => (ph === 'device' ? translate('phase.device') : translate('phase.pipeline')))
        .join(' + '),
      steps: p.steps.length > 0 ? translate('preflight.steps', { steps: p.steps.join(', ') }) : '',
    }),
    translate('preflight.devices', {
      list: p.devices.map((d) => `${d.deviceKey} → ${d.modelIds.join(', ')}`).join('; '),
    }),
    translate('preflight.estimated', {
      estimate: formatDuration(p.estimatedDurationMs),
      budget: formatDuration(p.budgetMs),
    }),
  )
  return lines
}

/** One line for an active or finished run. */
export function runLine(run: NodeBenchmarkRun): string {
  const progress = run.progress === null ? '' : ` · ${progressLine(run.progress)}`
  switch (run.state) {
    case 'draining':
      return translate('run.draining', { node: run.nodeId })
    case 'measuring':
      return translate('run.measuring', { node: run.nodeId, progress })
    case 'restoring':
      return translate('run.restoring')
    case 'done':
      return translate('run.done', { count: run.resultIds.length })
    case 'aborted':
      return translate('run.aborted', {
        reason: endReasonText(run.endReason),
        count: run.resultIds.length,
      })
    case 'failed':
      return run.error
        ? translate('run.failedDetail', { error: run.error })
        : translate('run.failed')
  }
}

export function progressLine(p: NodeBenchProgress): string {
  const what =
    p.phase === 'device'
      ? translate('progress.device', { device: p.deviceKey ?? '', model: p.modelId ?? '' })
      : p.phase === 'pipeline'
        ? translate('progress.pipeline', { device: p.deviceKey ?? '', model: p.modelId ?? '' })
        : p.phase
  return `${what} · ${p.message} (${p.cellsDone}/${p.cellsTotal})`
}

function endReasonText(reason: NodeBenchmarkRun['endReason']): string {
  switch (reason) {
    case 'operator-abort':
      return translate('endReason.operator-abort')
    case 'deadline':
      return translate('endReason.deadline')
    case 'node-lost':
      return translate('endReason.node-lost')
    case 'runner-lost':
      return translate('endReason.runner-lost')
    case 'hub-restart':
      return translate('endReason.hub-restart')
    case 'drain-timeout':
      return translate('endReason.drain-timeout')
    default:
      return reason ?? 'unknown'
  }
}

function staleReason(why: NodeBenchmarkResultView['staleWhy']): string {
  if (why === 'age') return translate('standing.staleAge')
  if (why === 'runtime') return translate('standing.staleRuntime')
  return translate('standing.stalePool')
}

/** A stored result as one table row. */
export interface ResultRow {
  readonly id: string
  readonly deviceKey: string
  readonly modelId: string
  readonly what: string
  readonly capacity: string
  readonly latency: string
  readonly limitedBy: string
  readonly measuredAt: string
  readonly standing: string
  readonly flags: readonly string[]
}

export function resultRow(r: NodeBenchmarkResultView, locale?: string): ResultRow {
  const cell = r.cell
  const flags = [
    ...(r.contaminated ? [translate('flags.contaminated')] : []),
    ...(r.partialRun ? [translate('flags.partialRun')] : []),
    ...(r.clip?.id === 'reference-images' ? [translate('flags.referenceImages')] : []),
  ]
  return {
    id: r.id,
    deviceKey: cell.deviceKey,
    modelId: cell.modelId,
    what:
      cell.phase === 'device'
        ? translate('result.deviceCapacity')
        : translate(cell.steps.length > 0 ? 'result.pipelineWithSteps' : 'result.pipeline', {
            steps: cell.steps.join(', '),
          }),
    capacity:
      cell.phase === 'device'
        ? translate('result.capacityDevice', { streams: cell.kMax, fps: cell.fps })
        : translate('result.capacityPipeline', { sessions: cell.maxSessions }),
    latency: cell.phase === 'device' ? `p50 ${cell.p50Ms} ms · p95 ${cell.p95Ms} ms` : '—',
    limitedBy: cell.limitedBy,
    measuredAt: new Date(r.measuredAtMs).toLocaleString(locale),
    standing:
      r.standing === 'fresh'
        ? translate('standing.fresh')
        : r.standing === 'superseded'
          ? translate('standing.superseded')
          : translate('standing.stale', { why: staleReason(r.staleWhy) }),
    flags,
  }
}
