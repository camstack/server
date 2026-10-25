/**
 * A DISABLED field must LOOK disabled.
 *
 * The live report, 2026-08-15: *"il selettore della lingua nella tab AI non si
 * apre — il dropdown non risponde al click"* [the language selector in the AI tab does not open — the dropdown does not respond to the click]. It opened perfectly well; it was
 * `disabled`, because the AI section's master switch was off and every control
 * under it is gated on it. What made that a bug report instead of an obvious
 * state is THIS primitive: `Select` pins `bg-surface`, `text-foreground` and
 * `appearance-none`, which overrides every bit of greying a browser applies to
 * a disabled control by itself — so the inert dropdown was pixel-identical to a
 * live one. `Button` and `IconButton` have carried `disabled:opacity-50` since
 * the beginning; `Select` and `Input` never did.
 *
 * The `<textarea>` two rows below the language dropdown, on the same tab, gated
 * on the same switch, carries its own `disabled:opacity-50` inline — which is
 * why the operator read the prompt box as off and the dropdowns as broken.
 *
 * Stated positively, on the primitives, so a field added later cannot ship the
 * same trap. `pointer-events-none` is deliberately NOT required: a disabled
 * `<select>` still needs to accept hover so a title/tooltip can explain itself.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Input } from '../input'
import { Select } from '../select'

/** Something that visibly dims the control when the browser will not open it. */
const DIMMED = /(^|\s)disabled:opacity-\d+(\s|$)/
/** …and a cursor that says "not now" before the click is even spent. */
const REFUSED = /(^|\s)disabled:cursor-not-allowed(\s|$)/

describe('a disabled field is legible AS disabled', () => {
  it('Select dims and refuses the cursor', () => {
    render(
      <Select
        disabled
        value=""
        onChange={() => {}}
        options={[{ value: '', label: 'English (default)' }]}
        data-testid="s"
      />,
    )
    const className = screen.getByTestId('s').className
    expect(className).toMatch(DIMMED)
    expect(className).toMatch(REFUSED)
  })

  it('Input dims and refuses the cursor', () => {
    render(<Input disabled value="" onChange={() => {}} data-testid="i" />)
    const className = screen.getByTestId('i').className
    expect(className).toMatch(DIMMED)
    expect(className).toMatch(REFUSED)
  })

  it('an ENABLED field is not dimmed by a bare opacity class', () => {
    // The fix must be conditional. A blanket `opacity-50` would make every
    // field look half-off, which is the same failure pointed the other way.
    render(<Input value="" onChange={() => {}} data-testid="i" />)
    expect(screen.getByTestId('i').className).not.toMatch(/(^|\s)opacity-\d+(\s|$)/)
  })
})
