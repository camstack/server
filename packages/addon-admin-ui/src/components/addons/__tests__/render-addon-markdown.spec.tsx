import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AddonMarkdown } from '../render-addon-markdown'

describe('AddonMarkdown', () => {
  it('renders headings, emphasis and https links', () => {
    render(
      <AddonMarkdown
        markdown={'# Title\n\nA **bold** note and [docs](https://example.com/readme).'}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy()
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    const link = screen.getByRole('link', { name: 'docs' })
    expect(link.getAttribute('href')).toBe('https://example.com/readme')
  })

  it('does not turn raw HTML or a script URL into an element', () => {
    const { container } = render(
      <AddonMarkdown
        markdown={
          '<script>alert(1)</script>\n\n[click](javascript:alert(1))\n\n<img src=x onerror=alert(1)>'
        }
      />,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
    expect(container.textContent).toContain('click')
  })
})
