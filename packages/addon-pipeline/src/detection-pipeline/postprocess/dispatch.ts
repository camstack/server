/**
 * Postprocess funnel for engine output.
 *
 * Every engine runs in the Python inference pool and postprocessing happens
 * in-process there (`python/inference_pool.py` + `python/postprocessors/*`):
 * the pool returns a fully-postprocessed `structured` StepOutput. This module
 * only VALIDATES that payload and applies the shared normalization funnel.
 *
 * The former Node.js onnxruntime raw-tensor postprocessors (yolo decode,
 * SCRFD anchors, TS-side NMS, CTC decode, saliency flood-fill, …) were
 * removed with the Node ONNX path — an engine output without `structured`
 * is a defect and throws loudly instead of silently falling back.
 */
import type { EngineOutput, PostprocessorType, StepDefinition, StepOutput } from '@camstack/types'

// Re-export postprocessor types for consumers
export type { StepOutput }

// ---------------------------------------------------------------------------
// Type guard for Python-pool structured output
// ---------------------------------------------------------------------------

const VALID_KINDS = new Set<string>(['detections', 'classifications', 'embedding', 'text', 'mask'])

/** Every postprocessor the Python pool implements — the dispatch table's keys
 *  survived the raw-tensor removal as a config-drift guard: an unknown
 *  postprocessor in a step definition still fails fast here. */
const KNOWN_POSTPROCESSORS = new Set<PostprocessorType>([
  'yolo',
  'ssd',
  'rfdetr',
  'yolonas',
  'yolo-seg',
  'yolo-split-dfl',
  'scrfd',
  'yunet',
  'arcface',
  'clip',
  'softmax',
  'ctc',
  'plate-slots',
  'saliency',
  'yamnet',
])

/**
 * Type guard: validates that a structured payload from the Python pool is a
 * well-formed StepOutput discriminated union.
 *
 * The Python inference_pool.py always sets `output.structured` with a `kind`
 * field. This guard narrows `Record<string, unknown>` to `StepOutput` without
 * resorting to double-cast.
 */
function isStepOutput(value: unknown): value is StepOutput {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['kind'] === 'string' &&
    VALID_KINDS.has((value as Record<string, unknown>)['kind'] as string)
  )
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Validate + normalize a Python-pool engine output into a StepOutput.
 */
export function dispatchPostprocess(output: EngineOutput, stepDef: StepDefinition): StepOutput {
  // Overload shed (`EngineOutput.dropped`): the pool deliberately skipped
  // this frame. The executor skips shed outputs BEFORE postprocessing; this
  // guard is the safety net for any other caller, so a shed can never
  // surface as a malformed-output error again ("unexpected kind: undefined"
  // — the defect that logged every deliberate shed as an inference FAILURE
  // at error level on all three nodes, 2026-08-01). An empty detections
  // output is inert everywhere: detector roots read it as "nothing this
  // frame", enrichment appliers ignore a kind they don't consume.
  if (output.dropped === true) {
    return { kind: 'detections', detections: [] }
  }

  if (!KNOWN_POSTPROCESSORS.has(stepDef.postprocessor)) {
    throw new Error(`Unknown postprocessor type: "${stepDef.postprocessor}"`)
  }

  if (!output.structured) {
    throw new Error(
      `Postprocessing for step "${stepDef.id}" (${stepDef.postprocessor}) runs in the ` +
        'Python inference pool — the engine output carried no structured payload. ' +
        'The Node.js raw-tensor path was removed; there is nothing to fall back to.',
    )
  }
  if (!isStepOutput(output.structured)) {
    throw new Error(
      `Python pool returned structured output with unexpected kind: ${JSON.stringify(output.structured['kind'])}`,
    )
  }

  return normalizeOutput(output.structured)
}

/**
 * Normalize any StepOutput to a consistent format — the single funnel every
 * pool payload passes through.
 *
 * Classifications: keep only top-1 in classifications, move full list to alternates.
 */
function normalizeOutput(output: StepOutput): StepOutput {
  if (output.kind !== 'classifications') return output

  const all = output.classifications
  if (all.length <= 1) return output

  return {
    kind: 'classifications',
    classifications: all.slice(0, 1),
    alternates: all,
  }
}
