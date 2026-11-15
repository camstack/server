/**
 * `benchmark_image_run` — the Benchmark page's Image section from the MCP:
 * one existing `runPipelineTest` (addon `benchmark`, a custom action) of one
 * step on a (node, accelerator device) with one model, against a reference
 * image the hub already holds. It is the call the detector-latency harness
 * (`scripts/bench-detector-latency-column.mjs`) repeats; no benchmark code is
 * added here, only the input mapping and a bounded summary of the answer.
 *
 * One run is short (the addon cuts it at 55 s), so it returns its result
 * directly; the long, load-test kind is the node benchmark (`benchmark_run`
 * then `benchmark_status`). It still loads the node's accelerator, so it goes
 * through the mutation gate: dry run → single-use token → run.
 */
import { z } from 'zod'
import { runGated, toToolOutput, type GatedResult, type MutationGate } from '@camstack/develop'
import type { OpsMutator } from '../ops/hub.js'

export const IMAGE_RUN_PATH = 'addons.custom'
export const IMAGE_RUN_ADDON = 'benchmark'
export const IMAGE_RUN_ACTION = 'runPipelineTest'

export const BENCHMARK_IMAGE_WARNING =
  'One inference run on the chosen node and accelerator: it loads that node (and the model, if it is not loaded yet) while it runs. Confirm only when the operator asked for this measurement.'

export const ImageRunArgsSchema = z.object({
  nodeId: z.string().min(1),
  /** The accelerator device key on that node, e.g. `openvino:npu`, `coreml`, `cpu`. */
  deviceKey: z.string().min(1),
  modelId: z.string().min(1),
  /** The step to run; default `object-detection`. */
  step: z.string().min(1).optional(),
  /** A reference image the hub holds (`pipelineExecutor.listReferenceImages`); default `3-persons.jpg`. */
  referenceImage: z.string().min(1).optional(),
  /** `frame` = the step alone (latency); `full` = with the frame plane around it. Default `frame`. */
  plane: z.enum(['full', 'frame']).optional(),
})

export type ImageRunArgs = z.infer<typeof ImageRunArgsSchema>

/** The `addons.custom` input the Image section sends. */
export interface ImageRunCall {
  readonly addonId: typeof IMAGE_RUN_ADDON
  readonly action: typeof IMAGE_RUN_ACTION
  readonly input: {
    readonly nodeId: string
    readonly deviceKey: string
    readonly referenceImage: string
    readonly plane: 'full' | 'frame'
    readonly steps: readonly [
      {
        readonly addonId: string
        readonly enabled: true
        readonly modelId: string
        readonly children: readonly []
      },
    ]
  }
}

export function imageRunCall(args: ImageRunArgs): ImageRunCall {
  return {
    addonId: IMAGE_RUN_ADDON,
    action: IMAGE_RUN_ACTION,
    input: {
      nodeId: args.nodeId,
      deviceKey: args.deviceKey,
      referenceImage: args.referenceImage ?? '3-persons.jpg',
      plane: args.plane ?? 'frame',
      steps: [
        {
          addonId: args.step ?? 'object-detection',
          enabled: true,
          modelId: args.modelId,
          children: [],
        },
      ],
    },
  }
}

const TimingSchema = z.looseObject({ source: z.string().optional(), ms: z.number().optional() })

const RunResultSchema = z.looseObject({
  kind: z.string().optional(),
  detections: z
    .array(
      z.looseObject({
        class: z.string().optional(),
        score: z.number().optional(),
        debug: z
          .looseObject({ stepLatencyMs: z.record(z.string(), z.number()).optional() })
          .optional(),
      }),
    )
    .optional(),
  discarded: z.array(z.unknown()).optional(),
  debug: z
    .looseObject({
      stepTimings: z.array(TimingSchema).optional(),
      predictMs: z.number().optional(),
      totalInferenceMs: z.number().optional(),
    })
    .optional(),
})

export interface ImageRunSummary {
  readonly nodeId: string
  readonly deviceKey: string
  readonly modelId: string
  readonly step: string
  readonly kind: string | null
  /** The step's inference time, read like the latency harness reads it; null when the answer had none. */
  readonly inferMs: number | null
  readonly wallMs: number
  readonly detections: number
  /** The first 10 detections, class and score only. */
  readonly topDetections: readonly { readonly class: string; readonly score: number | null }[]
  readonly discarded: number
  /** Per-step timings, at most 10. */
  readonly stepTimings: readonly { readonly source: string; readonly ms: number }[]
}

const SUMMARY_TOP = 10

function inferMsOf(result: z.infer<typeof RunResultSchema>, step: string): number | null {
  const fromDetection = result.detections?.[0]?.debug?.stepLatencyMs?.[step]
  if (fromDetection !== undefined && fromDetection > 0) return fromDetection
  const timing = result.debug?.stepTimings?.find((t) => t.source === step)?.ms
  if (timing !== undefined && timing > 0) return timing
  const predict = result.debug?.predictMs
  if (predict !== undefined && predict > 0) return predict
  const total = result.debug?.totalInferenceMs
  if (total !== undefined && total > 0) return total
  return null
}

/** The hub's answer to one run, reduced to what a caller compares. */
export function summarizeImageRun(
  args: ImageRunArgs,
  raw: unknown,
  wallMs: number,
): ImageRunSummary {
  const step = args.step ?? 'object-detection'
  const parsed = RunResultSchema.safeParse(raw)
  const result = parsed.success ? parsed.data : {}
  return {
    nodeId: args.nodeId,
    deviceKey: args.deviceKey,
    modelId: args.modelId,
    step,
    kind: result.kind ?? null,
    inferMs: inferMsOf(result, step),
    wallMs,
    detections: result.detections?.length ?? 0,
    topDetections: (result.detections ?? []).slice(0, SUMMARY_TOP).map((d) => ({
      class: d.class ?? '?',
      score: d.score ?? null,
    })),
    discarded: result.discarded?.length ?? 0,
    stepTimings: (result.debug?.stepTimings ?? [])
      .slice(0, SUMMARY_TOP)
      .flatMap((t) =>
        t.source !== undefined && t.ms !== undefined ? [{ source: t.source, ms: t.ms }] : [],
      ),
  }
}

export interface ImageRunDeps {
  readonly gate: MutationGate
  readonly mutator: () => OpsMutator
  readonly now?: () => number
}

export function benchmarkImageRun(
  deps: ImageRunDeps,
  args: ImageRunArgs,
  confirmToken: string | undefined,
): Promise<GatedResult> {
  const now = deps.now ?? ((): number => Date.now())
  return runGated(
    deps.gate,
    {
      tool: 'benchmark_image_run',
      dryRun: async (a: ImageRunArgs) => ({
        confirmable: true,
        describe: toToolOutput({
          warning: BENCHMARK_IMAGE_WARNING,
          wouldCall: IMAGE_RUN_PATH,
          input: imageRunCall(a),
        }),
      }),
      execute: async (a: ImageRunArgs) => {
        const startedAt = now()
        const raw = await deps.mutator().mutate(IMAGE_RUN_PATH, imageRunCall(a))
        return summarizeImageRun(a, raw, now() - startedAt)
      },
    },
    args,
    confirmToken,
  )
}
