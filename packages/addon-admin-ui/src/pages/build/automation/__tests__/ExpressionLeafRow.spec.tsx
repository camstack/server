/**
 * The expression leaf holds an EVALUATOR expression with named bindings, not a
 * device template, so its input is the formula input: it autocompletes the bound
 * names and the saved leaf keeps its shape.
 */
import type { ExpressionLeaf } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithTemplateHub } from '../../../../test-setup/device-template-hub'
import { ExpressionLeafRow } from '../ExpressionLeafRow'

const LEAF: ExpressionLeaf = {
  kind: 'expression',
  expr: 'indoor > 5',
  bindings: { indoor: { kind: 'literal', value: 20 }, outdoor: { kind: 'literal', value: 10 } },
}

describe('ExpressionLeafRow', () => {
  it('a typed expression is saved in the same shape, bindings untouched', () => {
    const onChange = vi.fn()
    render(
      renderWithTemplateHub(<ExpressionLeafRow leaf={LEAF} devices={[]} onChange={onChange} />),
    )
    fireEvent.change(screen.getByLabelText('Expression'), {
      target: { value: 'indoor - outdoor > 5' },
    })
    expect(onChange).toHaveBeenCalledWith({
      kind: 'expression',
      expr: 'indoor - outdoor > 5',
      bindings: LEAF.bindings,
    })
  })

  it('offers the bound names while typing, and a pick completes the name', () => {
    const onChange = vi.fn()
    render(
      renderWithTemplateHub(
        <ExpressionLeafRow leaf={{ ...LEAF, expr: 'out' }} devices={[]} onChange={onChange} />,
      ),
    )
    const input = screen.getByLabelText('Expression')
    if (!(input instanceof HTMLInputElement)) throw new Error('not an input')
    input.setSelectionRange(3, 3)
    fireEvent.select(input)
    fireEvent.click(screen.getByRole('option', { name: /outdoor/ }))
    expect(onChange).toHaveBeenCalledWith({
      kind: 'expression',
      expr: 'outdoor',
      bindings: LEAF.bindings,
    })
  })
})
