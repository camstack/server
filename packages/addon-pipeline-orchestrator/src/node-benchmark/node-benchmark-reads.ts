/**
 * Read paths of the node benchmark (D791): the plan editor's candidates and
 * the results with their standing today. Pure over injected reads.
 */
import {
  type CurrentPool,
  DETECTOR_ACCURACY,
  errMsg,
  type IScopedLogger,
  type ListNodeBenchmarkResultsInput,
  listBenchDetailSteps,
  MODEL_FORMATS,
  type ModelFormat,
  type NodeBenchmarkCandidates,
  type NodeBenchmarkResult,
  type NodeBenchmarkResultView,
  type NodeInferenceDevices,
  type PipelineSchema,
  resultStandings,
} from '@camstack/types'

const DETECTOR_STEP_ID = 'object-detection'
/** The family Auto tune picks from (D745) — the suggestions follow it. */
const SUGGESTED_FAMILY = 'yolov9'
const MAX_SUGGESTED = 3

function detectorFormats(
  catalog: PipelineSchema | null,
): ReadonlyMap<string, readonly ModelFormat[]> {
  const out = new Map<string, readonly ModelFormat[]>()
  for (const slot of catalog?.slots ?? []) {
    for (const addon of slot.addons) {
      if (addon.id !== DETECTOR_STEP_ID) continue
      for (const model of addon.models) {
        if (model.legacy === true) continue
        out.set(
          model.id,
          MODEL_FORMATS.filter((f) => f in model.formats),
        )
      }
    }
  }
  return out
}

/** Candidates per device: Auto tune's pick first, then the family by person recall. */
export async function readNodeBenchmarkCandidates(deps: {
  readonly nodeId: string
  readonly readDevices: (nodeId: string) => Promise<NodeInferenceDevices>
  readonly readCatalog: (nodeId: string) => Promise<PipelineSchema | null>
  /** deviceKey → Auto tune's model for it; empty when Auto tune cannot say. */
  readonly autoTunePicks: (nodeId: string) => Promise<Readonly<Record<string, string>>>
  readonly logger: IScopedLogger
}): Promise<NodeBenchmarkCandidates> {
  const devices = await deps.readDevices(deps.nodeId)
  const catalog = await deps.readCatalog(deps.nodeId).catch(() => null)
  let picks: Readonly<Record<string, string>> = {}
  try {
    picks = await deps.autoTunePicks(deps.nodeId)
  } catch (err) {
    deps.logger.debug('node benchmark candidates: Auto tune pick unavailable', {
      meta: { nodeId: deps.nodeId, error: errMsg(err) },
    })
  }
  const formats = detectorFormats(catalog)
  const family = Object.keys(DETECTOR_ACCURACY)
    .filter((id) => id.startsWith(SUGGESTED_FAMILY))
    .toSorted(
      (a, b) =>
        (DETECTOR_ACCURACY[b]?.personRecall ?? 0) - (DETECTOR_ACCURACY[a]?.personRecall ?? 0) ||
        a.localeCompare(b),
    )
  return {
    nodeId: deps.nodeId,
    reachable: devices.reachable,
    devices: devices.devices.map((d) => {
      const runs = (id: string): boolean => (formats.get(id) ?? []).includes(d.format)
      const all = [...formats.keys()].filter(runs).toSorted()
      const pick = picks[d.key]
      const ordered = [
        ...(pick !== undefined && runs(pick) ? [pick] : []),
        ...family.filter((id) => runs(id) && id !== pick),
      ]
      return {
        deviceKey: d.key,
        enabled: d.enabled,
        available: d.available,
        suggested: ordered.slice(0, MAX_SUGGESTED),
        all,
        currentModelId: d.steps?.[DETECTOR_STEP_ID]?.modelId ?? d.defaultModelId ?? null,
      }
    }),
    steps: catalog === null ? [] : listBenchDetailSteps(catalog),
  }
}

/** Results filtered, newest first, each with its standing today. */
export function listNodeBenchmarkResultViews(
  rows: readonly NodeBenchmarkResult[],
  input: ListNodeBenchmarkResultsInput,
  ctx: {
    readonly nowMs: number
    readonly currentPools: Readonly<Record<string, Readonly<Record<string, CurrentPool>>>>
  },
): readonly NodeBenchmarkResultView[] {
  const standings = resultStandings(rows, ctx)
  return rows
    .filter((r) => input.nodeId === undefined || r.nodeId === input.nodeId)
    .filter((r) => input.deviceKey === undefined || r.cell.deviceKey === input.deviceKey)
    .toSorted((a, b) => b.measuredAtMs - a.measuredAtMs)
    .map((r) => ({
      ...r,
      standing: standings.get(r.id)?.standing ?? 'stale',
      staleWhy: standings.get(r.id)?.staleWhy ?? null,
    }))
}
