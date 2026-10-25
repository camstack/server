/**
 * `listHttpModels` against the list responses each vendor documents, kept as
 * fixtures under `fixtures/list-models/` (shapes from the vendors' API
 * references; ids and numbers are illustrative, no live call is made and no key
 * is real):
 *
 *   - Anthropic `GET /v1/models`: every page is followed, and each model's
 *     features come from its own `capabilities` / `max_input_tokens`.
 *   - A vendor's refusal (a 400) names the vendor's reason, never only a status.
 *   - Local OpenAI-compatible servers: Ollama (`/api/tags` + `/api/show`) and
 *     llama.cpp (`meta.n_ctx_train`) report what a model can do; a plain
 *     server that reports nothing keeps the bare ids.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { listHttpModels } from '../client/list-models.js'

const KEY = 'fake-fixture-key-0003'
const OPTS = { timeoutMs: 1000 }

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/list-models/${name}`, import.meta.url), 'utf8')
}

interface Call {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  readonly body: string | null
}

type Route = (call: Call) => Response | null

const jsonOf = (text: string, status = 200): Response =>
  new Response(text, {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** A fetch that answers from the first route that claims the call; 404 otherwise. */
function routed(...routes: readonly Route[]) {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = typeof init?.body === 'string' ? init.body : null
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: new Headers(init?.headers),
      body,
    }
    calls.push(call)
    for (const route of routes) {
      const answer = route(call)
      if (answer !== null) return answer
    }
    return new Response('404 page not found', { status: 404 })
  }
  return { calls, fetchImpl }
}

describe('Anthropic — GET /v1/models', () => {
  const pages: Route = (call) => {
    if (!call.url.startsWith('https://api.anthropic.com/v1/models?')) return null
    return call.url.includes('after_id=claude-haiku-4-5')
      ? jsonOf(fixture('anthropic-models-page2.json'))
      : jsonOf(fixture('anthropic-models-page1.json'))
  }

  it('follows every page with after_id and the documented headers', async () => {
    const { calls, fetchImpl } = routed(pages)
    const result = await listHttpModels('anthropic', { apiKey: KEY }, { ...OPTS, fetchImpl })
    expect(result.ok).toBe(true)
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.anthropic.com/v1/models?limit=1000',
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-haiku-4-5',
    ])
    for (const call of calls) {
      expect(call.method).toBe('GET')
      expect(call.headers.get('x-api-key')).toBe(KEY)
      expect(call.headers.get('anthropic-version')).toBe('2023-06-01')
      expect(call.headers.get('authorization')).toBeNull()
      expect(call.url).not.toContain(KEY)
    }
    expect(result.ok && result.models.map((m) => m.id)).toEqual([
      'claude-opus-5-5',
      'claude-haiku-4-5',
      'claude-example-text-only',
      'claude-example-unknown-caps',
    ])
  })

  it("loads each model's features from its own capability tree", async () => {
    const { fetchImpl } = routed(pages)
    const result = await listHttpModels('anthropic', { apiKey: KEY }, { ...OPTS, fetchImpl })
    if (!result.ok) throw new Error(result.message)
    const [opus, haiku, textOnly, unknown] = result.models
    expect(opus).toEqual({
      id: 'claude-opus-5-5',
      label: 'Claude Opus 5.5',
      contextLength: 1_000_000,
      features: { vision: true, tools: true, streaming: true },
    })
    expect(haiku).toMatchObject({
      contextLength: 200_000,
      features: { vision: true },
    })
    // `image_input.supported: false` is the API saying no — the kind default must not win.
    expect(textOnly).toEqual({
      id: 'claude-example-text-only',
      label: 'Example text-only model (deprecated)',
      contextLength: 100_000,
      features: { vision: false, tools: true, streaming: true },
    })
    // No capability tree: nothing is claimed, the kind's defaults apply.
    expect(unknown).toEqual({
      id: 'claude-example-unknown-caps',
      label: 'Example model without a capability tree',
    })
  })

  it("a 400 carries the vendor's own reason, scrubbed of the key", async () => {
    const { fetchImpl } = routed(() => jsonOf(fixture('anthropic-error-400.json'), 400))
    const result = await listHttpModels(
      'anthropic',
      {
        apiKey: KEY,
        extraHeaders: [{ name: 'anthropic-beta', value: 'example-beta' }],
      },
      { ...OPTS, fetchImpl },
    )
    expect(result).toMatchObject({ ok: false, code: 'invalid' })
    if (result.ok) return
    expect(result.message).toContain('HTTP 400')
    expect(result.message).toContain('invalid_request_error')
    expect(result.message).toContain('anthropic-beta: unexpected value(s)')
    expect(JSON.stringify(result)).not.toContain(KEY)
  })
})

describe('local OpenAI-compatible servers', () => {
  it('Ollama: /api/show supplies vision, tools and the context window per model', async () => {
    const { calls, fetchImpl } = routed(
      (c) =>
        c.url === 'http://192.0.2.20:11434/v1/models'
          ? jsonOf(fixture('ollama-v1-models.json'))
          : null,
      (c) =>
        c.url === 'http://192.0.2.20:11434/api/tags' ? jsonOf(fixture('ollama-tags.json')) : null,
      (c) => {
        if (c.url !== 'http://192.0.2.20:11434/api/show' || c.method !== 'POST') return null
        const asked: unknown = JSON.parse(c.body ?? '{}')
        const model =
          typeof asked === 'object' && asked !== null && 'model' in asked ? asked.model : null
        if (model === 'llama3.2:3b') return jsonOf(fixture('ollama-show-llama3.2.json'))
        if (model === 'qwen2.5vl:7b') return jsonOf(fixture('ollama-show-qwen2.5vl.json'))
        return null
      },
    )
    const result = await listHttpModels(
      'openai-compatible',
      { baseUrl: 'http://192.0.2.20:11434/v1' },
      { ...OPTS, fetchImpl },
    )
    expect(result).toEqual({
      ok: true,
      models: [
        {
          id: 'llama3.2:3b',
          contextLength: 131_072,
          features: { vision: false, tools: true },
        },
        {
          id: 'qwen2.5vl:7b',
          contextLength: 128_000,
          features: { vision: true, tools: false },
        },
      ],
    })
    expect(calls.filter((c) => c.url.endsWith('/api/show'))).toHaveLength(2)
  })

  it('llama.cpp: the context window from meta.n_ctx_train; no Ollama probe answer', async () => {
    const { fetchImpl } = routed((c) =>
      c.url === 'http://192.0.2.30:8080/v1/models'
        ? jsonOf(fixture('llamacpp-v1-models.json'))
        : null,
    )
    const result = await listHttpModels(
      'openai-compatible',
      { baseUrl: 'http://192.0.2.30:8080/v1' },
      { ...OPTS, fetchImpl },
    )
    expect(result).toEqual({
      ok: true,
      models: [{ id: 'gemma-3-4b-it-Q4_K_M.gguf', contextLength: 131_072 }],
    })
  })

  it('an Ollama /api/show that fails keeps the bare id — never fails the list', async () => {
    const { fetchImpl } = routed(
      (c) =>
        c.url === 'http://192.0.2.20:11434/v1/models'
          ? jsonOf(fixture('ollama-v1-models.json'))
          : null,
      (c) =>
        c.url === 'http://192.0.2.20:11434/api/tags' ? jsonOf(fixture('ollama-tags.json')) : null,
      (c) => (c.url.endsWith('/api/show') ? new Response('boom', { status: 500 }) : null),
    )
    const result = await listHttpModels(
      'openai-compatible',
      { baseUrl: 'http://192.0.2.20:11434/v1' },
      { ...OPTS, fetchImpl },
    )
    expect(result).toEqual({
      ok: true,
      models: [{ id: 'llama3.2:3b' }, { id: 'qwen2.5vl:7b' }],
    })
  })

  it('the cloud OpenAI wire is never probed for /api/tags', async () => {
    const { calls, fetchImpl } = routed((c) =>
      c.url === 'https://api.openai.com/v1/models' ? jsonOf(fixture('openai-models.json')) : null,
    )
    const result = await listHttpModels('openai', { apiKey: KEY }, { ...OPTS, fetchImpl })
    expect(result).toEqual({
      ok: true,
      models: [{ id: 'gpt-example-a' }, { id: 'gpt-example-b' }],
    })
    expect(calls).toHaveLength(1)
  })
})
