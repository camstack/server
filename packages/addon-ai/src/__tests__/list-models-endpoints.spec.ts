/**
 * The endpoint an operator types is not always the one the wire wants: a host
 * with no `/v1`, a pasted `/models` suffix, a server that rejects the page size.
 * `listHttpModels` meets each of them instead of failing with the vendor's 400
 * or a bare 404. Every key is fabricated.
 */
import { describe, expect, it } from 'vitest'
import { listHttpModels } from '../client/list-models.js'

const KEY = 'fake-list-key-0002'
const OPTS = { timeoutMs: 1000 }

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Answers by URL; records every URL dialled. */
function routedFetch(route: (url: string) => Response) {
  const urls: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    urls.push(url)
    return route(url)
  }
  return { urls, fetchImpl }
}

describe('Anthropic endpoint tolerance', () => {
  it('a base with no /v1 is dialled at /v1/models', async () => {
    const { urls, fetchImpl } = routedFetch((u) =>
      u.startsWith('https://proxy.example.com/v1/models')
        ? json({ data: [{ id: 'claude-a' }] })
        : json({}, 404),
    )
    const result = await listHttpModels(
      'anthropic',
      { apiKey: KEY, baseUrl: 'https://proxy.example.com' },
      { ...OPTS, fetchImpl },
    )
    expect(result).toEqual({ ok: true, models: [{ id: 'claude-a' }] })
    expect(urls[0]).toBe('https://proxy.example.com/v1/models?limit=1000')
  })

  it('a pasted /models suffix is not doubled', async () => {
    const { urls, fetchImpl } = routedFetch(() => json({ data: [{ id: 'claude-a' }] }))
    await listHttpModels(
      'anthropic',
      { apiKey: KEY, baseUrl: 'https://api.anthropic.com/v1/models' },
      { ...OPTS, fetchImpl },
    )
    expect(urls[0]).toBe('https://api.anthropic.com/v1/models?limit=1000')
  })

  it('a 400 on the page size is retried at the default page size and still pages', async () => {
    const { urls, fetchImpl } = routedFetch((u) =>
      u.includes('limit=')
        ? json(
            {
              type: 'error',
              error: { type: 'invalid_request_error', message: 'limit: out of range' },
            },
            400,
          )
        : json({ data: [{ id: 'claude-a' }], has_more: false, last_id: 'claude-a' }),
    )
    const result = await listHttpModels('anthropic', { apiKey: KEY }, { ...OPTS, fetchImpl })
    expect(result).toEqual({ ok: true, models: [{ id: 'claude-a' }] })
    expect(urls).toEqual([
      'https://api.anthropic.com/v1/models?limit=1000',
      'https://api.anthropic.com/v1/models',
    ])
  })

  it('a 400 that survives the retry still carries the vendor reason, scrubbed', async () => {
    const { fetchImpl } = routedFetch(() =>
      json({ type: 'error', error: { type: 'invalid_request_error', message: `bad ${KEY}` } }, 400),
    )
    const result = await listHttpModels('anthropic', { apiKey: KEY }, { ...OPTS, fetchImpl })
    expect(result).toMatchObject({ ok: false, code: 'invalid' })
    if (result.ok) return
    expect(result.message).toContain('invalid_request_error')
    expect(JSON.stringify(result)).not.toContain(KEY)
  })
})

describe('Local OpenAI-compatible listing', () => {
  it('a host with no /v1 falls back to /v1/models', async () => {
    const { urls, fetchImpl } = routedFetch((u) =>
      u === 'http://192.0.2.20:11434/v1/models'
        ? json({ data: [{ id: 'llama3.2:3b' }] })
        : json({}, 404),
    )
    const result = await listHttpModels(
      'openai-compatible',
      { baseUrl: 'http://192.0.2.20:11434' },
      { ...OPTS, fetchImpl },
    )
    expect(result).toMatchObject({ ok: true, models: [{ id: 'llama3.2:3b' }] })
    expect(urls[0]).toBe('http://192.0.2.20:11434/models')
    expect(urls[1]).toBe('http://192.0.2.20:11434/v1/models')
  })

  it('a server with only the native Ollama list still lists its models', async () => {
    const { fetchImpl } = routedFetch((u) =>
      u === 'http://192.0.2.20:11434/api/tags'
        ? json({ models: [{ name: 'qwen2.5:7b' }] })
        : json({}, 404),
    )
    const result = await listHttpModels(
      'openai-compatible',
      { baseUrl: 'http://192.0.2.20:11434/v1' },
      { ...OPTS, fetchImpl },
    )
    expect(result).toMatchObject({ ok: true, models: [{ id: 'qwen2.5:7b' }] })
  })
})
