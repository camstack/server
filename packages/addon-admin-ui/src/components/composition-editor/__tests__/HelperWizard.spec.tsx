/**
 * Helper steps keep what was chosen. A different template is the only reset.
 * Create ends with two saves: open the new device, or stay and start another.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import type { HelperFormDraft, HelperSaveResult } from '../helper-form-model'
import { HelperWizard } from '../HelperWizard'

vi.mock('../../device/customize/source-selector/SourceSelector', () => ({
  SourceSelector: ({
    onMembersChange,
  }: {
    readonly onMembersChange: (
      members: readonly {
        readonly source: { readonly addonId: string; readonly stableId: string }
        readonly cap: string
        readonly fieldPath: string
      }[],
    ) => void
  }) => (
    <button
      type="button"
      data-testid="source-selector"
      onClick={() =>
        onMembersChange([
          {
            source: { addonId: 'provider-homeassistant', stableId: 'sensor.porch' },
            cap: 'temperature-sensor',
            fieldPath: 'celsius',
          },
        ])
      }
    >
      add member
    </button>
  ),
}))

function renderWizard(
  onSave: (draft: HelperFormDraft, intent: 'open' | 'again') => Promise<HelperSaveResult>,
): void {
  const ui: ReactNode = (
    <MemoryRouter>
      <HelperWizard
        purpose="create"
        initial={null}
        start="template"
        saving={false}
        onSave={onSave}
      />
    </MemoryRouter>
  )
  render(ui)
}

function pick(templateId: string): void {
  fireEvent.click(screen.getByTestId(`helper-template-${templateId}`))
}

describe('HelperWizard', () => {
  it('keeps the name and the operation across Back and Next', () => {
    renderWizard(async () => ({ kind: 'saved', deviceId: 1 }))
    pick('temperature')
    fireEvent.change(screen.getByTestId('helper-name'), { target: { value: 'Front door' } })
    fireEvent.change(screen.getByTestId('helper-reducer'), { target: { value: 'max' } })
    fireEvent.click(screen.getByTestId('helper-to-members'))
    expect(screen.getByTestId('source-selector')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect((screen.getByTestId('helper-name') as HTMLInputElement).value).toBe('Front door')
    expect((screen.getByTestId('helper-reducer') as HTMLSelectElement).value).toBe('max')
    expect(screen.queryByLabelText('Room')).toBeNull()
  })

  it('resets the name and the operation when another template is chosen', () => {
    renderWizard(async () => ({ kind: 'saved', deviceId: 1 }))
    pick('temperature')
    fireEvent.change(screen.getByTestId('helper-name'), { target: { value: 'Front door' } })
    fireEvent.change(screen.getByTestId('helper-reducer'), { target: { value: 'max' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    pick('humidity')
    expect((screen.getByTestId('helper-name') as HTMLInputElement).value).toBe('')
    expect((screen.getByTestId('helper-reducer') as HTMLSelectElement).value).toBe('mean')
  })

  it('opens the device after save, and create-more returns to the type tiles with a link', async () => {
    const onSave = vi.fn(
      async (_draft: HelperFormDraft, intent: 'open' | 'again'): Promise<HelperSaveResult> => ({
        kind: 'saved',
        deviceId: intent === 'open' ? 4700 : 4701,
      }),
    )
    renderWizard(onSave)
    pick('temperature')
    fireEvent.change(screen.getByTestId('helper-name'), { target: { value: 'Front door' } })
    fireEvent.click(screen.getByTestId('helper-to-members'))
    fireEvent.click(screen.getByTestId('source-selector'))
    expect(screen.getByTestId('helper-save-open').textContent).toContain('Save and open device')
    expect(screen.getByTestId('helper-save-more').textContent).toContain('Save and create more')
    fireEvent.click(screen.getByTestId('helper-save-open'))
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]?.[1]).toBe('open')

    fireEvent.click(screen.getByTestId('helper-save-more'))
    expect(await screen.findByTestId('helper-template-picker')).toBeTruthy()
    const link = await screen.findByRole('link', { name: 'Front door' })
    expect(link.getAttribute('href')).toBe('/devices/4701')
  })
})
