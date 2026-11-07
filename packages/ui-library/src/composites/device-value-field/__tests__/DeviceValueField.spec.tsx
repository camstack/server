import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactElement, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceValueField, type DeviceValueFieldProps } from '../device-value-field'

vi.mock('../../../contexts/system-context.js', () => ({
  useSystem: () => ({
    trpcClient: {
      deviceManager: {
        listSiteZones: { query: () => new Promise(() => undefined) },
      },
    },
  }),
}))

/** The REAL picker runs; only the viewport is faked (phone = below `sm`). */
function setPhone(phone: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === '(max-width: 639px)',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

function renderField(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const view = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
  return {
    rerender: (next: ReactElement) =>
      view.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>),
  }
}

const GROUPS = [
  {
    cap: 'power-meter',
    title: 'Power',
    rows: [{ cap: 'power-meter', path: 'power', label: 'Power', valueText: '8.4 W' }],
  },
  { cap: 'empty', title: 'Nothing', rows: [] },
]

function props(over: Partial<DeviceValueFieldProps> = {}): DeviceValueFieldProps {
  return {
    devices: [{ id: 1, name: 'Porch meter' }],
    listState: 'answered',
    deviceId: null,
    onDeviceChange: () => undefined,
    deviceLabel: 'Porch meter',
    valuesState: 'ready',
    groups: GROUPS,
    value: null,
    onValueChange: () => undefined,
    heading: 'Source',
    noDeviceText: 'Pick a device',
    noValuesText: 'No fitting value',
    ...over,
  }
}

function Stateful({ extra }: { readonly extra: Partial<DeviceValueFieldProps> }) {
  const [deviceId, setDeviceId] = useState<number | null>(null)
  const [value, setValue] = useState<DeviceValueFieldProps['value']>(null)
  return (
    <DeviceValueField
      {...props({
        ...extra,
        deviceId,
        onDeviceChange: setDeviceId,
        value,
        onValueChange: (pick) => {
          setValue(pick)
          extra.onValueChange?.(pick)
        },
      })}
    />
  )
}

const PICK = { cap: 'power-meter', path: 'power' }
const TWO_GROUPS = [
  ...GROUPS,
  {
    cap: 'numeric-sensor',
    title: 'Voltage',
    rows: [
      {
        cap: 'numeric-sensor',
        path: 'voltage',
        label: 'Voltage',
        valueText: '231 V',
      },
    ],
  },
]
const mode = () => screen.getByTestId('device-value-field').getAttribute('data-mode')

describe.each([
  ['phone', true],
  ['desktop', false],
])('DeviceValueField on %s', (_name, phone) => {
  beforeEach(() => setPhone(phone))

  it('create mode starts with the device list, no card', () => {
    renderField(<DeviceValueField {...props()} />)
    expect(mode()).toBe('picker')
    expect(screen.getByText('Porch meter')).toBeTruthy()
    expect(screen.queryByTestId('device-value-field-change')).toBeNull()
  })

  it('a chosen source is one compact card with the transform, proposal and preview, no back button', () => {
    renderField(
      <DeviceValueField
        {...props({
          deviceId: 1,
          value: PICK,
          transform: <i data-testid="tf">t</i>,
          proposal: <i data-testid="pr">p</i>,
          preview: <i data-testid="pv">v</i>,
        })}
      />,
    )
    expect(mode()).toBe('card')
    expect(screen.getByTestId('device-value-field-source').textContent).toBe(
      'Porch meter·Power8.4 WChange',
    )
    expect(screen.getByTestId('tf')).toBeTruthy()
    expect(screen.getByTestId('pr')).toBeTruthy()
    expect(screen.getByTestId('pv')).toBeTruthy()
    expect(screen.queryByTestId('device-value-field-back')).toBeNull()
  })

  it('the card appears when the device resolves after mount', () => {
    const { rerender } = renderField(
      <DeviceValueField {...props({ value: PICK, transform: <i data-testid="tf">t</i> })} />,
    )
    expect(mode()).toBe('picker')
    rerender(
      <DeviceValueField
        {...props({
          deviceId: 1,
          value: PICK,
          transform: <i data-testid="tf">t</i>,
        })}
      />,
    )
    expect(mode()).toBe('card')
    expect(screen.getByTestId('tf')).toBeTruthy()
  })

  it('Change opens the picker, a pick returns to the card with the new value', () => {
    const onValue = vi.fn()
    function Host() {
      const [value, setValue] = useState<DeviceValueFieldProps['value']>(PICK)
      return (
        <DeviceValueField
          {...props({
            deviceId: 1,
            value,
            groups: TWO_GROUPS,
            onValueChange: (pick) => {
              onValue(pick)
              setValue(pick)
            },
          })}
        />
      )
    }
    renderField(<Host />)
    fireEvent.click(screen.getByTestId('device-value-field-change'))
    expect(mode()).toBe('picker')
    fireEvent.click(screen.getByTestId('device-value-numeric-sensor.voltage'))
    expect(onValue).toHaveBeenCalledWith({
      cap: 'numeric-sensor',
      path: 'voltage',
    })
    expect(mode()).toBe('card')
    expect(screen.getByTestId('device-value-field-source').textContent).toContain('231 V')
  })

  it('Cancel returns to the unchanged card', () => {
    renderField(<DeviceValueField {...props({ deviceId: 1, value: PICK })} />)
    fireEvent.click(screen.getByTestId('device-value-field-change'))
    fireEvent.click(screen.getByTestId('device-value-field-cancel'))
    expect(mode()).toBe('card')
  })

  it('never lists an empty group and never reads an unanswered device as empty', () => {
    renderField(<DeviceValueField {...props({ deviceId: 1 })} />)
    expect(screen.queryByText('Nothing')).toBeNull()
    expect(screen.getByTestId('device-value-power-meter.power')).toBeTruthy()
    renderField(
      <DeviceValueField {...props({ deviceId: 1, valuesState: 'loading', groups: [] })} />,
    )
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.queryByText('No fitting value')).toBeNull()
  })
})

describe('DeviceValueField phone accordion', () => {
  beforeEach(() => setPhone(true))

  it('opens the picked device values inline, under it, one device at a time', () => {
    const onValue = vi.fn()
    function Host() {
      const [deviceId, setDeviceId] = useState<number | null>(null)
      const [value, setValue] = useState<DeviceValueFieldProps['value']>(null)
      return (
        <DeviceValueField
          {...props({
            devices: [
              { id: 1, name: 'Porch meter' },
              { id: 2, name: 'Garage lamp' },
            ],
            deviceId,
            onDeviceChange: setDeviceId,
            value,
            onValueChange: (pick) => {
              onValue(pick)
              setValue(pick)
            },
          })}
        />
      )
    }
    renderField(<Host />)
    expect(screen.queryByTestId('device-value-power-meter.power')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: /Porch meter/ }))
    expect(screen.getAllByTestId('device-value-field-values')).toHaveLength(1)
    fireEvent.click(screen.getByRole('radio', { name: /Garage lamp/ }))
    expect(screen.getAllByTestId('device-value-field-values')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('device-value-power-meter.power'))
    expect(onValue).toHaveBeenCalledWith(PICK)
    expect(mode()).toBe('card')
  })

  it('folds the open device when it is tapped again, and opens it on the next tap', () => {
    function Host() {
      const [deviceId, setDeviceId] = useState<number | null>(null)
      return <DeviceValueField {...props({ deviceId, onDeviceChange: setDeviceId })} />
    }
    renderField(<Host />)
    const radio = () => screen.getByRole('radio', { name: /Porch meter/ })
    fireEvent.click(radio())
    expect(screen.queryByTestId('device-value-power-meter.power')).toBeTruthy()
    fireEvent.click(radio())
    expect(screen.queryByTestId('device-value-power-meter.power')).toBeNull()
    fireEvent.click(radio())
    expect(screen.queryByTestId('device-value-power-meter.power')).toBeTruthy()
  })

  it('still shows the values below the list when the stored device has no row', () => {
    renderField(
      <DeviceValueField
        {...props({ devices: [{ id: 2, name: 'Garage lamp' }], deviceId: 1, value: PICK })}
      />,
    )
    fireEvent.click(screen.getByTestId('device-value-field-change'))
    expect(screen.queryByRole('radio', { name: /Porch meter/ })).toBeNull()
    expect(screen.getAllByTestId('device-value-field-values')).toHaveLength(1)
    expect(screen.getByTestId('device-value-power-meter.power')).toBeTruthy()
  })
})
