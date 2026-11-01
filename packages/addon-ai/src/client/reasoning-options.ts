/**
 * How "how hard to think" reaches each wire. One function per vendor shape, and
 * a kind whose descriptor does not list `reasoningEffort` never gets one — the
 * editor, the descriptor and the bytes sent agree because they read the same
 * list.
 *
 *   - openai-compatible (LM Studio, llama-server, Ollama /v1): `reasoning_effort`,
 *     `off` is the wire's `none` (measured to switch thinking off).
 *   - openai cloud: `reasoning_effort`, only for a model id that names a
 *     reasoning family (the cloud rejects it elsewhere). The o-series cannot be
 *     switched off, so `off` sends nothing there; `gpt-5` takes `minimal`.
 *   - anthropic: `thinking` — `off` is `{ type: 'disabled' }`, an effort is an
 *     enabled block with a token budget.
 *   - google: `thinkingConfig.thinkingBudget` — 0 is off.
 */
import type { LlmProfile } from '@camstack/types'
import { descriptorOf } from '../kinds/descriptors.js'
import { openAiReasoningOf } from './local-model-features.js'

export type LlmReasoningEffort = NonNullable<LlmProfile['reasoningEffort']>

/** A provider-options value as the library's JSON wire accepts it. */
export type WireValue = string | number | { readonly [key: string]: WireValue }

export type ProviderOptions = Record<string, Record<string, WireValue>>

const ANTHROPIC_BUDGET: Record<Exclude<LlmReasoningEffort, 'off'>, number> = {
  low: 1024,
  medium: 4096,
  high: 16_000,
}

const GOOGLE_BUDGET: Record<LlmReasoningEffort, number> = {
  off: 0,
  low: 1024,
  medium: 8192,
  high: 24_576,
}

/** `openai-compatible` -> `openaiCompatible`, the provider-options key. */
function providerOptionsKeyOf(kind: string): string {
  return kind.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
}

export function reasoningProviderOptions(
  profile: LlmProfile,
  callEffort: LlmReasoningEffort | undefined,
): ProviderOptions | undefined {
  const effort = callEffort ?? profile.reasoningEffort
  if (effort === undefined) return undefined
  if (descriptorOf(profile.kind)?.profileFields.includes('reasoningEffort') !== true) {
    return undefined
  }
  switch (profile.kind) {
    case 'anthropic':
      return {
        anthropic: {
          thinking:
            effort === 'off'
              ? { type: 'disabled' }
              : { type: 'enabled', budgetTokens: ANTHROPIC_BUDGET[effort] },
        },
      }
    case 'google':
      return { google: { thinkingConfig: { thinkingBudget: GOOGLE_BUDGET[effort] } } }
    case 'openai': {
      if (openAiReasoningOf(profile.model) !== true) return undefined
      if (effort === 'off') {
        return profile.model.startsWith('gpt-5')
          ? { openai: { reasoningEffort: 'minimal' } }
          : undefined
      }
      return { openai: { reasoningEffort: effort } }
    }
    default:
      return {
        [providerOptionsKeyOf(profile.kind)]: {
          reasoningEffort: effort === 'off' ? 'none' : effort,
        },
      }
  }
}
