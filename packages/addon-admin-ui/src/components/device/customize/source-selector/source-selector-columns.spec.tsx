import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SourceSelectorColumns } from './source-selector-columns'

describe('SourceSelectorColumns', () => {
  it('hides the values on the device step and shows Done for members', () => {
    const onDone = vi.fn()
    render(
      <SourceSelectorColumns
        step="devices"
        devices={<p>devices</p>}
        values={<p>values</p>}
        back={{ label: 'Porch', ariaLabel: 'Back to Porch' }}
        onBack={() => undefined}
        done={{ countLabel: '2 selected', label: 'Done', disabled: false }}
        onDone={onDone}
      />,
    )
    expect(screen.getByTestId('source-selector-values').className).toContain('hidden')
    expect(screen.getByTestId('source-selector-devices').className).toBe('')
    expect(screen.getByTestId('source-selector-picked-count').textContent).toBe('2 selected')
    fireEvent.click(screen.getByTestId('source-selector-done'))
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('shows the device name as the way back and keeps Done off the values step', () => {
    const onBack = vi.fn()
    render(
      <SourceSelectorColumns
        step="values"
        devices={<p>devices</p>}
        values={<p>timeout</p>}
        back={{ label: 'Porch motion sensor', ariaLabel: 'Back to Porch motion sensor' }}
        onBack={onBack}
        done={null}
        onDone={() => undefined}
      />,
    )
    expect(screen.getByTestId('source-selector-devices').className).toContain('hidden')
    expect(screen.getByTestId('source-selector-values').className).toBe('')
    const back = screen.getByTestId('source-selector-back')
    expect(back.textContent).toContain('Porch motion sensor')
    expect(back.getAttribute('aria-label')).toBe('Back to Porch motion sensor')
    expect(screen.queryByTestId('source-selector-done')).toBeNull()
    fireEvent.click(back)
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('does not offer Done when nothing is picked', () => {
    render(
      <SourceSelectorColumns
        step="devices"
        devices={<p>devices</p>}
        values={<p>values</p>}
        back={null}
        onBack={() => undefined}
        done={{ countLabel: '0 selected', label: 'Done', disabled: true }}
        onDone={() => undefined}
      />,
    )
    expect(screen.getByTestId('source-selector-done')).toBeDisabled()
  })
})
