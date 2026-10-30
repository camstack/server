// @vitest-environment jsdom
/**
 * An accordion section header is a real button with aria-expanded, and its
 * marker is the shared DisclosureChevron (an svg), never a text glyph.
 */
import type { ConfigUISchema } from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigFormBuilder } from '../config-form-builder.js'

afterEach(() => cleanup())

const SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'troubleshooting',
      title: 'Troubleshooting',
      style: 'accordion',
      defaultCollapsed: true,
      fields: [{ type: 'text', key: 'a', label: 'Field A' }],
    },
  ],
}

describe('accordion section header', () => {
  it('is a button that reports and toggles aria-expanded, with an svg chevron', () => {
    render(<ConfigFormBuilder schema={SCHEMA} values={{ a: '' }} onChange={() => undefined} />)
    const header = screen.getByRole('button', { name: /Troubleshooting/ })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(header.querySelector('svg')).not.toBeNull()
    expect(header.textContent).not.toMatch(/[▸▾]/)
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Field A')).toBeTruthy()
  })
})
