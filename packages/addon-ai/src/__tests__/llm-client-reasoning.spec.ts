/**
 * `reasoningEffort` is asserted on the BYTES sent: a profile that says "thinking
 * off" must reach the server as `reasoning_effort: "none"`, or a thinking model
 * spends the whole completion on reasoning and returns an empty `content`.
 */
import { LlmProfileFieldSchema, LlmProfileSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { createLlmClient } from '../client/llm-client.js'
import { AI_KIND_DESCRIPTORS } from '../kinds/descriptors.js'
import { makeProfile } from './support/profile.js'

const CHAT_OK = {
  id: 'x',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
}

const ANTHROPIC_OK = {
  id: 'x',
  type: 'message',
  role: 'assistant',
  model: 'm',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
}

const GOOGLE_OK = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
}

function okFor(kind: string): unknown {
  if (kind === 'anthropic') return ANTHROPIC_OK
  if (kind === 'google') return GOOGLE_OK
  return CHAT_OK
}

async function bodyFor(
  profile: ReturnType<typeof makeProfile>,
  call: { readonly reasoningEffort?: 'off' | 'low' | 'medium' | 'high' } = {},
): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(JSON.stringify(okFor(profile.kind)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const client = createLlmClient({ fetchImpl })
  await client.generate(
    { profile, prompt: 'q', ...call, signal: new AbortController().signal },
    5_000,
  )
  return bodies[0] ?? {}
}

describe('reasoningEffort on the wire', () => {
  it('off is sent as reasoning_effort "none" on the openai-compatible wire', async () => {
    expect((await bodyFor(makeProfile({ reasoningEffort: 'off' }))).reasoning_effort).toBe('none')
  })

  it('an effort is sent as is', async () => {
    expect((await bodyFor(makeProfile({ reasoningEffort: 'high' }))).reasoning_effort).toBe('high')
  })

  it('omitted sends no reasoning_effort', async () => {
    expect('reasoning_effort' in (await bodyFor(makeProfile()))).toBe(false)
  })

  it('a kind whose descriptor does not offer the field never sends it', async () => {
    const body = await bodyFor(
      makeProfile({ kind: 'openai', apiKey: 'k', model: 'gpt-4o', reasoningEffort: 'off' }),
    )
    expect('reasoning_effort' in body).toBe(false)
  })
})

describe('a per-call reasoningEffort', () => {
  it('beats the profile', async () => {
    const body = await bodyFor(makeProfile({ reasoningEffort: 'high' }), { reasoningEffort: 'off' })
    expect(body.reasoning_effort).toBe('none')
  })

  it('applies when the profile says nothing', async () => {
    expect((await bodyFor(makeProfile(), { reasoningEffort: 'low' })).reasoning_effort).toBe('low')
  })

  it('is not sent to a kind that does not offer it', async () => {
    const body = await bodyFor(makeProfile({ kind: 'openai', apiKey: 'k' }), {
      reasoningEffort: 'off',
    })
    expect('reasoning_effort' in body).toBe(false)
  })
})

describe('reasoning on the cloud wires', () => {
  it('anthropic: off sends thinking disabled', async () => {
    const body = await bodyFor(
      makeProfile({ kind: 'anthropic', apiKey: 'k', reasoningEffort: 'off' }),
    )
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('anthropic: an effort enables thinking with a budget', async () => {
    const body = await bodyFor(makeProfile({ kind: 'anthropic', apiKey: 'k' }), {
      reasoningEffort: 'medium',
    })
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
  })

  it('anthropic: omitted sends no thinking field', async () => {
    const body = await bodyFor(makeProfile({ kind: 'anthropic', apiKey: 'k' }))
    expect('thinking' in body).toBe(false)
  })

  it('google: off sends a thinking budget of 0', async () => {
    const body = await bodyFor(makeProfile({ kind: 'google', apiKey: 'k', reasoningEffort: 'off' }))
    expect(body.generationConfig).toMatchObject({ thinkingConfig: { thinkingBudget: 0 } })
  })

  it('google: omitted sends no thinkingConfig', async () => {
    const body = await bodyFor(makeProfile({ kind: 'google', apiKey: 'k' }))
    expect(JSON.stringify(body)).not.toContain('thinkingConfig')
  })

  it('openai cloud: a reasoning model gets reasoning_effort, a chat model never', async () => {
    const reasoning = await bodyFor(
      makeProfile({ kind: 'openai', apiKey: 'k', model: 'o3-mini', reasoningEffort: 'low' }),
    )
    expect(reasoning.reasoning_effort).toBe('low')
    const chat = await bodyFor(
      makeProfile({ kind: 'openai', apiKey: 'k', model: 'gpt-4o', reasoningEffort: 'low' }),
    )
    expect('reasoning_effort' in chat).toBe(false)
  })

  it('a kind that does not offer reasoning never sends it, even per call', async () => {
    const body = await bodyFor(makeProfile({ kind: 'managed-local' }), { reasoningEffort: 'high' })
    expect(JSON.stringify(body)).not.toMatch(/reasoning|thinking/)
  })
})

describe('reasoningEffort in the profile model', () => {
  it('is offered by the kinds with a reasoning wire, and by no other', () => {
    const offering = AI_KIND_DESCRIPTORS.filter((d) =>
      d.profileFields.includes('reasoningEffort'),
    ).map((d) => d.kind)
    expect(offering.sort()).toEqual(['anthropic', 'google', 'openai', 'openai-compatible'])
  })

  it('is a known profile field', () => {
    expect(LlmProfileFieldSchema.safeParse('reasoningEffort').success).toBe(true)
  })

  it('round-trips through the profile schema and rejects unknown values', () => {
    expect(makeProfile({ reasoningEffort: 'off' }).reasoningEffort).toBe('off')
    expect(makeProfile().reasoningEffort).toBeUndefined()
    expect(LlmProfileSchema.safeParse({ ...makeProfile(), reasoningEffort: 'max' }).success).toBe(
      false,
    )
  })
})
