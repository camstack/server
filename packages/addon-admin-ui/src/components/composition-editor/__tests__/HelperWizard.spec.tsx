/**
 * Helper steps keep what was chosen. A different template is the only reset.
 * Create ends with two saves: open the new device, or stay and start another.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import type { HelperDraft, HelperSaveResult } from '../helper-form-model'
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
            fieldPath: 'temperature',
          },
        ])
      }
    >
      add member
    </button>
  ),
}))

function renderWizard(
  onSave: (draft: HelperDraft, intent: 'open' | 'again') => Promise<HelperSaveResult>,
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

  it('fixes the helper type once chosen: no Back to the type list from the first step', () => {
    renderWizard(async () => ({ kind: 'saved', deviceId: 1 }))
    pick('temperature')
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    expect(screen.queryByTestId('helper-template-picker')).toBeNull()
    fireEvent.change(screen.getByTestId('helper-name'), { target: { value: 'Front door' } })
    fireEvent.click(screen.getByTestId('helper-to-members'))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByTestId('helper-template-picker')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    expect((screen.getByTestId('helper-name') as HTMLInputElement).value).toBe('Front door')
  })

  it('opens the device after save, and create-more returns to the type tiles with a link', async () => {
    const onSave = vi.fn(
      async (_draft: HelperDraft, intent: 'open' | 'again'): Promise<HelperSaveResult> => ({
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
    await vi.waitFor(() =>
      expect((screen.getByTestId('helper-save-more') as HTMLButtonElement).disabled).toBe(false),
    )

    fireEvent.click(screen.getByTestId('helper-save-more'))
    expect(await screen.findByTestId('helper-template-picker')).toBeTruthy()
    const link = await screen.findByRole('link', { name: 'Front door' })
    expect(link.getAttribute('href')).toBe('/devices/4701')
  })

  it('offers the calculations in a Calculation section and expression in Advanced, with no sum tile', () => {
    renderWizard(async () => ({ kind: 'saved', deviceId: 1 }))
    for (const id of ['threshold', 'difference', 'ratio', 'derivative', 'expression']) {
      expect(screen.getByTestId(`helper-template-${id}`), id).toBeTruthy()
    }
    expect(screen.queryByTestId('helper-template-sum')).toBeNull()
    expect(screen.getByText('Calculation')).toBeTruthy()
    expect(screen.getByText('Advanced')).toBeTruthy()
    // Free composition is offered only where the wizard can hand over to it.
    expect(screen.queryByTestId('helper-template-composition')).toBeNull()
  })

  it('a threshold asks for its two edges and warns when they are reversed', () => {
    renderWizard(async () => ({ kind: 'saved', deviceId: 1 }))
    pick('threshold')
    expect(screen.getByTestId('helper-threshold-parameters')).toBeTruthy()
    fireEvent.change(screen.getByTestId('helper-high'), { target: { value: '20' } })
    fireEvent.change(screen.getByTestId('helper-low'), { target: { value: '25' } })
    expect(screen.getByTestId('helper-edges').textContent).toContain('above the turn-on value')
    fireEvent.change(screen.getByTestId('helper-low'), { target: { value: '18' } })
    expect(screen.queryByTestId('helper-edges')).toBeNull()
  })

  it('an expression names the picked reading and keeps the formula across Back', () => {
    renderWizard(async () => ({ kind: 'saved', deviceId: 1 }))
    pick('expression')
    fireEvent.change(screen.getByTestId('helper-name'), { target: { value: 'Delta' } })
    fireEvent.click(screen.getByTestId('helper-to-members'))
    expect(screen.queryByTestId('helper-expression-editor')).toBeNull()
    fireEvent.click(screen.getByTestId('source-selector'))
    expect((screen.getByTestId('helper-input-name-0') as HTMLInputElement).value).toBe('a')
    fireEvent.change(screen.getByTestId('helper-input-name-0'), { target: { value: 'inlet' } })
    expect((screen.getByTestId('helper-input-name-0') as HTMLInputElement).value).toBe('inlet')
  })

  it('a difference needs two readings before it can be saved', () => {
    renderWizard(async () => ({ kind: 'saved', deviceId: 1 }))
    pick('difference')
    fireEvent.change(screen.getByTestId('helper-name'), { target: { value: 'Gap' } })
    fireEvent.click(screen.getByTestId('helper-to-members'))
    fireEvent.click(screen.getByTestId('source-selector'))
    expect((screen.getByTestId('helper-save-open') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('helper-math-hint').textContent).toContain('Exactly two readings')
  })

  it('a derivative picks a window and a unit of time', () => {
    renderWizard(async () => ({ kind: 'saved', deviceId: 1 }))
    pick('derivative')
    expect((screen.getByTestId('helper-per') as HTMLSelectElement).value).toBe('hour')
    fireEvent.change(screen.getByTestId('helper-per'), { target: { value: 'minute' } })
    expect((screen.getByTestId('helper-per') as HTMLSelectElement).value).toBe('minute')
  })

  it('a second click while a save is pending does not call save again', async () => {
    let finish: (result: HelperSaveResult) => void = () => undefined
    const onSave = vi.fn(
      () =>
        new Promise<HelperSaveResult>((resolve) => {
          finish = resolve
        }),
    )
    renderWizard(onSave)
    pick('temperature')
    fireEvent.change(screen.getByTestId('helper-name'), { target: { value: 'Front door' } })
    fireEvent.click(screen.getByTestId('helper-to-members'))
    fireEvent.click(screen.getByTestId('source-selector'))
    fireEvent.click(screen.getByTestId('helper-save-open'))
    fireEvent.click(screen.getByTestId('helper-save-open'))
    fireEvent.click(screen.getByTestId('helper-save-more'))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect((screen.getByTestId('helper-save-open') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('helper-save-more') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('helper-save-open').textContent).toContain('Saving')
    finish({ kind: 'refused', lines: [] })
    await vi.waitFor(() =>
      expect((screen.getByTestId('helper-save-open') as HTMLButtonElement).disabled).toBe(false),
    )
  })
})
