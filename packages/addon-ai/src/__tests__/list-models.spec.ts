/**
 * `listHttpModels` per wire, against a scripted fetch: the URL, the auth
 * header each vendor wants, pagination, the typed failures — and that the key
 * travels in a header only and never comes back in a message. Every key below
 * is fabricated.
 */
import { describe, expect, it } from 'vitest'
import { listHttpModels } from '../client/list-models.js'

const KEY = 'fake-list-key-0001'

interface Seen {
  readonly url: string
  readonly headers: Record<string, string>
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, key) => {
    out[key] = value
  })
  return out
}

/** A fetch that answers each call with the next scripted response. */
function scripted(...answers: readonly (Response | Error)[]) {
  const seen: Seen[] = []
  let i = 0
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), headers: headersOf(init) })
    const answer = answers[Math.min(i, answers.length - 1)]
    i += 1
    if (answer === undefined) throw new Error('no scripted answer')
    if (answer instanceof Error) throw answer
    return answer
  }
  return { seen, fetchImpl }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const OPTS = { timeoutMs: 1000 }

describe('OpenAI and OpenAI-compatible', () => {
  it('GETs {base}/models with a Bearer key and the extra headers', async () => {
    const { seen, fetchImpl } = scripted(json({ data: [{ id: 'gpt-a' }, { id: 'gpt-b' }] }))
    const result = await listHttpModels(
      'openai',
      { apiKey: KEY, extraHeaders: [{ name: 'x-org', value: 'acme' }] },
      { ...OPTS, fetchImpl },
    )
    expect(result).toEqual({ ok: true, models: [{ id: 'gpt-a' }, { id: 'gpt-b' }] })
    expect(seen[0]?.url).toBe('https://api.openai.com/v1/models')
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(seen[0]?.headers['x-org']).toBe('acme')
  })

  it('a custom endpoint is dialled at its own base URL, keyless', async () => {
    const { seen, fetchImpl } = scripted(json({ data: [{ id: 'llama3.2:3b' }] }))
    const result = await listHttpModels(
      'openai-compatible',
      { baseUrl: 'http://192.0.2.20:11434/v1/' },
      { ...OPTS, fetchImpl },
    )
    expect(result).toEqual({ ok: true, models: [{ id: 'llama3.2:3b' }] })
    expect(seen[0]?.url).toBe('http://192.0.2.20:11434/v1/models')
    expect(seen[0]?.headers.authorization).toBeUndefined()
  })

  it('a custom endpoint with no base URL is `invalid`, and nothing is dialled', async () => {
    const { seen, fetchImpl } = scripted(json({ data: [] }))
    const result = await listHttpModels('openai-compatible', {}, { ...OPTS, fetchImpl })
    expect(result).toMatchObject({ ok: false, code: 'invalid' })
    expect(seen).toHaveLength(0)
  })
})

describe('Anthropic', () => {
  it('sends x-api-key + anthropic-version and follows the pages', async () => {
    const { seen, fetchImpl } = scripted(
      json({
        data: [{ id: 'claude-a', display_name: 'Claude A' }],
        has_more: true,
        last_id: 'claude-a',
      }),
      json({ data: [{ id: 'claude-b' }], has_more: false, last_id: 'claude-b' }),
    )
    const result = await listHttpModels('anthropic', { apiKey: KEY }, { ...OPTS, fetchImpl })
    expect(result).toEqual({
      ok: true,
      models: [{ id: 'claude-a', label: 'Claude A' }, { id: 'claude-b' }],
    })
    expect(seen[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000')
    expect(seen[0]?.headers['x-api-key']).toBe(KEY)
    expect(seen[0]?.headers['anthropic-version']).toBe('2023-06-01')
    expect(seen[0]?.headers.authorization).toBeUndefined()
    expect(seen[1]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000&after_id=claude-a')
  })

  it('no key is `auth` before any request', async () => {
    const { seen, fetchImpl } = scripted(json({ data: [] }))
    expect(await listHttpModels('anthropic', {}, { ...OPTS, fetchImpl })).toMatchObject({
      ok: false,
      code: 'auth',
    })
    expect(seen).toHaveLength(0)
  })
})

describe('Google Gemini', () => {
  it('sends the key as a HEADER, never in the URL; keeps only generateContent models', async () => {
    const { seen, fetchImpl } = scripted(
      json({
        models: [
          {
            name: 'models/gemini-x',
            displayName: 'Gemini X',
            inputTokenLimit: 1_048_576,
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          { name: 'models/embedding-y', supportedGenerationMethods: ['embedContent'] },
        ],
        nextPageToken: 'p2',
      }),
      json({ models: [{ name: 'models/gemini-z' }] }),
    )
    const result = await listHttpModels('google', { apiKey: KEY }, { ...OPTS, fetchImpl })
    expect(result).toEqual({
      ok: true,
      models: [{ id: 'gemini-x', label: 'Gemini X', contextLength: 1_048_576 }, { id: 'gemini-z' }],
    })
    expect(seen[0]?.headers['x-goog-api-key']).toBe(KEY)
    for (const call of seen) expect(call.url).not.toContain(KEY)
    expect(seen[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
    )
    expect(seen[1]?.url).toContain('pageToken=p2')
  })
})

describe('typed failures that never carry the key', () => {
  it('401 is `auth`', async () => {
    const { fetchImpl } = scripted(json({ error: 'nope' }, 401))
    expect(await listHttpModels('openai', { apiKey: KEY }, { ...OPTS, fetchImpl })).toMatchObject({
      ok: false,
      code: 'auth',
    })
  })

  it('404 is `unsupported` — a server with no list, type the id', async () => {
    const { fetchImpl } = scripted(new Response('not found', { status: 404 }))
    expect(
      await listHttpModels(
        'openai-compatible',
        { baseUrl: 'http://192.0.2.9/v1' },
        { ...OPTS, fetchImpl },
      ),
    ).toMatchObject({ ok: false, code: 'unsupported' })
  })

  it('an unreachable endpoint is `network`, and its message is scrubbed of the key', async () => {
    const { fetchImpl } = scripted(new Error(`connect ECONNREFUSED while sending ${KEY}`))
    const result = await listHttpModels('openai', { apiKey: KEY }, { ...OPTS, fetchImpl })
    expect(result).toMatchObject({ ok: false, code: 'network' })
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  it('a body that is not a model list is `network`, never a throw', async () => {
    const { fetchImpl } = scripted(json({ hello: 'world' }))
    expect(await listHttpModels('openai', { apiKey: KEY }, { ...OPTS, fetchImpl })).toMatchObject({
      ok: false,
      code: 'network',
    })
  })
})
