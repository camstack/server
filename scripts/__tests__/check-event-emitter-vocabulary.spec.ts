import { describe, expect, it } from 'vitest'
import { findVocabularyFindings } from '../check-event-emitter-vocabulary'

const REL = 'packages/addon-provider-x/src/devices/x-event-device.ts'
const file = (content: string, rel = REL) => [{ rel, content }]
const PROVIDER = `this.ctx.registerNativeCap(eventEmitterCapability, provider)\n`

describe('check-event-emitter-vocabulary', () => {
  it('accepts a provider that declares its vocabulary', () => {
    const src = `${PROVIDER}const s = { eventTypes: [...t], vocabulary: plainEventVocabulary(t) }\n`
    expect(findVocabularyFindings(file(src), {})).toEqual([])
  })

  it('refuses a provider that never writes a vocabulary', () => {
    const src = `${PROVIDER}const s = { eventTypes: [...t] }\n`
    expect(findVocabularyFindings(file(src), {})).toEqual([
      { file: REL, line: 1, problem: 'no-vocabulary' },
    ])
  })

  it('refuses a vocabulary written empty, and names the line', () => {
    const src = `${PROVIDER}const s = {\n  vocabulary: [],\n}\n`
    expect(findVocabularyFindings(file(src), {})).toEqual([
      { file: REL, line: 3, problem: 'empty-vocabulary' },
    ])
  })

  it('accepts an empty vocabulary on a source listed as open, with its reason', () => {
    const src = `${PROVIDER}const s = { vocabulary: [] }\n`
    expect(findVocabularyFindings(file(src), { [REL]: 'bus events have no declared set' })).toEqual(
      [],
    )
  })

  it('refuses a listed exception that no longer writes an empty vocabulary', () => {
    const src = `${PROVIDER}const s = { vocabulary: plainEventVocabulary(t) }\n`
    expect(findVocabularyFindings(file(src), { [REL]: 'was open' })).toEqual([
      { file: REL, line: 1, problem: 'stale-exception' },
    ])
  })

  it('refuses a listed exception whose file is gone', () => {
    expect(findVocabularyFindings([], { [REL]: 'was open' })).toEqual([
      { file: REL, line: 1, problem: 'stale-exception' },
    ])
  })

  it('ignores a file that does not touch the capability', () => {
    expect(findVocabularyFindings(file(`const s = { vocabulary: [] }\n`), {})).toEqual([])
  })
})
