/**
 * The guard that keeps provider settings prose to what an operator needs: a
 * long `description` or a wordy `info` block fails, a short one and a dynamic
 * one do not.
 */
import { describe, expect, it } from 'vitest'

import {
  MAX_DESCRIPTION_CHARS,
  MAX_INFO_SENTENCES,
  helpProblems,
  sentenceCount,
} from '../check-settings-help-length'

const LONG = 'x'.repeat(MAX_DESCRIPTION_CHARS + 1)

describe('descriptions', () => {
  it('passes a short description', () => {
    expect(helpProblems('a.ts', `const f = { description: 'Higher = more sensitive.' }`)).toEqual(
      [],
    )
  })

  it('refuses a description over the limit', () => {
    const found = helpProblems('a.ts', `const f = { description: '${LONG}' }`)
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain(`${LONG.length} chars`)
  })

  it('refuses a long hint and help too', () => {
    expect(helpProblems('a.ts', `const f = { hint: '${LONG}', help: '${LONG}' }`)).toHaveLength(2)
  })

  it('counts a concatenated literal as one text', () => {
    const half = 'y'.repeat(MAX_DESCRIPTION_CHARS / 2 + 1)
    expect(helpProblems('a.ts', `const f = { description: '${half}' + '${half}' }`)).toHaveLength(1)
  })

  it('follows a same-file constant', () => {
    const src = `const TEXT = '${LONG}'\nconst f = { description: TEXT }`
    expect(helpProblems('a.ts', src).length).toBeGreaterThan(0)
  })

  it('checks both branches of a conditional', () => {
    const src = `const f = { description: ok ? 'short' : '${LONG}' }`
    expect(helpProblems('a.ts', src)).toHaveLength(1)
  })

  it('does not count a template hole as prose', () => {
    const src = 'const f = { description: `See ${' + `'${LONG}'` + '} for details.` }'
    expect(helpProblems('a.ts', src)).toEqual([])
  })

  it('ignores a description that is not text', () => {
    expect(helpProblems('a.ts', `const f = { description: client.describe(id) }`)).toEqual([])
  })
})

describe('info blocks', () => {
  const info = (content: string) => `const f = { type: 'info', content: '${content}' }`

  it('counts sentences, not abbreviations or addresses', () => {
    expect(sentenceCount('Use 0.0.0.0 for every interface (e.g. 192.168.1.1).')).toBe(1)
    expect(sentenceCount('One. Two. Three.')).toBe(3)
    expect(sentenceCount('')).toBe(0)
  })

  it('passes up to the limit', () => {
    expect(MAX_INFO_SENTENCES).toBe(2)
    expect(helpProblems('a.ts', info('Register a broker first. Then enable the export.'))).toEqual(
      [],
    )
  })

  it('refuses a wordy info block', () => {
    const found = helpProblems('a.ts', info('One thing. Another thing. A third thing.'))
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('3 sentences')
  })

  it('leaves content of a non-info object alone', () => {
    expect(helpProblems('a.ts', `const f = { type: 'text', content: 'A. B. C. D.' }`)).toEqual([])
  })
})
