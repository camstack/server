/**
 * Pure payload + debug selection for the Audio Analysis tab.
 *
 * Two shipped defects live here as executable rules:
 *
 * 1. The tab read the debug step key `audio-classifier`. Both producers
 *    write `audio-analyzer` — `detection-pipeline/provider.ts` on the bench
 *    path and `audio-window-accumulator.ts` on the live path — so the
 *    Classifications panel and the inference timing were permanently empty.
 *    `audio-classifier` is a real `StepDefinition.id`, which is exactly why
 *    a naive "is this a known step" check never caught it: it is a real
 *    step, just not what the audio ANALYZER tags its debug with.
 *
 * 2. The tab drew an "Upload WAV" button. `pipelineExecutor.runAudioTest`
 *    takes `{addonId, modelId, filename?, settings?}` and has NO field for
 *    an uploaded payload, and the upload handler CLEARED the selected
 *    filename — so the provider fell back to the first reference WAV in its
 *    directory. The operator uploaded one file and was shown a confident
 *    classification of a different one. `buildAudioRunInput` refuses to
 *    produce a filename-less payload rather than leaving that reachable.
 */
import type { AudioResult, ScoredLabel } from '@camstack/types'
import { translate } from './i18n/index.js'

/**
 * The debug step key BOTH audio producers write.
 *
 * Ideally this constant would live in `@camstack/types` next to
 * `AudioResult` and be imported by the writers and this reader alike,
 * making the mismatch unrepresentable. It cannot yet: this page is a
 * Module-Federation remote that declares `@camstack/types` with
 * `import: false`, so it consumes the HOST's copy — a new `@camstack/types`
 * export type-checks here and is `undefined` at runtime until a
 * `@camstack/server` carrying it is installed. Until that train,
 * `packages/addon-benchmark/src/__tests__/audio-payloads.spec.ts` reads the
 * literal off both producers and asserts it equals this value.
 */
export const AUDIO_DEBUG_SOURCE = 'audio-analyzer'

export interface AudioRunRequest {
  readonly nodeId: string
  readonly addonId: string
  /** A reference WAV filename. Empty is a programming error, not a fallback. */
  readonly filename: string
  readonly settings: Readonly<Record<string, unknown>>
}

export interface AudioRunActionInput {
  readonly nodeId: string
  readonly addonId: string
  readonly modelId: string
  readonly filename: string
  readonly settings?: Readonly<Record<string, unknown>>
}

export function buildAudioRunInput(req: AudioRunRequest): AudioRunActionInput {
  if (!req.filename) {
    throw new Error(translate('audio.needsReference'))
  }
  return {
    nodeId: req.nodeId,
    addonId: req.addonId,
    modelId: '',
    filename: req.filename,
    ...(Object.keys(req.settings).length > 0 ? { settings: req.settings } : {}),
  }
}

export interface AudioDebugSelection {
  /** Full ranked list from `debug.alternateLabels`, regardless of `minScore`. */
  readonly alternateTopN: readonly ScoredLabel[]
  /** Per-step analyzer latency from `debug.stepTimings`. */
  readonly inferenceMs: number | undefined
  /** Wall clock from `debug.totalInferenceMs`. */
  readonly totalMs: number | undefined
}

export function selectAudioDebug(frame: AudioResult | undefined): AudioDebugSelection {
  const alternateTopN = frame?.detections?.[0]?.debug?.alternateLabels?.[AUDIO_DEBUG_SOURCE] ?? []
  const timing = frame?.debug?.stepTimings?.find((t) => t.source === AUDIO_DEBUG_SOURCE)
  return {
    alternateTopN,
    inferenceMs: timing?.ms,
    totalMs: frame?.debug?.totalInferenceMs,
  }
}
