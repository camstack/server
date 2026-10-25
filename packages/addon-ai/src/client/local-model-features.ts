/**
 * What a LOCAL OpenAI-compatible server says about its models, beyond the ids
 * `GET {base}/models` lists.
 *
 *   - llama.cpp (`llama-server`) puts `meta.n_ctx_train` on each `/v1/models`
 *     entry → `contextLength`. Nothing about vision or tools.
 *   - Ollama answers `/api/tags` at the server root; `POST /api/show` per model
 *     then reports `capabilities` (`vision`, `tools`, …) and
 *     `model_info["<arch>.context_length"]`. Mapping: `vision` ← "vision" in
 *     capabilities, `tools` ← "tools" in capabilities, `contextLength` ← the
 *     `*.context_length` entry. `streaming` is not reported and not claimed.
 *   - Anything else (LM Studio's OpenAI surface, vLLM, a proxy) reports nothing
 *     here: the ids stand alone and the kind's defaults apply.
 *
 * Enrichment is best-effort by construction: a probe that fails, times out or
 * answers something else leaves the model as listed. It never fails a list.
 */
import type { LlmModelFeatures, LlmModelInfo } from '@camstack/types'
import { z } from 'zod'
import { requestJson, type ListModelsOptions } from './list-models-http.js'

/** An OpenAI-wire `/models` entry, with the fields local servers add. */
export const OpenAiModelEntrySchema = z.object({
  id: z.string(),
  meta: z.object({ n_ctx_train: z.number().int().positive().optional() }).nullable().optional(),
})
export type OpenAiModelEntry = z.infer<typeof OpenAiModelEntrySchema>

export function openAiModelInfo(entry: OpenAiModelEntry): LlmModelInfo {
  const contextLength = entry.meta?.n_ctx_train
  return {
    id: entry.id,
    ...(contextLength !== undefined ? { contextLength } : {}),
  }
}

const OllamaTagsSchema = z.object({
  models: z.array(z.object({ name: z.string() })),
})

const OllamaShowSchema = z.object({
  capabilities: z.array(z.string()).optional(),
  model_info: z.record(z.string(), z.unknown()).optional(),
})
type OllamaShow = z.infer<typeof OllamaShowSchema>

/** `/api/show` is one request per model; a server with hundreds is not probed past this. */
const MAX_SHOW_PROBES = 64
/** Probes in flight at once — a laptop Ollama answers these from disk. */
const SHOW_CONCURRENCY = 4

/** The server root of an OpenAI-compatible base (`http://h:11434/v1` → `http://h:11434`). */
export function serverRootOf(base: string): string | null {
  if (base.endsWith('/v1')) return base.slice(0, -'/v1'.length)
  try {
    return new URL(base).origin
  } catch {
    return null
  }
}

function contextLengthOf(show: OllamaShow): number | undefined {
  for (const [key, value] of Object.entries(show.model_info ?? {})) {
    if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
      return Math.trunc(value)
    }
  }
  return undefined
}

function featuresOf(show: OllamaShow): Partial<LlmModelFeatures> | undefined {
  const caps = show.capabilities
  if (caps === undefined) return undefined
  return { vision: caps.includes('vision'), tools: caps.includes('tools') }
}

function merged(model: LlmModelInfo, show: OllamaShow): LlmModelInfo {
  const contextLength = contextLengthOf(show) ?? model.contextLength
  const features = featuresOf(show)
  return {
    ...model,
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(features !== undefined ? { features: { ...model.features, ...features } } : {}),
  }
}

async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))))
  }
  return out
}

/**
 * The models, with what an Ollama server reports about each. Not an Ollama
 * server (no `/api/tags`) → the models unchanged.
 */
export async function withOllamaFeatures(
  base: string,
  models: readonly LlmModelInfo[],
  headers: Record<string, string>,
  secret: string | undefined,
  opts: ListModelsOptions,
): Promise<LlmModelInfo[]> {
  const root = serverRootOf(base)
  if (root === null || models.length === 0) return [...models]
  const tags = await requestJson(
    `${root}/api/tags`,
    { method: 'GET', headers },
    OllamaTagsSchema,
    secret,
    opts,
  )
  if (!tags.ok) return [...models]
  const probed = models.slice(0, MAX_SHOW_PROBES)
  const shown = await mapBounded(probed, SHOW_CONCURRENCY, (m) =>
    requestJson(
      `${root}/api/show`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ model: m.id }),
      },
      OllamaShowSchema,
      secret,
      opts,
    ),
  )
  return models.map((m, i) => {
    const show = shown[i]
    return show !== undefined && show.ok ? merged(m, show.body) : m
  })
}
