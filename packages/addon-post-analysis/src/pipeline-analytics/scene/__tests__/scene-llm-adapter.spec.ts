import { describe, expect, it, vi } from 'vitest'
import { checkSceneLlm } from '../scene-llm-adapter.js'

/** The shipped `llm.generateVision` OK envelope — text, never a parsed `json`. */
function ok(text: string): {
  ok: true
  text: string
  model: string
  usage: { inputTokens: number; outputTokens: number }
  truncated: boolean
  latencyMs: number
} {
  return {
    ok: true,
    text,
    model: 'qwen/qwen3-vl-8b',
    usage: { inputTokens: 100, outputTokens: 20 },
    truncated: false,
    latencyMs: 900,
  }
}

describe('checkSceneLlm', () => {
  it('reports unavailable when no llm client is wired', async () => {
    const res = await checkSceneLlm({
      llm: null,
      crop: new Uint8Array([1]),
      prompt: 'bins in place?',
    })
    expect(res.availability).toBe('unavailable')
  })

  it('maps a no-profile result to unavailable', async () => {
    const llm = {
      generateVision: vi.fn().mockResolvedValue({ ok: false, code: 'no-profile', message: 'x' }),
    }
    const res = await checkSceneLlm({
      llm,
      crop: new Uint8Array([1]),
      prompt: 'q',
    })
    expect(res.availability).toBe('unavailable')
    if (res.availability === 'unavailable') expect(res.reason).toContain('profile')
  })

  /**
   * The cap returns `{ ok, text }` — the JSON lives IN the text. This adapter
   * asserted `{ ok, json }` for months, a shape the cap has never produced.
   */
  it('parses the structured judgment out of the result TEXT', async () => {
    const generateVision = vi.fn().mockResolvedValue(ok('{"active":true,"confidence":0.82}'))
    const res = await checkSceneLlm({
      llm: { generateVision },
      crop: new Uint8Array([1]),
      prompt: 'q',
    })
    expect(res).toMatchObject({
      availability: 'ok',
      active: true,
      confidence: 0.82,
    })
    expect(generateVision).toHaveBeenCalledWith(
      expect.objectContaining({ consumer: 'scene-monitor', temperature: 0 }),
    )
  })

  it('tolerates a model that fences its JSON in markdown', async () => {
    const generateVision = vi
      .fn()
      .mockResolvedValue(ok('```json\n{"active":false,"confidence":0.1}\n```'))
    const res = await checkSceneLlm({
      llm: { generateVision },
      crop: new Uint8Array([1]),
      prompt: 'q',
    })
    expect(res).toMatchObject({
      availability: 'ok',
      active: false,
      confidence: 0.1,
    })
  })

  it('reports unavailable — never a guess — when the answer is not the asked shape', async () => {
    const generateVision = vi.fn().mockResolvedValue(ok('the bins look fine to me'))
    const res = await checkSceneLlm({
      llm: { generateVision },
      crop: new Uint8Array([1]),
      prompt: 'q',
    })
    expect(res.availability).toBe('unavailable')
    if (res.availability === 'unavailable') expect(res.reason).toContain('unparseable')
  })
})
