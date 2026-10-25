// @vitest-environment jsdom
/**
 * `type: 'icon'` settings field (D780) — the schema-driven form renders the
 * shared `<IconPicker>` over the icon catalog (D854), never a free-text
 * lucide name.
 *
 *  - picking a tile writes the catalog KEY;
 *  - clearing writes the field's default back (an icon field always draws
 *    something);
 *  - a stored value outside the catalog draws the default's glyph rather
 *    than nothing;
 *  - inside an `editable-array` row it is the same control, writing the row.
 */
import type { ConfigField } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { FormField } from '../config-form-field'
import { loadIconGlyphs } from '../icon-glyphs'

// The lazy glyph table is loaded once, up front: a tile only draws once its glyph is there.
beforeAll(async () => {
  await loadIconGlyphs()
}, 60_000)

const ICON_FIELD: ConfigField = {
  type: 'icon',
  key: 'icon',
  label: 'Icon',
  default: 'shield-check',
}

function openPicker(): void {
  fireEvent.click(screen.getByLabelText('Choose an icon for Icon'))
}

/** The list is virtualised: a tile outside the first window is reached by searching, as an operator does. */
function search(query: string): void {
  fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: query } })
}

describe('FormField — type: icon', () => {
  it('renders the icon picker, not a text input', () => {
    const { container } = render(
      <FormField field={ICON_FIELD} values={{ icon: 'camera' }} onChange={vi.fn()} />,
    )
    expect(container.querySelector('input[type="text"]')).toBeNull()
    expect(screen.getByLabelText('Choose an icon for Icon')).toBeTruthy()
    expect(container.querySelector('.lucide-camera')).not.toBeNull()
  })

  it('picking a tile writes the vocabulary key', () => {
    const onChange = vi.fn()
    render(<FormField field={ICON_FIELD} values={{ icon: 'shield-check' }} onChange={onChange} />)
    openPicker()
    search('lock')
    fireEvent.click(screen.getByTitle('lock'))
    expect(onChange).toHaveBeenCalledWith('icon', 'lock')
  })

  it('clearing writes the default back', () => {
    const onChange = vi.fn()
    render(<FormField field={ICON_FIELD} values={{ icon: 'lock' }} onChange={onChange} />)
    openPicker()
    fireEvent.click(screen.getByText('Default icon'))
    expect(onChange).toHaveBeenCalledWith('icon', 'shield-check')
  })

  it('a stored value outside the catalog draws the default glyph', () => {
    const { container } = render(
      <FormField field={ICON_FIELD} values={{ icon: 'not-a-real-icon' }} onChange={vi.fn()} />,
    )
    expect(container.querySelector('.lucide-shield-check')).not.toBeNull()
  })

  it('works inside an editable-array row', () => {
    const onChange = vi.fn()
    const array: ConfigField = {
      type: 'editable-array',
      key: 'providers',
      label: 'Providers',
      itemFields: [{ type: 'text', key: 'id', label: 'Id' }, ICON_FIELD],
    }
    render(
      <FormField
        field={array}
        values={{ providers: [{ id: 'authentik', icon: 'shield-check' }] }}
        onChange={onChange}
      />,
    )
    openPicker()
    search('key')
    fireEvent.click(screen.getByTitle('key'))
    expect(onChange).toHaveBeenCalledWith('providers', [{ id: 'authentik', icon: 'key' }])
  })
})
