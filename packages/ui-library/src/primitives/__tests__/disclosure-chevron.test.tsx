// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { DisclosureChevron } from '../disclosure-chevron'

describe('DisclosureChevron', () => {
  it('draws a 16px lucide icon, not a text glyph, in both states', () => {
    for (const expanded of [true, false]) {
      const { container, unmount } = render(<DisclosureChevron expanded={expanded} />)
      const svg = container.querySelector('svg')
      expect(svg).not.toBeNull()
      expect(svg?.getAttribute('class')).toContain('h-4 w-4')
      expect(svg?.getAttribute('aria-hidden')).toBe('true')
      expect(container.textContent).toBe('')
      unmount()
    }
  })

  it('switches icon with the expanded state', () => {
    const a = render(<DisclosureChevron expanded />).container.innerHTML
    const b = render(<DisclosureChevron expanded={false} />).container.innerHTML
    expect(a).not.toBe(b)
  })
})
