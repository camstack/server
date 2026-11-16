/** The shared Quick edit modal collects a name and tags; the section does the save. */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../../i18n'
import { QuickEditDialog } from '../QuickEditDialog'

function open(onSave = vi.fn(), saving = false) {
  render(
    <QuickEditDialog
      subject={{ name: 'Feed the dog', tags: ['Pets'] }}
      subjectKey="a1"
      saving={saving}
      error={null}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  )
  return onSave
}

describe('QuickEditDialog', () => {
  it('opens on the stored name and tags and saves a changed name with the tags kept', () => {
    const onSave = open()
    const name = screen.getByTestId('quick-edit-name')
    expect((name as HTMLInputElement).value).toBe('Feed the dog')
    expect(screen.getByText('Pets')).toBeTruthy()
    fireEvent.change(name, { target: { value: '  Feed the cat ' } })
    fireEvent.click(screen.getByTestId('quick-edit-save'))
    expect(onSave).toHaveBeenCalledWith({ name: 'Feed the cat', tags: ['Pets'] })
  })

  it('cannot save a blank name', () => {
    const onSave = open()
    fireEvent.change(screen.getByTestId('quick-edit-name'), { target: { value: ' ' } })
    const save = screen.getByTestId('quick-edit-save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(onSave).not.toHaveBeenCalled()
  })
})
