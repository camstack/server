/**
 * `training.planJob` — everything the confirm step shows, and every named
 * refusal, with nothing started. `startJob` runs the same plan first, so a
 * job can never start on terms the operator was not shown.
 */
import type {
  RetrainDatasetStats,
  RetrainExportLayout,
  TrainingJobPlan,
  TrainingJobRequest,
  TrainingProviderDescriptor,
  TrainingRefusalReason,
  TrainingSplitPlan,
} from '@camstack/types'
import { type BaseModelSpec, findBaseModel } from './base-models.js'
import {
  datasetBytesEstimate,
  defaultCostCap,
  estimateGpuSeconds,
  knownGpu,
  planSplit,
  uploadMinutes,
} from './planner.js'
import type { CorpusPort, ProviderPort } from './ports.js'

/** Days a staged result stays on the hub (operator decision 2026-10-08). */
export const ARTIFACT_RETENTION_DAYS = 14

export interface ResolvedCorpus {
  readonly frameIds: readonly string[]
  readonly stats: RetrainDatasetStats
  readonly annotationHash: string
  readonly layout: RetrainExportLayout
}

export interface PlannedJob {
  readonly plan: TrainingJobPlan
  /** Present only when the plan has no refusal. */
  readonly accepted: {
    readonly corpus: ResolvedCorpus
    readonly provider: TrainingProviderDescriptor
    readonly base: BaseModelSpec
    readonly split: TrainingSplitPlan
  } | null
}

function refused(reason: TrainingRefusalReason, detail: string, dataNotice = ''): PlannedJob {
  return {
    plan: {
      refusal: { reason, detail },
      warnings: [],
      split: null,
      estimate: null,
      defaults: null,
      dataNotice,
    },
    accepted: null,
  }
}

export function dataNoticeFor(
  provider: TrainingProviderDescriptor,
  region: string,
  frames: number,
): string {
  const where = region === '' ? 'in the region the provider picks' : `in region "${region}"`
  const grace = provider.defaults.failedDatasetGraceHours
  return (
    `${String(frames)} frames and their boxes are uploaded to YOUR ${provider.label} account, ${where}. ` +
    `${provider.dataResidencyNote} They are deleted there as soon as the result is fetched ` +
    `(${String(grace)} h after a failure, so it can be inspected), and they are never put in a log, ` +
    `an environment variable or the job file. The result stays on this hub for ${String(ARTIFACT_RETENTION_DAYS)} days; ` +
    'nothing is registered until you click Register.'
  )
}

export async function planJob(
  request: TrainingJobRequest,
  deps: { readonly corpus: CorpusPort; readonly provider: ProviderPort },
): Promise<PlannedJob> {
  const resolved = await deps.corpus.resolve(request.selection)
  if (resolved.kind === 'refused') {
    if (resolved.reason === 'unknown-collection') {
      return refused('unknown-dataset', resolved.detail)
    }
    return refused('no-training-subjects', resolved.detail)
  }
  const corpus: ResolvedCorpus = {
    frameIds: resolved.frameIds,
    stats: resolved.stats,
    annotationHash: resolved.annotationHash,
    layout: resolved.layout,
  }
  const providers = await deps.provider.describe({})
  const provider = providers.find((p) => p.entryId === request.entryId)
  if (provider === undefined)
    return refused('unknown-provider', `no training provider entry "${request.entryId}"`)
  const notice = dataNoticeFor(provider, request.region, corpus.frameIds.length)
  if (!provider.configured) {
    return refused(
      'provider-not-configured',
      `${provider.name} (${provider.label}) has no credentials yet — set them on the entry`,
      notice,
    )
  }
  const base = findBaseModel(request.baseModelId)
  if (base === null)
    return refused('unknown-base-model', `"${request.baseModelId}" is not a trainable base`, notice)
  if (!knownGpu(provider.gpuTypes, request.gpuType)) {
    return refused('unknown-gpu', `${provider.label} offers no "${request.gpuType}"`, notice)
  }
  const datasetBytes = datasetBytesEstimate(corpus.frameIds.length)
  if (datasetBytes > provider.maxDatasetBytes) {
    return refused(
      'dataset-too-large',
      `about ${String(Math.round(datasetBytes / 1e6))} MB is over ${provider.label}'s limit`,
      notice,
    )
  }
  const { split, warnings } = planSplit(corpus.stats, request.holdoutCameras)
  if (split.trainSubjects <= 0) {
    return refused(
      'no-training-subjects',
      'no boxed subject is left to train on once the holdout is set aside',
      notice,
    )
  }
  const gpu = estimateGpuSeconds({
    frames: corpus.frameIds.length,
    base,
    preset: request.preset,
    gpuType: request.gpuType,
  })
  const usd = await deps.provider.estimateJob({
    entryId: request.entryId,
    gpuType: request.gpuType,
    region: request.region,
    datasetBytes,
    gpuSecondsLow: gpu.gpuSecondsLow,
    gpuSecondsHigh: gpu.gpuSecondsHigh,
  })
  const maxCostUsd = defaultCostCap(usd.usdHigh, provider.defaults.costCapUsd)
  const allWarnings = [...warnings]
  if (usd.usdHigh > maxCostUsd) {
    allWarnings.push(
      `The high estimate ($${usd.usdHigh.toFixed(2)}) is above the cost cap ($${maxCostUsd.toFixed(2)}): the job may be stopped before it finishes.`,
    )
  }
  if (corpus.stats.completeness < 0.5) {
    allWarnings.push(
      'Fewer than half of the frames are marked complete: evaluation uses complete frames only, so the comparison rests on few frames.',
    )
  }
  return {
    plan: {
      refusal: null,
      warnings: allWarnings,
      split,
      estimate: {
        datasetBytes,
        uploadMinutesAt20Mbps: uploadMinutes(datasetBytes),
        gpuSecondsLow: gpu.gpuSecondsLow,
        gpuSecondsHigh: gpu.gpuSecondsHigh,
        usdLow: usd.usdLow,
        usdHigh: usd.usdHigh,
        notes: [
          'GPU time is a first estimate (not yet measured on real runs); the cost cap bounds a wrong guess.',
          ...usd.notes,
        ],
      },
      defaults: { maxCostUsd, maxRuntimeSec: provider.defaults.maxRuntimeSec },
      dataNotice: notice,
    },
    accepted: { corpus, provider, base, split },
  }
}
