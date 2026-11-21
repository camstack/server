/**
 * The shared quick-modal shell: inline name and tags report one patch each, the
 * enable switch reports its flip, the Open button leaves for the editor.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../../i18n'
import { BuildQuickModal, type BuildQuickModalProps } from '../BuildQuickModal'

function shell(patch: Partial<BuildQuickModalProps> = {}): BuildQuickModalProps {
  return {
    subjectKey: 'a',
    name: 'Porch light',
    tags: ['Garden'],
    saving: false,
    error: null,
    onSave: vi.fn(),
    openLabel: 'Open automation',
    onOpen: vi.fn(),
    onClose: vi.fn(),
    children: <p>body</p>,
    ...patch,
  }
}

describe('BuildQuickModal', () => {
  it('commits a renamed field on blur with the stored tags', () => {
    const props = shell()
    render(<BuildQuickModal {...props} />)
    const name = screen.getByTestId('quick-modal-name')
    fireEvent.change(name, { target: { value: '  Porch lamp ' } })
    fireEvent.blur(name)
    expect(props.onSave).toHaveBeenCalledWith({ name: 'Porch lamp', tags: ['Garden'] })
  })

  it('does not save an unchanged or blank name', () => {
    const props = shell()
    render(<BuildQuickModal {...props} />)
    const name = screen.getByTestId('quick-modal-name') as HTMLInputElement
    fireEvent.blur(name)
    fireEvent.change(name, { target: { value: '   ' } })
    fireEvent.blur(name)
    expect(props.onSave).not.toHaveBeenCalled()
    expect(name.value).toBe('Porch light')
  })

  it('a tag added saves the new list with the shown name', () => {
    const props = shell()
    render(<BuildQuickModal {...props} />)
    const input = screen.getByLabelText('Tags')
    fireEvent.change(input, { target: { value: 'Night' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onSave).toHaveBeenCalledWith({ name: 'Porch light', tags: ['Garden', 'Night'] })
  })

  it('the enable switch reports the flip, and is absent for a kind without one', () => {
    const onEnabledChange = vi.fn()
    const { unmount } = render(<BuildQuickModal {...shell({ enabled: true, onEnabledChange })} />)
    fireEvent.click(screen.getByTestId('quick-modal-enabled'))
    expect(onEnabledChange).toHaveBeenCalledWith(false)
    unmount()
    render(<BuildQuickModal {...shell()} />)
    expect(screen.queryByTestId('quick-modal-enabled')).toBeNull()
  })

  it('the Open button calls onOpen', () => {
    const props = shell()
    render(<BuildQuickModal {...props} />)
    fireEvent.click(screen.getByTestId('quick-modal-open'))
    expect(props.onOpen).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Open automation')).toBeTruthy()
  })

  it('a read-only item shows its name without an input', () => {
    render(<BuildQuickModal {...shell({ readOnly: true })} />)
    expect(screen.queryByTestId('quick-modal-name')).toBeNull()
    expect(screen.getAllByText('Porch light').length).toBeGreaterThan(0)
  })
})
