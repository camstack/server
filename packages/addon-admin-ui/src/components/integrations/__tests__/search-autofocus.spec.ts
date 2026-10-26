// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { shouldAutofocusSearch } from '../search-autofocus'

function setMatchMedia(impl: (query: string) => { matches: boolean } | never): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: impl,
  })
}

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia')
})

describe('shouldAutofocusSearch', () => {
  it('focuses when the pointer is fine', () => {
    setMatchMedia((query) => ({ matches: query.includes('pointer: coarse') ? false : false }))
    expect(shouldAutofocusSearch()).toBe(true)
  })

  it('does not focus a coarse pointer (a phone would open the keyboard)', () => {
    setMatchMedia((query) => ({ matches: query.includes('pointer: coarse') }))
    expect(shouldAutofocusSearch()).toBe(false)
  })

  it('focuses when matchMedia is missing or throws', () => {
    Reflect.deleteProperty(window, 'matchMedia')
    expect(shouldAutofocusSearch()).toBe(true)
    setMatchMedia(() => {
      throw new Error('blocked')
    })
    expect(shouldAutofocusSearch()).toBe(true)
  })
})
