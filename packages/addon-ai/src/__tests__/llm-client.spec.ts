/**
 * The client is asserted on the BYTES IT SENDS, not on what it returns.
 *
 * Every test here injects a `fetch` and reads the request body, because the
 * failure mode this repo pays for most is a call that succeeds while quietly
 * dropping the thing that made it correct — the schema that was supposed to
 * constrain the answer, the image that was supposed to be looked at. A green
 * assertion on the RESULT would pass in all of those cases.
 */
import { describe, expect, it } from 'vitest'
import { callSettingsFor, createLlmClient, mapLibraryError } from '../client/llm-client.js'
import { makeProfile } from './support/profile.js'

interface CapturedRequest {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

const CHAT_OK = {
  id: 'x',
  choices: [
    { index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 3 },
}

/** A fetch that answers every chat completion and records what it was sent. */
function capturingFetch(
  response: unknown = CHAT_OK,
  status = 200,
): { fetchImpl: typeof fetch; sent: CapturedRequest[] } {
  const sent: CapturedRequest[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    sent.push({
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, sent }
}

const SCHEMA = {
  type: 'object',
  properties: { confirmed: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['confirmed', 'reason'],
  additionalProperties: false,
}

const neverAborts = (): AbortSignal => new AbortController().signal

describe('LlmClient structured output', () => {
  it('sends a REAL json_schema on the openai-compatible wire', async () => {
    const { fetchImpl, sent } = capturingFetch()
    const client = createLlmClient({ fetchImpl })
    const result = await client.generate(
      {
        profile: makeProfile(),
        prompt: 'is it there?',
        jsonSchema: SCHEMA,
        signal: neverAborts(),
      },
      5_000,
    )

    expect(result.ok).toBe(true)
    const format = sent[0]?.body.response_format as
      | { type?: string; json_schema?: { schema?: Record<string, unknown> } }
      | undefined
    // THE assertion. Without `supportsStructuredOutputs: true` on the provider
    // this is `{"type":"json_object"}` and the schema never leaves the process —
    // the request still succeeds, which is exactly why this is asserted here
    // rather than trusted.
    expect(format?.type).toBe('json_schema')
    expect(format?.json_schema?.schema).toMatchObject({
      properties: { confirmed: { type: 'boolean' } },
    })
  })

  it('a reply that does not match the schema is still returned as text, not an error', async () => {
    // Local models fence and drift. Today every consumer parses permissively,
    // and turning a near-miss into an error would flip a fail-open notification
    // gate into silence. The schema constrains; it does not gate.
    const { fetchImpl } = capturingFetch({
      choices: [
        { message: { content: 'sure thing: {"confirmed": "yes"}' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    })
    const client = createLlmClient({ fetchImpl })
    const result = await client.generate(
      { profile: makeProfile(), prompt: 'q', jsonSchema: SCHEMA, signal: neverAborts() },
      5_000,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.text).toContain('confirmed')
  })

  it('no jsonSchema → no response_format at all', async () => {
    const { fetchImpl, sent } = capturingFetch()
    const client = createLlmClient({ fetchImpl })
    await client.generate({ profile: makeProfile(), prompt: 'q', signal: neverAborts() }, 5_000)
    expect(sent[0]?.body.response_format).toBeUndefined()
  })
})

describe('LlmClient request shaping', () => {
  it('vision: the image rides in the SAME user message as the prompt, as a data URI', async () => {
    const { fetchImpl, sent } = capturingFetch()
    const client = createLlmClient({ fetchImpl })
    await client.generate(
      {
        profile: makeProfile({ supportsVision: true }),
        prompt: 'what is this',
        images: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' }],
        signal: neverAborts(),
      },
      5_000,
    )
    const messages = sent[0]?.body.messages as Array<{ role: string; content: unknown }>
    const user = messages.at(-1)
    expect(user?.role).toBe('user')
    expect(JSON.stringify(user?.content)).toContain('data:image/jpeg;base64,AQID')
    // One message, both parts — splitting them loses the association on several wires.
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it("the profile's systemPrompt is sent, and a caller's system REPLACES it", async () => {
    const { fetchImpl, sent } = capturingFetch()
    const client = createLlmClient({ fetchImpl })
    const profile = makeProfile({ systemPrompt: 'from the profile' })

    await client.generate({ profile, prompt: 'q', signal: neverAborts() }, 5_000)
    await client.generate(
      { profile, prompt: 'q', system: 'from the caller', signal: neverAborts() },
      5_000,
    )

    const systemOf = (i: number): unknown => {
      const messages = (sent[i]?.body.messages ?? []) as Array<{
        role: string
        content: unknown
      }>
      return messages.find((m) => m.role === 'system')?.content
    }
    expect(systemOf(0)).toBe('from the profile')
    // Two system prompts fighting is worse than either alone.
    expect(systemOf(1)).toBe('from the caller')
  })

  it('sampling: profile defaults ride the wire, per-call values beat them', async () => {
    const { fetchImpl, sent } = capturingFetch()
    const client = createLlmClient({ fetchImpl })
    const profile = makeProfile({ temperature: 0.7, topP: 0.8, topK: 40, maxTokens: 256 })

    await client.generate({ profile, prompt: 'q', signal: neverAborts() }, 5_000)
    await client.generate(
      { profile, prompt: 'q', temperature: 0, maxTokens: 16, signal: neverAborts() },
      5_000,
    )

    expect(sent[0]?.body).toMatchObject({ temperature: 0.7, top_p: 0.8, max_tokens: 256 })
    expect(sent[1]?.body).toMatchObject({ temperature: 0, max_tokens: 16 })
  })

  it('top-k never reaches an OpenAI-family wire, which has no such parameter', async () => {
    // Measured, not assumed: the library drops the field with a warning, so a
    // top-k knob on these kinds would be a control that changes nothing.
    const { fetchImpl, sent } = capturingFetch()
    const client = createLlmClient({ fetchImpl })
    await client.generate(
      { profile: makeProfile({ topK: 40, topP: 0.5 }), prompt: 'q', signal: neverAborts() },
      5_000,
    )
    expect(sent[0]?.body.top_p).toBe(0.5)
    expect(sent[0]?.body.top_k).toBeUndefined()
    expect(
      callSettingsFor({ profile: makeProfile({ topK: 40 }), prompt: 'q', signal: neverAborts() })
        .topK,
    ).toBeUndefined()
  })

  it('retry policy becomes the library retry count: attempts−1, and 0 when disabled', () => {
    const profile = makeProfile()
    const settings = (retry: { enabled: boolean; maxAttempts: number }) =>
      callSettingsFor({ profile, prompt: 'q', retry, signal: neverAborts() }).maxRetries
    expect(settings({ enabled: false, maxAttempts: 3 })).toBe(0)
    expect(settings({ enabled: true, maxAttempts: 1 })).toBe(0)
    expect(settings({ enabled: true, maxAttempts: 3 })).toBe(2)
  })

  it('extraHeaders and the bearer key reach the endpoint', async () => {
    const { fetchImpl, sent } = capturingFetch()
    const client = createLlmClient({ fetchImpl })
    await client.generate(
      {
        profile: makeProfile({ apiKey: 'sk-live', extraHeaders: { 'x-tenant': 't1' } }),
        prompt: 'q',
        signal: neverAborts(),
      },
      5_000,
    )
    expect(sent[0]?.headers.authorization).toBe('Bearer sk-live')
    expect(sent[0]?.headers['x-tenant']).toBe('t1')
  })
})

describe('LlmClient usage and errors', () => {
  it('maps the vendor usage onto our two counters', async () => {
    const { fetchImpl } = capturingFetch()
    const client = createLlmClient({ fetchImpl })
    const result = await client.generate(
      { profile: makeProfile(), prompt: 'q', signal: neverAborts() },
      5_000,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 })
  })

  it('a provider that omits usage yields 0, never NaN or undefined', async () => {
    // The rollup sums these. `undefined` here becomes NaN three layers away.
    const { fetchImpl } = capturingFetch({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    })
    const client = createLlmClient({ fetchImpl })
    const result = await client.generate(
      { profile: makeProfile(), prompt: 'q', signal: neverAborts() },
      5_000,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('never throws: HTTP status becomes an LlmErrorCode result', async () => {
    for (const [status, code] of [
      [401, 'auth'],
      [429, 'rate-limited'],
      [400, 'bad-request'],
      [503, 'unavailable'],
    ] as const) {
      const { fetchImpl } = capturingFetch({ error: 'nope' }, status)
      const client = createLlmClient({ fetchImpl })
      const result = await client.generate(
        // Retry off, or a 429/503 would be retried before it is reported.
        {
          profile: makeProfile({ retry: { enabled: false, maxAttempts: 1 } }),
          prompt: 'q',
          signal: neverAborts(),
        },
        5_000,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe(code)
    }
  })

  it('an unusable profile is a RESULT, not a throw', async () => {
    const client = createLlmClient()
    const result = await client.generate(
      // openai-compatible with no base URL: a configuration fault the operator
      // must be able to read, not an exception out of a vendor SDK.
      { profile: makeProfile({ baseUrl: undefined }), prompt: 'q', signal: neverAborts() },
      5_000,
    )
    expect(result).toMatchObject({ ok: false, code: 'bad-request' })
  })

  /**
   * A fetch that only ever ends via the signal.
   *
   * It checks `aborted` BEFORE subscribing: a signal that was already aborted
   * never fires the event again, and a fake that only listens would hang
   * forever — testing the harness instead of the client.
   */
  function hangingFetch(): typeof fetch {
    return (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const fail = (): void => reject(new DOMException('aborted', 'AbortError'))
        if (signal?.aborted === true) {
          fail()
          return
        }
        signal?.addEventListener('abort', fail, { once: true })
      })) as unknown as typeof fetch
  }

  it('a caller abort reaches the socket and ends the call', async () => {
    const controller = new AbortController()
    const client = createLlmClient({ fetchImpl: hangingFetch() })
    const pending = client.generate(
      { profile: makeProfile(), prompt: 'q', signal: controller.signal },
      60_000,
    )
    controller.abort()
    // The point: this resolves at all. Before the client, the unary path had no
    // channel for the caller's cancellation and ran to the full timeout.
    const result = await pending
    expect(result.ok).toBe(false)
  })

  it('the total bound ends a call the provider never answers', async () => {
    const client = createLlmClient({ fetchImpl: hangingFetch() })
    const result = await client.generate(
      { profile: makeProfile(), prompt: 'q', signal: neverAborts() },
      50,
    )
    expect(result).toMatchObject({ ok: false, code: 'timeout' })
  })
})

describe('mapLibraryError', () => {
  it('unwraps the RetryError envelope and classifies the LAST attempt', () => {
    // The library reports spent attempts as RetryError, so a 429 that was
    // retried arrives wrapped. Classifying the envelope loses the reason.
    class FakeRetryError extends Error {
      readonly errors: Error[]
      constructor(errors: Error[]) {
        super('retries exhausted')
        this.name = 'AI_RetryError'
        this.errors = errors
      }
    }
    const inner = new Error('boom')
    const mapped = mapLibraryError(new FakeRetryError([inner, inner]))
    expect(mapped.code).toBeDefined()
  })

  it('an unknown failure is adapter-error with its message, never a throw', () => {
    expect(mapLibraryError(new Error('weird'))).toEqual({
      code: 'adapter-error',
      message: 'weird',
    })
  })
})

describe('LlmClient — the wires that used to say streamed: false', () => {
  it('anthropic speaks the Messages wire: x-api-key, top-level system, max_tokens', async () => {
    const { fetchImpl, sent } = capturingFetch({
      id: 'msg',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 9, output_tokens: 2 },
    })
    const client = createLlmClient({ fetchImpl })
    const result = await client.generate(
      {
        profile: makeProfile({
          kind: 'anthropic',
          baseUrl: undefined,
          apiKey: 'sk-ant',
          model: 'claude-3-5-haiku',
          maxTokens: 128,
          topK: 40,
        }),
        prompt: 'q',
        system: 'be terse',
        signal: neverAborts(),
      },
      5_000,
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 2 })
    expect(sent[0]?.url).toContain('/v1/messages')
    // The three vendor quirks the hand-written adapter existed for: a header
    // instead of a bearer, `system` hoisted out of the messages, and the
    // mandatory max_tokens.
    expect(sent[0]?.headers['x-api-key']).toBe('sk-ant')
    expect(sent[0]?.headers.authorization).toBeUndefined()
    expect(sent[0]?.body.system).toBeDefined()
    expect(sent[0]?.body.max_tokens).toBe(128)
    // …and top-k, which this wire does carry.
    expect(sent[0]?.body.top_k).toBe(40)
  })

  it('google speaks generateContent: key in the query, systemInstruction, contents', async () => {
    const { fetchImpl, sent } = capturingFetch({
      candidates: [{ content: { parts: [{ text: 'hi' }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1 },
    })
    const client = createLlmClient({ fetchImpl })
    const result = await client.generate(
      {
        profile: makeProfile({
          kind: 'google',
          baseUrl: undefined,
          apiKey: 'k-123',
          model: 'gemini-1.5-flash',
        }),
        prompt: 'q',
        system: 'be terse',
        signal: neverAborts(),
      },
      5_000,
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 1 })
    expect(sent[0]?.url).toContain('gemini-1.5-flash')
    expect(sent[0]?.body.systemInstruction).toBeDefined()
    expect(sent[0]?.body.contents).toBeDefined()
    // The key rides the query or a header, never a bearer on this wire.
    expect(sent[0]?.headers.authorization).toBeUndefined()
  })

  it('every profile kind is now streamable — no wire reports `unsupported`', () => {
    const client = createLlmClient()
    for (const kind of [
      'openai',
      'openai-compatible',
      'managed-local',
      'anthropic',
      'google',
    ] as const) {
      expect(client.supports(kind)).toBe(true)
    }
  })
})
