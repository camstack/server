/**
 * The OpenAI-compatible client of the entity-draft benchmark, with a fake fetch:
 * a thinking model that spends its budget on reasoning must read as an EMPTY
 * REPLY (a harness fault), never as a model that answered wrongly.
 */
import { describe, expect, it } from 'vitest'
import {
  emptyReplyIssue,
  loadCases,
  loadSite,
  openAiBackend,
  parseOpenAiBody,
  renderMarkdown,
  runEval,
} from '../eval/entity-draft/lib.mts'

function completion(message: Record<string, unknown>, finish: string): unknown {
  return {
    choices: [{ message, finish_reason: finish }],
    usage: { prompt_tokens: 50, completion_tokens: 20 },
  }
}

function fakeFetch(body: unknown): { readonly fetchImpl: typeof fetch; readonly sent: unknown[] } {
  const sent: unknown[] = []
  const fetchImpl: typeof fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify(body), { status: 200 })
  }
  return { fetchImpl, sent }
}

const request = { system: 'sys', prompt: 'p', schema: {} }
const evalCase = loadCases(['action'])[0]!

describe('parseOpenAiBody', () => {
  it('returns content and finish_reason', () => {
    const r = parseOpenAiBody(completion({ content: '{"a":1}' }, 'stop'), 7)
    expect(r.text).toBe('{"a":1}')
    expect(r.finishReason).toBe('stop')
    expect(r.reasoningOnly).toBe(false)
    expect(emptyReplyIssue(r)).toBeUndefined()
  })

  it('names a reply that holds only reasoning, and never uses it as the text', () => {
    const r = parseOpenAiBody(
      completion({ content: '', reasoning_content: '{"looks":"like json"}' }, 'length'),
      7,
    )
    expect(r.text).toBe('')
    expect(r.reasoningOnly).toBe(true)
    expect(emptyReplyIssue(r)).toBe('(root): reply had only reasoning, finish_reason=length')
  })

  it('reads the `reasoning` alias too, and an empty reply with nothing is its own issue', () => {
    expect(
      parseOpenAiBody(completion({ content: null, reasoning: 'hmm' }, 'length'), 1).reasoningOnly,
    ).toBe(true)
    const bare = parseOpenAiBody(completion({ content: '' }, 'length'), 1)
    expect(emptyReplyIssue(bare)).toBe('(root): empty reply, finish_reason=length')
  })
})

describe('openAiBackend', () => {
  it('sends enable_thinking=false and /no_think by default, and nothing when thinking is on', async () => {
    const off = fakeFetch(completion({ content: '{}' }, 'stop'))
    await openAiBackend({
      url: 'http://x/v1',
      model: 'm',
      maxTokens: 99,
      timeoutMs: 1000,
      fetchImpl: off.fetchImpl,
    }).generate(request, evalCase)
    expect(off.sent[0]).toMatchObject({
      max_tokens: 99,
      chat_template_kwargs: { enable_thinking: false },
    })
    expect(JSON.stringify(off.sent[0])).toContain('/no_think')
    const on = fakeFetch(completion({ content: '{}' }, 'stop'))
    await openAiBackend({
      url: 'http://x/v1',
      model: 'm',
      maxTokens: 99,
      timeoutMs: 1000,
      thinking: 'on',
      fetchImpl: on.fetchImpl,
    }).generate(request, evalCase)
    expect(JSON.stringify(on.sent[0])).not.toContain('enable_thinking')
    expect(JSON.stringify(on.sent[0])).not.toContain('/no_think')
  })

  it('omits response_format when the format is left to the prompt', async () => {
    const f = fakeFetch(completion({ content: '{}' }, 'stop'))
    await openAiBackend({
      url: 'http://x/v1',
      model: 'm',
      maxTokens: 9,
      timeoutMs: 1000,
      responseFormat: 'prompt',
      fetchImpl: f.fetchImpl,
    }).generate(request, evalCase)
    expect(JSON.stringify(f.sent[0])).not.toContain('response_format')
  })

  it('the report names empty replies and the settings, instead of a plain 0%', async () => {
    const { fetchImpl } = fakeFetch(
      completion({ content: '', reasoning_content: 'thinking...' }, 'length'),
    )
    const backend = openAiBackend({
      url: 'http://x/v1',
      model: 'm',
      maxTokens: 64,
      timeoutMs: 1000,
      fetchImpl,
    })
    const report = await runEval(backend, loadSite(), [evalCase], { repairs: 0 })
    const md = renderMarkdown(report)
    expect(md).toContain('Settings: thinking off, max tokens 64')
    expect(md).toContain('Empty replies: 1 of 1')
    expect(md).toContain('reply had only reasoning, finish_reason=length')
    expect(report.results[0]?.finishReason).toBe('length')
  })
})
