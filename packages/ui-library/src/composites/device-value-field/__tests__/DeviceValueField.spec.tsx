import { type DeviceSearchItem, type DeviceSearchResult, DeviceType } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactElement, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function device(id: number, name: string): DeviceSearchItem {
  return {
    id,
    name,
    type: DeviceType.Switch,
    location: 'Porch',
    integrationId: 'hue',
    integrationLabel: 'Hue',
    online: true,
    disabled: false,
    compatible: true,
    values: [],
  }
}

function answer(items: readonly DeviceSearchItem[]): DeviceSearchResult {
  return {
    items: [...items],
    nextCursor: null,
    total: items.length,
    compatibleTotal: items.length,
    fleetTotal: 40,
    hiddenIncompatible: 0,
    facets: { locations: [], integrations: [], types: [] },
    suggested: [],
    missingIds: [],
  }
}

/** The device column is the picker panel over `deviceManager.search`; only the query is faked. */
const search = {
  data: answer([device(1, 'Porch meter'), device(2, 'Garage lamp')]) as
    | DeviceSearchResult
    | undefined,
  isError: false,
  lastQuery: undefined as unknown,
  refetch: vi.fn(),
}

vi.mock('../../../trpc-react', () => ({
  trpc: {
    deviceManager: {
      search: {
        useInfiniteQuery: (query: unknown) => {
          search.lastQuery = query
          return {
            data: search.data === undefined ? undefined : { pages: [search.data] },
            isPending: search.data === undefined && !search.isError,
            isError: search.isError,
            isFetching: false,
            isFetchingNextPage: false,
            hasNextPage: false,
            fetchNextPage: () => undefined,
            refetch: search.refetch,
          }
        },
      },
    },
  },
}))
vi.mock('../../../generated/system-hooks', () => ({
  useDeviceManagerSearch: () => ({ data: undefined, isError: false, isPending: false }),
}))

const { DeviceValueField } = await import('../device-value-field')
type DeviceValueFieldProps = import('../device-value-field').DeviceValueFieldProps

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
    requires: { caps: ['power-meter'] },
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
  beforeEach(() => {
    setPhone(phone)
    search.data = answer([device(1, 'Porch meter'), device(2, 'Garage lamp')])
    search.isError = false
  })

  it('create mode starts with the device list, no card', () => {
    renderField(<DeviceValueField {...props()} />)
    expect(mode()).toBe('picker')
    expect(screen.getByText('Porch meter')).toBeTruthy()
    expect(screen.queryByTestId('device-value-field-change')).toBeNull()
  })

  it('pickerOnly keeps the two columns with the chosen value selected, never the card', () => {
    renderField(<DeviceValueField {...props({ deviceId: 1, value: PICK, pickerOnly: true })} />)
    expect(mode()).toBe('picker')
    expect(screen.queryByTestId('device-value-field-change')).toBeNull()
    const row = screen.getByTestId('device-value-power-meter.power')
    expect(row instanceof HTMLInputElement && row.checked).toBe(true)
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

describe('DeviceValueField device column', () => {
  beforeEach(() => {
    setPhone(false)
    search.data = answer([device(1, 'Porch meter'), device(2, 'Garage lamp')])
    search.isError = false
    window.localStorage.clear()
  })

  it('asks the search for the devices that provide the required caps, never the host', () => {
    renderField(<DeviceValueField {...props({ contextDeviceId: 7 })} />)
    expect(search.lastQuery).toMatchObject({
      requires: { caps: ['power-meter'] },
      contextDeviceId: 7,
    })
    search.data = answer([device(7, 'The host'), device(1, 'Porch meter')])
    renderField(<DeviceValueField {...props({ contextDeviceId: 7 })} />)
    expect(screen.queryByRole('option', { name: /The host/ })).toBeNull()
  })

  it('a picked row reports the device, and its fitting values follow', () => {
    const onValue = vi.fn()
    function Host() {
      const [deviceId, setDeviceId] = useState<number | null>(null)
      const [value, setValue] = useState<DeviceValueFieldProps['value']>(null)
      return (
        <DeviceValueField
          {...props({
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
    fireEvent.click(screen.getByRole('option', { name: /Porch meter/ }))
    fireEvent.click(screen.getByTestId('device-value-power-meter.power'))
    expect(onValue).toHaveBeenCalledWith(PICK)
    expect(mode()).toBe('card')
  })

  it('a failed device search is not an empty list: it offers Retry (D315)', () => {
    search.data = undefined
    search.isError = true
    renderField(<DeviceValueField {...props()} />)
    expect(screen.queryByText(/No device provides/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(search.refetch).toHaveBeenCalled()
  })
})
