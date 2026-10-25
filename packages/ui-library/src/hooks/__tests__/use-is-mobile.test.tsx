// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useIsMobile, useIsMidWidth } from '../use-is-mobile'

function Probe({ hook }: { readonly hook: () => boolean }) {
  return <span data-probe="">{String(hook())}</span>
}

function probe(hook: () => boolean): string {
  const { container } = render(<Probe hook={hook} />)
  return container.querySelector('[data-probe]')?.textContent ?? ''
}

function setMatchMedia(value: unknown): void {
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value })
}

afterEach(() => setMatchMedia(undefined))

describe('useIsMobile', () => {
  it('reports the media query result when matchMedia exists', () => {
    setMatchMedia(() => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    expect(probe(useIsMobile)).toBe('true')
  })

  /**
   * `matchMedia` is universal in browsers but absent in bare DOM environments.
   * The hook sits inside shared primitives (`DataTable`), so throwing here
   * takes down the whole page that merely rendered a table. Degrade to the
   * desktop layout instead.
   */
  it('degrades to false instead of throwing when matchMedia is unavailable', () => {
    setMatchMedia(undefined)
    expect(probe(useIsMobile)).toBe('false')
    expect(probe(useIsMidWidth)).toBe('false')
  })
})
