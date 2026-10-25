/** Every managed LLM declares its licence; Llama carries its required attribution (D661). */
import { describe, expect, it } from 'vitest'
import { LLM_MODEL_CATALOG } from '../llm-model-catalog.js'

describe('LLM catalog declares licences', () => {
  it.each(LLM_MODEL_CATALOG.map((m) => [m.entry.id, m.entry] as const))('%s', (_id, e) => {
    expect(e.license?.weights).toBeTruthy()
    expect(e.license?.upstream?.url).toMatch(/^https:\/\//)
    expect(e.license?.url).toMatch(/^https:\/\//)
    expect(e.license?.hosting).toBe('third-party')
  })

  it('Llama 3.2 carries the "Built with Llama" attribution its licence requires', () => {
    const llama = LLM_MODEL_CATALOG.find((m) => m.entry.id === 'llm-llama3.2-3b-instruct-q4')
    expect(llama?.entry.license?.attribution).toContain('Built with Llama')
  })
})
