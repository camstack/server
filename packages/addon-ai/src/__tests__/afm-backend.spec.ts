import type { AppleFmAvailability, LlmRuntimeAppleCompleteInput } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { createAppleFmBackend } from '../runtime/apple/afm-backend.js'
import type { HelperOutcome, HelperRequestOptions } from '../runtime/apple/afm-helper.js'
import type { AfmRequest } from '../runtime/apple/afm-protocol.js'
import { createTestLogger, makeTestLogger } from './support/logger.js'

interface Recorded {
  readonly payload: AfmRequest
  readonly opts: HelperRequestOptions
}

function backendWith(
  outcome: HelperOutcome,
  opts: {
    staticAbsence?: AppleFmAvailability | null
    logger?: ReturnType<typeof createTestLogger>
  } = {},
) {
  const requests: Recorded[] = []
  const backend = createAppleFmBackend({
    nodeId: 'mac',
    helper: {
      request: async (payload, requestOpts) => {
        requests.push({ payload, opts: requestOpts })
        return outcome
      },
    },
    availability: {
      current: () => ({ state: 'unknown', error: 'not probed yet' }),
      staticAbsence: () => opts.staticAbsence ?? null,
    },
    logger: opts.logger?.logger ?? makeTestLogger(),
  })
  return { backend, requests }
}

const input: LlmRuntimeAppleCompleteInput = {
  consumer: 'notifier-narration',
  prompt: 'Titolo: porta aperta alle 18:05',
  system: 'Rispondi in italiano.',
  jsonSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  maxTokens: 40,
  temperature: 0.2,
  topP: 0.9,
  timeoutMs: 20_000,
  requestId: 'r1',
}

const signal = new AbortController().signal

describe('AppleFmBackend.complete', () => {
  it('forwards the request to the helper as ONE counted generation under the profile bound', async () => {
    const { backend, requests } = backendWith({
      kind: 'reply',
      reply: {
        id: 'afm-1',
        ok: true,
        text: '{"title":"Porta aperta"}',
        usage: { inputTokens: 0, outputTokens: 0 },
        truncated: false,
        latencyMs: 700,
      },
    })
    const result = await backend.complete(input, signal)
    expect(result).toEqual({
      ok: true,
      text: '{"title":"Porta aperta"}',
      model: 'apple-system',
      usage: { inputTokens: 0, outputTokens: 0 },
      truncated: false,
      latencyMs: 700,
    })
    expect(requests[0]?.payload).toEqual({
      op: 'generate',
      prompt: input.prompt,
      system: input.system,
      jsonSchema: input.jsonSchema,
      maxTokens: 40,
      temperature: 0.2,
      topP: 0.9,
    })
    expect(requests[0]?.opts).toMatchObject({ timeoutMs: 20_000, counted: true, signal })
  })

  it('a guardrail violation is a distinct refusal, and it is logged with the consumer', async () => {
    const handle = createTestLogger()
    const { backend } = backendWith(
      {
        kind: 'reply',
        reply: {
          id: 'afm-1',
          ok: false,
          code: 'refusal',
          message: 'Apple guardrail refused the request: unsafe',
          appleError: 'guardrailViolation',
          refusalSource: 'guardrail',
        },
      },
      { logger: handle },
    )
    const result = await backend.complete(input, signal)
    expect(result).toMatchObject({ ok: false, code: 'refusal', refusalSource: 'guardrail' })
    const line = handle.entries.find((e) => e.message.includes('guardrail'))
    expect(line?.level).toBe('warn')
    expect(line?.extras?.meta).toMatchObject({ consumer: 'notifier-narration', requestId: 'r1' })
  })

  it('images are refused on a node without image input — never dropped to a text answer', async () => {
    const { backend, requests } = backendWith({ kind: 'busy' })
    const result = await backend.complete(
      { ...input, images: [{ bytes: new Uint8Array([1]), mimeType: 'image/jpeg' }] },
      signal,
    )
    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
    expect(requests).toHaveLength(0)
  })

  it('a node that is not a Mac answers unavailable without touching a helper', async () => {
    const { backend, requests } = backendWith(
      { kind: 'busy' },
      { staticAbsence: { state: 'unsupported-platform', platform: 'linux' } },
    )
    expect(await backend.complete(input, signal)).toMatchObject({ ok: false, code: 'unavailable' })
    expect(requests).toHaveLength(0)
  })

  it.each([
    [{ kind: 'timeout' } as const, 'timeout'],
    [{ kind: 'cancelled' } as const, 'timeout'],
    [{ kind: 'busy' } as const, 'rate-limited'],
    [{ kind: 'crashed', detail: 'exit 1' } as const, 'unavailable'],
    [{ kind: 'unavailable', reason: 'helperMissing', detail: 'no binary' } as const, 'unavailable'],
  ])('supervisor outcome %o → %s', async (outcome, code) => {
    const { backend } = backendWith(outcome)
    expect(await backend.complete(input, signal)).toMatchObject({ ok: false, code })
  })

  it('the helper saying `cancelled` reads like every other cancelled call', async () => {
    const { backend } = backendWith({
      kind: 'reply',
      reply: { id: 'afm-1', ok: false, code: 'cancelled', message: 'cancelled by the caller' },
    })
    expect(await backend.complete(input, signal)).toEqual({
      ok: false,
      code: 'timeout',
      message: 'the call was cancelled',
    })
  })

  it('a reply this addon cannot read is an adapter-error, not a silent empty answer', async () => {
    const { backend } = backendWith({ kind: 'reply', reply: { id: 'afm-1', ok: true } })
    expect(await backend.complete(input, signal)).toMatchObject({
      ok: false,
      code: 'adapter-error',
    })
  })
})
