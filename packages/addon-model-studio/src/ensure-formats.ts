/**
 * Ensure OpenVINO / CoreML exist for an ONNX-backed Library model, then
 * optionally distribute every declared format to agents.
 *
 * Used by Custom import, plus catalog import, and Library "Distribute to all".
 */
import type { ConvertArtifact, ModelCatalogEntry, ModelFormat } from '@camstack/types'
import {
  runPlusConversions,
  type PlusConversionDeps,
  type PlusConversionOutcome,
  type PlusConvertibleFormat,
} from './plus-catalog/plus-conversion.js'

const ENGINE_FORMATS: readonly PlusConvertibleFormat[] = ['openvino', 'coreml']

export function missingEngineFormats(entry: ModelCatalogEntry): readonly PlusConvertibleFormat[] {
  return ENGINE_FORMATS.filter((f) => entry.formats[f] === undefined)
}

export async function ensureEngineFormats(
  entry: ModelCatalogEntry,
  deps: PlusConversionDeps,
  opts: { readonly targetFormats?: readonly PlusConvertibleFormat[] } = {},
): Promise<{ entry: ModelCatalogEntry; conversions: readonly PlusConversionOutcome[] }> {
  if (entry.formats.onnx === undefined) {
    return { entry, conversions: [] }
  }
  const wanted = opts.targetFormats ?? ENGINE_FORMATS
  const missing = wanted.filter((f) => entry.formats[f] === undefined)
  if (missing.length === 0) return { entry, conversions: [] }
  const conversions = await runPlusConversions(deps, {
    entry,
    targetFormats: missing,
  })
  // upsertEntry inside runPlusConversions merges formats; caller reloads entry.
  return { entry, conversions }
}

export interface DistributeFormatResult {
  readonly nodeId: string
  readonly format: ModelFormat
  readonly ok: boolean
  readonly error?: string
  readonly bytes?: number
}

export interface EnsureThenDistributeDeps extends PlusConversionDeps {
  getEntry(): Promise<ModelCatalogEntry | undefined>
  listAgentNodeIds(): Promise<readonly string[]>
  distribute(
    modelId: string,
    nodeId: string,
    format: ModelFormat,
  ): Promise<{ sha256: string; bytes: number }>
}

/**
 * Ensure OV/CoreML from ONNX when missing, then push every declared format to
 * every agent (hub is skipped — it already hosts imports).
 */
export async function ensureFormatsThenDistribute(
  modelId: string,
  deps: EnsureThenDistributeDeps,
): Promise<{
  conversions: readonly PlusConversionOutcome[]
  distributed: readonly DistributeFormatResult[]
}> {
  const initial = await deps.getEntry()
  if (initial === undefined) {
    throw new Error(`ensureFormatsThenDistribute: model "${modelId}" is not registered`)
  }

  let conversions: readonly PlusConversionOutcome[] = []
  if (initial.formats.onnx !== undefined && missingEngineFormats(initial).length > 0) {
    const ensured = await ensureEngineFormats(initial, deps)
    conversions = ensured.conversions
  }

  const entry = (await deps.getEntry()) ?? initial
  const formats = (Object.keys(entry.formats) as ModelFormat[]).filter(
    (f) => entry.formats[f] !== undefined,
  )
  const agents = await deps.listAgentNodeIds()
  const distributed: DistributeFormatResult[] = []

  for (const nodeId of agents) {
    for (const format of formats) {
      try {
        const res = await deps.distribute(modelId, nodeId, format)
        distributed.push({ nodeId, format, ok: true, bytes: res.bytes })
      } catch (err) {
        distributed.push({
          nodeId,
          format,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  return { conversions, distributed }
}

/** Summarize conversion outcomes for operator-facing copy. */
export function summarizeConversionOutcomes(outcomes: readonly PlusConversionOutcome[]): string {
  if (outcomes.length === 0) return ''
  const parts = outcomes.map((o) =>
    o.ok
      ? `${o.format} ✓${o.nodeId ? ` (${o.nodeId})` : ''}`
      : `${o.format} ✗ — ${o.error ?? 'failed'}`,
  )
  return ` Engine conversions: ${parts.join('; ')}.`
}

export type { ConvertArtifact }
