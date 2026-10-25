/**
 * Anthropic's `GET /v1/models` model object, and what it says about the
 * features a profile cares about.
 *
 * The mapping, per field of `LlmModelFeatures`:
 *
 *   - `vision`    ← `capabilities.image_input.supported` (reported per model).
 *   - `tools`     ← NOT reported: the capability tree has no client-tool key
 *                   (`server_tools` is web search / code execution, a different
 *                   thing). Fallback: `true` — every model on the Messages API
 *                   accepts client tools.
 *   - `streaming` ← NOT reported. Fallback: `true` — every model on the
 *                   Messages API streams.
 *   - `contextLength` ← `max_input_tokens` (the context window).
 *
 * A model whose `capabilities` is `null` claims nothing: the kind's defaults
 * apply, field by field, in the editor. The tree also reports thinking, effort,
 * PDF input and structured outputs; the cap has no flag for them, so they are
 * not carried.
 */
import type { LlmModelInfo } from '@camstack/types'
import { z } from 'zod'

const Supported = z.object({ supported: z.boolean() })

const AnthropicCapabilitiesSchema = z.object({
  image_input: Supported.optional(),
})

export const AnthropicModelSchema = z.object({
  id: z.string(),
  display_name: z.string().optional(),
  lifecycle: z.string().optional(),
  max_input_tokens: z.number().int().positive().nullable().optional(),
  capabilities: AnthropicCapabilitiesSchema.nullable().optional(),
})
export type AnthropicModel = z.infer<typeof AnthropicModelSchema>

export const AnthropicModelsPageSchema = z.object({
  data: z.array(AnthropicModelSchema),
  has_more: z.boolean().optional(),
  last_id: z.string().nullable().optional(),
})

/** Every Messages-API model takes client tools and streams; the tree does not say so. */
const MESSAGES_API_TOOLS = true
const MESSAGES_API_STREAMING = true

function labelOf(m: AnthropicModel): string | undefined {
  if (m.display_name === undefined) return undefined
  return m.lifecycle === 'deprecated' ? `${m.display_name} (deprecated)` : m.display_name
}

export function anthropicModelInfo(m: AnthropicModel): LlmModelInfo {
  const label = labelOf(m)
  const contextLength = m.max_input_tokens ?? undefined
  const vision = m.capabilities?.image_input?.supported
  return {
    id: m.id,
    ...(label !== undefined ? { label } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(vision !== undefined
      ? {
          features: {
            vision,
            tools: MESSAGES_API_TOOLS,
            streaming: MESSAGES_API_STREAMING,
          },
        }
      : {}),
  }
}
