import { fireEvent, render, screen } from '@testing-library/react'
import { HotkeyProvider } from '@camstack/ui-library'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { copyOfPreset } from '../layout-presets'
import { RemoteGrid } from '../RemoteGrid'
import { TemplateEditorDialog } from '../TemplateEditorDialog'

const NEW_DRAFT = {
  id: null,
  kind: 'remote',
  name: '',
  payload: { columns: 3, rows: 4, buttons: [] },
} as const

describe('TemplateEditorDialog presets', () => {
  it('starting from a preset saves an editable copy named after it', () => {
    const onSave = vi.fn()
    render(
      <TemplateEditorDialog
        draft={NEW_DRAFT}
        saving={false}
        error={null}
        onSave={onSave}
        onClose={() => undefined}
      />,
    )
    fireEvent.change(screen.getByTestId('template-preset'), { target: { value: 'hisense-vidaa' } })
    fireEvent.click(screen.getByTestId('template-save'))
    expect(onSave).toHaveBeenCalledTimes(1)
    const saved = onSave.mock.calls[0]?.[0]
    expect(saved.name).toBe('Hisense VIDAA')
    expect(saved.payload).toEqual(copyOfPreset('hisense-vidaa'))
  })

  it('offers the presets only when creating', () => {
    render(
      <TemplateEditorDialog
        draft={{ ...NEW_DRAFT, id: 'existing' }}
        saving={false}
        error={null}
        onSave={() => undefined}
        onClose={() => undefined}
      />,
    )
    expect(screen.queryByTestId('template-preset')).toBeNull()
  })
})

describe('RemoteGrid app keys', () => {
  it('draws a brand glyph and names the button after the brand', () => {
    render(
      <RemoteGrid
        label="grid"
        grid={{
          columns: 2,
          rows: 1,
          buttons: [
            {
              id: 'a',
              row: 0,
              col: 0,
              rowSpan: 1,
              colSpan: 1,
              role: 'custom:n',
              icon: 'app:netflix',
            },
            {
              id: 'b',
              row: 0,
              col: 1,
              rowSpan: 1,
              colSpan: 1,
              role: 'custom:d',
              icon: 'app:disneyplus',
            },
          ],
        }}
      />,
    )
    const netflix = screen.getByTestId('remote-grid-button-a')
    expect(netflix.getAttribute('aria-label')).toBe('Netflix')
    expect(netflix.querySelector('svg path')).not.toBeNull()
    expect(screen.getByTestId('remote-grid-button-b').textContent).toBe('D+')
  })
})

describe('TemplateEditorDialog edit history', () => {
  const open = (): void => {
    render(
      <HotkeyProvider platform="other">
        <TemplateEditorDialog
          draft={NEW_DRAFT}
          saving={false}
          error={null}
          onSave={() => undefined}
          onClose={() => undefined}
        />
      </HotkeyProvider>,
    )
  }
  it('has nothing to undo until something changes', () => {
    open()
    expect((screen.getByTestId('template-undo') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('template-redo') as HTMLButtonElement).disabled).toBe(true)
  })

  it('undo and redo move between the blank layout and a chosen preset', () => {
    open()
    const gridButtons = (): number => screen.queryAllByTestId(/^remote-grid-button-/).length
    expect(gridButtons()).toBe(0)
    fireEvent.change(screen.getByTestId('template-preset'), { target: { value: 'hisense-vidaa' } })
    const withPreset = gridButtons()
    expect(withPreset).toBeGreaterThan(0)
    fireEvent.click(screen.getByTestId('template-undo'))
    expect(gridButtons()).toBe(0)
    fireEvent.click(screen.getByTestId('template-redo'))
    expect(gridButtons()).toBe(withPreset)
  })

  it('binds mod+Z and mod+shift+Z through the hotkey registry', () => {
    open()
    const gridButtons = (): number => screen.queryAllByTestId(/^remote-grid-button-/).length
    fireEvent.change(screen.getByTestId('template-preset'), { target: { value: 'hisense-vidaa' } })
    const withPreset = gridButtons()
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    expect(gridButtons()).toBe(0)
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(gridButtons()).toBe(withPreset)
  })
})
