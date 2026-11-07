/**
 * The LLM profiles this addon reads, taken from the ONE instance model: they are
 * `integration-instances` of the `ai` provider (functionCap `llm`), and the flat form values
 * carry the facts a picker or a vision gate needs. The `llm` cap keeps no profile read.
 */
import type { IntegrationInstance } from '@camstack/types'

const AI_ADDON_ID = 'ai'

/** The profile facts the retrain assist and the rule picker read. */
export interface LlmProfileFacts {
  readonly id: string
  readonly name: string
  readonly model: string
  readonly kind: string
  readonly baseUrl?: string
  readonly enabled: boolean
  readonly supportsVision: boolean
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The slice of `ctx.api` the read needs. */
export interface LlmProfileApi {
  readonly integrationInstances: {
    readonly listInstances: {
      query(input: { addonId: string }): Promise<readonly IntegrationInstance[]>
    }
  }
}

export async function listLlmProfileFacts(api: LlmProfileApi): Promise<readonly LlmProfileFacts[]> {
  const instances = await api.integrationInstances.listInstances.query({ addonId: AI_ADDON_ID })
  return instances.map((instance) => {
    const values = instance.formValues
    const baseUrl = text(values.baseUrl)
    return {
      id: instance.id,
      name: instance.name,
      model: text(values.model),
      kind: instance.kind ?? '',
      ...(baseUrl !== '' ? { baseUrl } : {}),
      enabled: instance.enabled !== false,
      supportsVision: values.supportsVision === true,
    }
  })
}
