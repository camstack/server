/**
 * A composition field's formula is an evaluator expression plus bindings, not a
 * device template: the dialog edits it with the formula input and saves the same
 * `CompositionExpressionSource` it always did.
 */
import type { CompositionFieldSource } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithTemplateHub } from '../../../../../test-setup/device-template-hub'
import { FormulaFieldDialog } from '../FormulaFieldDialog'

const INITIAL: CompositionFieldSource = {
  kind: 'expression',
  expr: 'x',
  bindings: { x: { kind: 'literal', value: 3 } },
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close() {
    this.open = false
  }
})

describe('FormulaFieldDialog', () => {
  it('saves the edited expression with its bindings in the stored shape', () => {
    const onSave = vi.fn()
    render(
      renderWithTemplateHub(
        <FormulaFieldDialog
          open
          title="Formula"
          fieldPath="level"
          fieldLabel="Level"
          initial={INITIAL}
          onClose={vi.fn()}
          onSave={onSave}
        />,
      ),
    )
    fireEvent.change(screen.getByLabelText(/Level/, { selector: 'input' }), {
      target: { value: 'x * 2' },
    })
    fireEvent.click(screen.getByTestId('formula-dialog-save'))
    expect(onSave).toHaveBeenCalledWith({
      kind: 'expression',
      expr: 'x * 2',
      bindings: INITIAL.kind === 'expression' ? INITIAL.bindings : {},
    })
  })
})
