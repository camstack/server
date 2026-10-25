// @vitest-environment jsdom
import type { ConfigObjectArrayField } from '@camstack/types'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConfigFormField } from '../config-form-field'

/**
 * The addon-schema `object-array` table renders inside `AdminPage`, whose body
 * is `overflow-x-clip` — clipping with NO scrollbar. So a table wider than the
 * viewport that has no scroller of its own is not "ugly on a phone", it is
 * content the operator cannot reach at all. This table's column count comes
 * from an addon's schema, so it can be arbitrarily wide.
 */
const FIELD: ConfigObjectArrayField = {
  type: 'object-array',
  key: 'sessions',
  label: 'Sessions',
  columns: [
    { key: 'id', label: 'Id', kind: 'monospace' },
    { key: 'peer', label: 'Peer' },
    { key: 'state', label: 'State', kind: 'status' },
    { key: 'age', label: 'Age', kind: 'duration' },
    { key: 'seen', label: 'Last seen', kind: 'timestamp' },
  ],
  value: [{ id: 'a1', peer: '10.0.0.4', state: 'ok', age: 4000, seen: 1_700_000_000_000 }],
}

function renderField() {
  return render(<ConfigFormField field={FIELD} values={{}} onChange={() => {}} />)
}

describe('object-array field — narrow viewports', () => {
  it('scrolls inside its own container instead of clipping', () => {
    const { container } = renderField()
    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    const wrapper = table?.parentElement
    expect(wrapper?.className).toContain('overflow-x-auto')
    // `overflow-hidden` would clip the overflowing columns with no way to
    // scroll to them — the defect this guards.
    expect(wrapper?.className).not.toContain('overflow-hidden')
  })

  it('keeps a readable minimum width so cells scroll rather than squash', () => {
    const { container } = renderField()
    const table = container.querySelector('table')
    expect(table?.className).toMatch(/min-w-/)
  })
})
