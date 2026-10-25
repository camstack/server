/**
 * Reading the two JSON columns the review rests on — an annotation's `origin`
 * and a frame's `dismissed` set — back into typed values.
 *
 * Parsed with the cap's own schemas rather than cast: a column written by
 * something that bypassed the guard reads as "no origin" / "nothing dismissed",
 * which is the safe direction (a missing snapshot makes a verdict approximate;
 * it never invents one).
 */
import {
  type NativeCropBbox,
  type RetrainDismissed,
  RetrainDismissedSchema,
  type RetrainMacroClass,
  type RetrainOrigin,
  RetrainOriginSchema,
  type RetrainPipelineBox,
} from '@camstack/types'

function parseJsonIfText(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

/** The stored origin snapshot, or `null` (legacy row / unreadable value). */
export function narrowOrigin(value: unknown): RetrainOrigin | null {
  const parsed = RetrainOriginSchema.safeParse(parseJsonIfText(value))
  return parsed.success ? parsed.data : null
}

/** The stored dismissed set, or an empty list. */
export function narrowDismissed(value: unknown): readonly RetrainDismissed[] {
  const parsed = RetrainDismissedSchema.array().safeParse(parseJsonIfText(value))
  return parsed.success ? parsed.data : []
}

/**
 * The stable name of a pipeline box inside its frame. One live track draws one
 * box on a frame, and the track id survives a re-derivation, which is what lets
 * a dismissal made today still match tomorrow's list.
 */
export function pipelineOriginRef(trackId: string): string {
  return `pipeline:${trackId}`
}

/** A re-derived pipeline box as the snapshot an annotation or dismissal keeps. */
export function pipelineBoxOrigin(box: RetrainPipelineBox): RetrainOrigin {
  return {
    source: 'pipeline',
    ref: pipelineOriginRef(box.trackId),
    bbox: box.bbox,
    macroClass: box.macroClass,
    ...(box.label !== undefined ? { label: box.label } : {}),
    ...(box.score !== undefined ? { score: box.score } : {}),
    ...(box.modelId !== undefined ? { modelId: box.modelId } : {}),
  }
}

/** The fields of a machine proposal an `origin` snapshot keeps. */
export interface ProposalFacts {
  readonly bbox: NativeCropBbox
  readonly macroClass: RetrainMacroClass
  readonly label?: string
  readonly score?: number
  readonly modelId?: string
}

/** The n-th proposal of a detector (`assist`) or vision-LLM (`llm`) run. */
export function proposalOrigin(
  source: 'assist' | 'llm',
  index: number,
  facts: ProposalFacts,
): RetrainOrigin {
  return {
    source,
    ref: `${source}:${String(index)}`,
    bbox: facts.bbox,
    macroClass: facts.macroClass,
    ...(facts.label !== undefined ? { label: facts.label } : {}),
    ...(facts.score !== undefined ? { score: facts.score } : {}),
    ...(facts.modelId !== undefined ? { modelId: facts.modelId } : {}),
  }
}
