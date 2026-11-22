// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapLinkCell } from '../cap-link-cell'

vi.mock('../device-value-picker', () => ({
  DeviceValuePicker: (props: {
    readonly testId?: string
    readonly value: { deviceId: number } | null
    readonly requires?: { caps?: readonly string[] }
    readonly onChange: (picked: { deviceId: number } | null) => void
  }) => (
    <button
      type="button"
      data-testid={props.testId}
      onClick={() => props.onChange({ deviceId: 7 })}
    >
      {props.value === null ? 'none' : `device ${props.value.deviceId}`}:
      {(props.requires?.caps ?? []).join(',')}
    </button>
  ),
}))

afterEach(cleanup)

describe('CapLinkCell', () => {
  it('offers the devices of the source cap and reports the pick as a device id', () => {
    const onChange = vi.fn()
    render(
      <CapLinkCell
        deviceId={1}
        sourceCap="heat-pump-status"
        sourceDeviceId={null}
        state="unlinked"
        onChange={onChange}
        testId="link"
      />,
    )
    const picker = screen.getByTestId('link-picker')
    expect(picker.textContent).toBe('none:heat-pump-status')
    fireEvent.click(picker)
    expect(onChange).toHaveBeenCalledWith(7)
  })

  it('says a stored link lost its source or was switched off, and shows the refusal', () => {
    const { rerender } = render(
      <CapLinkCell
        deviceId={1}
        sourceCap="power-meter"
        sourceDeviceId={null}
        state="source-gone"
        onChange={vi.fn()}
        testId="link"
      />,
    )
    expect(screen.getByTestId('link-gone')).toBeTruthy()
    rerender(
      <CapLinkCell
        deviceId={1}
        sourceCap="power-meter"
        sourceDeviceId={3}
        state="disabled"
        error="link-overlaps-fields: power"
        onChange={vi.fn()}
        testId="link"
      />,
    )
    expect(screen.getByTestId('link-disabled')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('link-overlaps-fields')
  })
})
