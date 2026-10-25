// @vitest-environment jsdom
/**
 * bare ConfigFormBuilder must honor section.columns (ItemFormDialog path).
 */
import type { ConfigUISchema } from '@camstack/types'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigFormBuilder } from '../config-form-builder.js'

afterEach(() => cleanup())

const SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'identity',
      title: 'Identity',
      columns: 2,
      fields: [
        { type: 'text', key: 'a', label: 'A' },
        { type: 'text', key: 'b', label: 'B' },
      ],
    },
  ],
}

describe('ConfigFormBuilder bare + columns', () => {
  it('applies the 2-col container-query grid class when bare', () => {
    const { container } = render(
      <ConfigFormBuilder
        schema={SCHEMA}
        values={{ a: '', b: '' }}
        onChange={() => undefined}
        bare
      />,
    )
    const grid = container.querySelector('.grid')
    expect(grid).toBeTruthy()
    expect(grid?.className).toContain('@[480px]:grid-cols-2')
    expect(grid?.className).not.toMatch(/^grid grid-cols-1 gap-y/)
  })
})
