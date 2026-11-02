/**
 * "Units" on My access: the two selects show the stored choice, a change is
 * written through the account-preference hook, and nothing can be written
 * while the row is pending, failed to load, or unreadable.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountUnitPreferencesState } from '@camstack/ui-library'
import i18n from '../../../i18n'

let state: AccountUnitPreferencesState
const update = vi.fn()

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return { ...actual, useAccountUnitPreferences: () => state }
})

import { UnitsSection } from '../UnitsSection'

const ready = (
  value: AccountUnitPreferencesState['value'],
  overrides: Partial<AccountUnitPreferencesState> = {},
): AccountUnitPreferencesState => ({
  status: 'ok',
  value,
  writable: true,
  update,
  ...overrides,
})

beforeEach(async () => {
  await i18n.changeLanguage('en')
  update.mockReset()
  update.mockResolvedValue(undefined)
  state = ready({ system: 'metric', temperature: 'celsius' })
})

describe('UnitsSection', () => {
  it('shows the stored choices', () => {
    state = ready({ system: 'imperial', temperature: 'fahrenheit' })
    render(<UnitsSection />)
    expect(screen.getByLabelText('Temperature')).toHaveProperty('value', 'fahrenheit')
    expect(screen.getByLabelText('Other measurements')).toHaveProperty('value', 'imperial')
  })

  it('writes only the field that changed', async () => {
    render(<UnitsSection />)
    fireEvent.change(screen.getByLabelText('Temperature'), {
      target: { value: 'fahrenheit' },
    })
    expect(update).toHaveBeenCalledWith({ temperature: 'fahrenheit' })
    await waitFor(() =>
      expect(screen.getByLabelText('Temperature')).toHaveProperty('disabled', false),
    )
    fireEvent.change(screen.getByLabelText('Other measurements'), {
      target: { value: 'imperial' },
    })
    expect(update).toHaveBeenLastCalledWith({ system: 'imperial' })
    await waitFor(() =>
      expect(screen.getByLabelText('Temperature')).toHaveProperty('disabled', false),
    )
  })

  it('cannot be changed while the row has not answered', () => {
    state = ready(
      { system: 'metric', temperature: 'celsius' },
      { status: 'pending', writable: false },
    )
    render(<UnitsSection />)
    expect(screen.getByLabelText('Temperature')).toHaveProperty('disabled', true)
  })

  it('says so when the read failed, and does not allow a write', () => {
    state = ready(
      { system: 'metric', temperature: 'celsius' },
      { status: 'error', writable: false },
    )
    render(<UnitsSection />)
    expect(screen.getByText('Your unit preferences could not be read.')).toBeTruthy()
    expect(screen.getByLabelText('Other measurements')).toHaveProperty('disabled', true)
  })

  it('leaves an unreadable stored row alone and says why', () => {
    state = ready({ system: 'metric', temperature: 'celsius' }, { writable: false })
    render(<UnitsSection />)
    expect(screen.getByText(/format this version cannot read/)).toBeTruthy()
    expect(screen.getByLabelText('Temperature')).toHaveProperty('disabled', true)
  })

  it('shows the reason when a write fails', async () => {
    update.mockRejectedValue(new Error('the row changed while saving'))
    render(<UnitsSection />)
    fireEvent.change(screen.getByLabelText('Temperature'), {
      target: { value: 'fahrenheit' },
    })
    expect(await screen.findByText('the row changed while saving')).toBeTruthy()
  })
})
