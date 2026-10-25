/**
 * The unit selector, and the bug it shipped with.
 *
 * The unit used to be DERIVED from the stored config on every render. Picking
 * "GB of free space" with no value yet clears both keys — deliberately, 10%
 * and 10 GB are not the same reserve — so the next render read the config back
 * as `percent` and the selector snapped to the unit the operator had just left.
 * Whatever they typed then went into `minFreePercent`. These tests fail on
 * that version.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'
import { ProtectionPolicyField } from '../ProtectionPolicyField'

afterEach(() => {
  cleanup()
})

type ChangeSpy = Mock<(config: Record<string, unknown>) => void>

/**
 * Render the field with LIVE config: `onChange` feeds the next config straight
 * back in, exactly as the Edit modal's `setConfig` does. A test that renders a
 * frozen config cannot see this bug at all.
 */
function renderField(initial: Record<string, unknown>): ChangeSpy {
  const onChange: ChangeSpy = vi.fn()
  let config = initial
  const view = render(<ProtectionPolicyField config={config} onChange={onChange} />)
  onChange.mockImplementation((next) => {
    config = next
    view.rerender(<ProtectionPolicyField config={config} onChange={onChange} />)
  })
  return onChange
}

function unitSelect(): HTMLSelectElement {
  const el = screen.getByLabelText('Protection unit')
  if (!(el instanceof HTMLSelectElement)) throw new Error('unit control is not a select')
  return el
}

function valueInput(): HTMLInputElement {
  const el = screen.getByRole('spinbutton')
  if (!(el instanceof HTMLInputElement)) throw new Error('value control is not an input')
  return el
}

describe('ProtectionPolicyField — the unit selector', () => {
  it('starts on the unit the stored config expresses', () => {
    renderField({ basePath: '/recordings', minFreeGb: 200 })
    expect(unitSelect().value).toBe('gb')
    expect(valueInput().value).toBe('200')
  })

  it('defaults to percent on a location that stores neither key', () => {
    renderField({ basePath: '/recordings' })
    expect(unitSelect().value).toBe('percent')
    expect(valueInput().value).toBe('')
  })

  it('KEEPS the unit the operator picked, with no value typed yet', () => {
    renderField({ basePath: '/recordings', minFreePercent: 10 })
    fireEvent.change(unitSelect(), { target: { value: 'gb' } })
    expect(unitSelect().value).toBe('gb')
    expect(valueInput().value).toBe('')
  })

  it('writes the value under the picked unit, and clears the other key', () => {
    const onChange = renderField({ basePath: '/recordings', minFreePercent: 10 })
    fireEvent.change(unitSelect(), { target: { value: 'gb' } })
    fireEvent.change(valueInput(), { target: { value: '200' } })
    const written = onChange.mock.calls.at(-1)?.[0]
    expect(written).toEqual({ basePath: '/recordings', minFreeGb: 200 })
    expect(unitSelect().value).toBe('gb')
    expect(valueInput().value).toBe('200')
  })

  it('works the other way round too', () => {
    const onChange = renderField({ basePath: '/recordings', minFreeGb: 200 })
    fireEvent.change(unitSelect(), { target: { value: 'percent' } })
    fireEvent.change(valueInput(), { target: { value: '15' } })
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
      basePath: '/recordings',
      minFreePercent: 15,
    })
    expect(unitSelect().value).toBe('percent')
  })

  it('clears the value back to the default without switching unit', () => {
    const onChange = renderField({ basePath: '/recordings', minFreeGb: 200 })
    fireEvent.change(valueInput(), { target: { value: '' } })
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ basePath: '/recordings' })
    expect(unitSelect().value).toBe('gb')
  })

  it('leaves every other config key alone', () => {
    const onChange = renderField({ basePath: '/recordings', maxUsedGb: 900, secret: 'x' })
    fireEvent.change(valueInput(), { target: { value: '12' } })
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
      basePath: '/recordings',
      maxUsedGb: 900,
      secret: 'x',
      minFreePercent: 12,
    })
  })

  it('shows a stored maxUsedGb as system-managed rather than dropping it', () => {
    renderField({ basePath: '/recordings', maxUsedGb: 900 })
    expect(screen.getByText(/maximum used size of 900 GB/i)).toBeTruthy()
    expect(screen.getByText(/managed by the system now/i)).toBeTruthy()
  })

  it('says what the protected space is for and what happens at the limit', () => {
    renderField({ basePath: '/recordings' })
    const help = screen.getByText(/CamStack keeps/)
    expect(help.textContent).toMatch(/OLDEST data/)
    expect(help.textContent).toMatch(/another location/)
    expect(help.textContent).toMatch(/10% of the volume \(the default\)/)
  })
})
