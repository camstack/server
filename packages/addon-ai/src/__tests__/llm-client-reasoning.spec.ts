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

async function bodyFor(profile: ReturnType<typeof makeProfile>): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(JSON.stringify(CHAT_OK), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const client = createLlmClient({ fetchImpl })
  await client.generate({ profile, prompt: 'q', signal: new AbortController().signal }, 5_000)
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
    const body = await bodyFor(makeProfile({ kind: 'openai', apiKey: 'k', reasoningEffort: 'off' }))
    expect('reasoning_effort' in body).toBe(false)
  })
})

describe('reasoningEffort in the profile model', () => {
  it('is offered by openai-compatible only', () => {
    const offering = AI_KIND_DESCRIPTORS.filter((d) =>
      d.profileFields.includes('reasoningEffort'),
    ).map((d) => d.kind)
    expect(offering).toEqual(['openai-compatible'])
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
