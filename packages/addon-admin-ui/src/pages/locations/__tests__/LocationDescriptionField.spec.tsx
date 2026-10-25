/**
 * The description field on a location card.
 *
 * Two rules worth a test, both about not inventing a choice: a BLANK save
 * clears rather than storing an empty string (an empty line reaches a vision
 * model and costs it attention while saying nothing), and an unchanged draft
 * writes nothing at all (every save takes the shared addon-store lock).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { LocationDescriptionField, pickLocationDescription } from '../LocationDescriptionField'

function field(description: string | null, onSave = vi.fn()) {
  render(
    <LocationDescriptionField
      name="Parking"
      description={description}
      busy={false}
      onSave={onSave}
    />,
  )
  return { onSave, box: screen.getByLabelText('What is there') }
}

describe('LocationDescriptionField', () => {
  it('saves the typed text on blur', () => {
    const { onSave, box } = field(null)
    fireEvent.change(box, { target: { value: 'Selciato e tre posti auto.' } })
    fireEvent.blur(box)
    expect(onSave).toHaveBeenCalledWith('Selciato e tre posti auto.')
  })

  it('clears with null when the text is blanked', () => {
    const { onSave, box } = field('Selciato.')
    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.blur(box)
    expect(onSave).toHaveBeenCalledWith(null)
  })

  it('writes NOTHING when the draft is unchanged', () => {
    const { onSave, box } = field('Selciato.')
    fireEvent.blur(box)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('follows the server when the description changes underneath', () => {
    // A rename rewrites the key; without this the card keeps showing the text
    // of the room it used to be.
    const { rerender } = render(
      <LocationDescriptionField name="Sala" description="Vecchia." busy={false} onSave={vi.fn()} />,
    )
    rerender(
      <LocationDescriptionField name="Sala" description="Nuova." busy={false} onSave={vi.fn()} />,
    )
    expect(screen.getByLabelText('What is there')).toHaveValue('Nuova.')
  })
})

describe('pickLocationDescription', () => {
  it('is null for a location nobody described', () => {
    expect(
      pickLocationDescription([{ locationKey: 'sala', description: 'x' }], 'garage'),
    ).toBeNull()
  })

  it('returns the stored text for the folded key', () => {
    expect(pickLocationDescription([{ locationKey: 'sala', description: 'x' }], 'sala')).toBe('x')
  })
})
