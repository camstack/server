/**
 * D214 addendum — a plus catalog ONNX import feeds the SAME conversion pipeline
 * as the Convert tab (`model-convert` cap: ONNX→OpenVINO direct, ONNX→CoreML
 * via the torch bridge), so the model runs on every engine the cluster has:
 *
 *   onnx (as delivered by plus catalog for yolonas/yolov9)
 *     → onnxruntime nodes directly (the downloaded artifact)
 *     → OpenVINO IR fp16, converted on an openvino-capable node (hub NPU/GPU/CPU)
 *     → CoreML mlpackage, converted on a darwin node (ANE)
 *
 * Rules encoded here:
 *  - PER-FORMAT ISOLATION (D54): each target converts independently; a
 *    failure or an unsupported format is an explicit OUTCOME, never an
 *    exception that hides the sibling — a node missing its format simply
 *    refuses at load, it is never handed a substitute.
 *  - MERGE, never replace: the convert pipeline's entry carries no
 *    `postprocessor` (ModelConvertMetadata has none), so registering it
 *    verbatim would silently drop the yolonas decode — the exact D208 bug.
 *    Converted formats are merged INTO the imported entry.
 *
 * Pure, deps-injected — unit-tested offline; the addon wires ctx.api.
 */
import type { ConvertResult, ConvertTarget, ModelCatalogEntry } from '@camstack/types'
import type { NodeRecommendation } from '../convert-orchestrator.js'

export type PlusConvertibleFormat = 'openvino' | 'coreml'

export interface PlusConversionOutcome {
  readonly format: PlusConvertibleFormat
  readonly ok: boolean
  readonly nodeId?: string
  readonly error?: string
}

export interface PlusConversionDeps {
  recommend(input: { targets: readonly ConvertTarget[] }): Promise<readonly NodeRecommendation[]>
  convert(
    input: {
      sourceUrl: string
      metadata: {
        id: string
        name: string
        labels: ModelCatalogEntry['labels']
        inputSize: ModelCatalogEntry['inputSize']
        preprocessMode?: 'letterbox' | 'resize'
        outputFormat: 'yolo'
      }
      targets: readonly ConvertTarget[]
    },
    nodeId: string,
  ): Promise<ConvertResult>
  /** A FRESH presigned artifact URL — resolved per conversion (the target
   *  node downloads the source itself; the previous URL may have expired). */
  freshSourceUrl(): Promise<string>
  upsertEntry(entry: ModelCatalogEntry): Promise<void>
  markAvailable(
    nodeId: string,
    modelId: string,
    artifacts: ConvertResult['artifacts'],
  ): Promise<void>
}

/** Converted formats ADD to the imported entry; identity fields (decode,
 *  labels, description, preprocess) stay the import's. */
export function mergeConvertedFormats(
  base: ModelCatalogEntry,
  converted: ModelCatalogEntry,
): ModelCatalogEntry {
  return { ...base, formats: { ...base.formats, ...converted.formats } }
}

function targetOf(format: PlusConvertibleFormat): ConvertTarget {
  return format === 'openvino' ? { format, precisions: ['fp16'] } : { format }
}

export interface RunPlusConversionsArgs {
  readonly entry: ModelCatalogEntry
  readonly targetFormats: readonly PlusConvertibleFormat[]
}

/**
 * Convert the imported ONNX for each requested engine, one target at a time,
 * merging every success into the registered entry. Returns one outcome per
 * requested format — the caller surfaces them verbatim.
 */
export async function runPlusConversions(
  deps: PlusConversionDeps,
  args: RunPlusConversionsArgs,
): Promise<readonly PlusConversionOutcome[]> {
  const outcomes: PlusConversionOutcome[] = []
  let current = args.entry

  for (const format of args.targetFormats) {
    const targets = [targetOf(format)]
    try {
      const ranked = await deps.recommend({ targets })
      const best = ranked.find((r) => r.supported)
      if (!best) {
        const reason = ranked[0]?.reason ?? 'no node can satisfy this target'
        outcomes.push({ format, ok: false, error: reason })
        continue
      }
      const sourceUrl = await deps.freshSourceUrl()
      const result = await deps.convert(
        {
          sourceUrl,
          metadata: {
            id: current.id,
            name: current.name,
            labels: current.labels,
            inputSize: current.inputSize,
            preprocessMode: current.preprocessMode ?? 'letterbox',
            outputFormat: 'yolo',
          },
          targets,
        },
        best.nodeId,
      )
      if (result.artifacts.length === 0) {
        outcomes.push({ format, ok: false, nodeId: best.nodeId, error: 'no validated artifacts' })
        continue
      }
      current = mergeConvertedFormats(current, result.entry)
      await deps.upsertEntry(current)
      await deps.markAvailable(best.nodeId, current.id, result.artifacts)
      outcomes.push({ format, ok: true, nodeId: best.nodeId })
    } catch (err) {
      outcomes.push({
        format,
        ok: false,
        error: err instanceof Error ? err.message : 'conversion failed',
      })
    }
  }
  return outcomes
}
