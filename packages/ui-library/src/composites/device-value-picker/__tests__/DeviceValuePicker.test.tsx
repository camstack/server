// @vitest-environment jsdom
/**
 * <DeviceValuePicker> against a faked `deviceManager.search`.
 *
 *  - one matching value: the row shows its reading and picking it picks the value;
 *  - several: the row says how many and opens a second level (back page inline,
 *    in-place expansion in the popover variant);
 *  - the four states are four different answers (D315), and a failed query
 *    offers Retry instead of claiming "no device";
 *  - a picked device the hub no longer has stays, with Pick another / Remove;
 *  - a schema form keeps storing the device id as a string.
 */
import type { DeviceSearchItem, DeviceSearchResult } from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const temp = {
  cap: 'temperature-sensor',
  path: 'temperature',
  label: 'Temperature',
  reading: '22.3 °C',
}
const hum = { cap: 'temperature-sensor', path: 'humidity', label: 'Humidity', reading: '41 %' }

function device(id: number, name: string, values: DeviceSearchItem['values']): DeviceSearchItem {
  return {
    id,
    name,
    type: 'sensor',
    location: 'Kitchen',
    integrationId: 'hue',
    integrationLabel: 'Hue',
    online: true,
    disabled: false,
    compatible: true,
    values,
  } as unknown as DeviceSearchItem
}

const cucina = device(1, 'Cucina', [temp])
const stazione = device(2, 'Stazione meteo', [temp, hum])

function result(
  items: DeviceSearchItem[],
  over: Partial<DeviceSearchResult> = {},
): DeviceSearchResult {
  return {
    items,
    nextCursor: null,
    total: items.length,
    compatibleTotal: items.length,
    fleetTotal: 64,
    hiddenIncompatible: 0,
    facets: {
      locations: [
        { value: 'Kitchen', count: 2 },
        { value: 'Hall', count: 1 },
      ],
      integrations: [
        { id: 'hue', label: 'Hue', count: 3 },
        { id: 'zwave', label: 'Z-Wave', count: 1 },
      ],
      types: [
        { value: 'sensor', count: 3 },
        { value: 'plug', count: 1 },
      ],
    },
    suggested: [],
    missingIds: [],
    ...over,
  } as unknown as DeviceSearchResult
}

const state = {
  list: {
    data: result([cucina, stazione]) as DeviceSearchResult | undefined,
    isError: false,
    isPending: false,
  },
  resolved: { data: undefined as DeviceSearchResult | undefined },
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
  hasNextPage: false,
  lastQuery: undefined as unknown,
}

vi.mock('../../../trpc-react', () => ({
  trpc: {
    deviceManager: {
      search: {
        useInfiniteQuery: (query: unknown) => {
          state.lastQuery = query
          return {
            data: state.list.data === undefined ? undefined : { pages: [state.list.data] },
            isPending: state.list.isPending,
            isError: state.list.isError,
            isFetching: false,
            isFetchingNextPage: false,
            hasNextPage: state.hasNextPage,
            fetchNextPage: state.fetchNextPage,
            refetch: state.refetch,
          }
        },
      },
    },
  },
}))
vi.mock('../../../generated/system-hooks', () => ({
  useDeviceManagerSearch: () => ({ data: state.resolved.data, isError: false, isPending: false }),
}))

const { DeviceValuePicker } = await import('../DeviceValuePicker')
const { DeviceSelectFormField } = await import('../device-value-form-fields')

const requires = { caps: ['temperature-sensor'] }

beforeEach(() => {
  state.list = { data: result([cucina, stazione]), isError: false, isPending: false }
  state.resolved = { data: undefined }
  state.hasNextPage = false
  state.fetchNextPage.mockClear()
  state.refetch.mockClear()
  window.localStorage.clear()
})
afterEach(cleanup)

function openSingle(onChange = vi.fn(), variant: 'inline' | 'popover' = 'inline') {
  render(
    <DeviceValuePicker requires={requires} value={null} onChange={onChange} variant={variant} />,
  )
  fireEvent.click(screen.getByRole('button', { name: /select value/i }))
  return onChange
}

describe('DeviceValuePicker', () => {
  it('shows the reading of a one-value device and picks that value with the row', () => {
    const onChange = openSingle()
    expect(screen.getByText('22.3 °C')).toBeTruthy()
    expect(screen.getByText(/Temperature sensor · 2 matches of 64/)).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: /Cucina/ }))
    expect(onChange).toHaveBeenCalledWith({
      deviceId: 1,
      cap: 'temperature-sensor',
      path: 'temperature',
    })
  })

  it('opens a second level for a device with several values (inline: back page)', () => {
    const onChange = openSingle()
    fireEvent.click(screen.getByRole('option', { name: /Stazione meteo/ }))
    expect(screen.getByText('Humidity')).toBeTruthy()
    expect(screen.queryByText('Cucina')).toBeNull()
    fireEvent.click(screen.getByText('Humidity'))
    expect(onChange).toHaveBeenCalledWith({
      deviceId: 2,
      cap: 'temperature-sensor',
      path: 'humidity',
    })
  })

  it('expands in place in the popover variant, with the three facets collapsed on "any"', () => {
    openSingle(vi.fn(), 'popover')
    expect(screen.getAllByText('any')).toHaveLength(3)
    fireEvent.click(screen.getByRole('option', { name: /Stazione meteo/ }))
    expect(screen.getByText('Cucina')).toBeTruthy()
    expect(screen.getByText('Humidity')).toBeTruthy()
  })

  it('toggles values in multi mode and keeps the list open', () => {
    const onChange = vi.fn()
    render(<DeviceValuePicker multiple requires={requires} value={[]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /add device/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Cucina/ }))
    expect(onChange).toHaveBeenCalledWith([
      { deviceId: 1, cap: 'temperature-sensor', path: 'temperature' },
    ])
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('says one generic thing when no device provides the capability, and another for a search miss', async () => {
    state.list = { data: result([], { compatibleTotal: 0 }), isError: false, isPending: false }
    openSingle()
    expect(screen.getByText('No device provides Temperature sensor')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Search devices'), { target: { value: 'zzz' } })
    expect(await screen.findByText('No device with Temperature sensor matches “zzz”')).toBeTruthy()
  })

  it('a failed query is not an empty answer: it offers Retry', () => {
    state.list = { data: undefined, isError: true, isPending: false }
    openSingle()
    expect(screen.queryByText(/No device provides/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(state.refetch).toHaveBeenCalled()
  })

  it('shows a skeleton while the first page is pending', () => {
    state.list = { data: undefined, isError: false, isPending: true }
    openSingle()
    expect(screen.getByTestId('dvp-loading')).toBeTruthy()
    expect(screen.queryByText(/No device provides/)).toBeNull()
  })

  it('asks for the next cursor page near the bottom of the list', () => {
    state.hasNextPage = true
    openSingle()
    const scroll = screen.getByTestId('dvp-scroll')
    Object.defineProperty(scroll, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(scroll, 'clientHeight', { value: 300, configurable: true })
    fireEvent.scroll(scroll, { target: { scrollTop: 190 } })
    expect(state.fetchNextPage).toHaveBeenCalled()
  })

  it('keeps a picked device the hub no longer has, with Pick another / Remove', () => {
    state.resolved = { data: result([], { missingIds: [99] }) }
    const onChange = vi.fn()
    render(<DeviceValuePicker requires={requires} value={{ deviceId: 99 }} onChange={onChange} />)
    expect(screen.getByText('Device #99 not found')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pick another' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('does not call a device gone while the resolve has not answered (D315)', () => {
    render(<DeviceValuePicker requires={requires} value={{ deviceId: 99 }} onChange={vi.fn()} />)
    expect(screen.queryByText(/not found/)).toBeNull()
  })

  it('renders a picked value as device › value with its reading, never the location', () => {
    state.resolved = { data: result([stazione]) }
    render(
      <DeviceValuePicker
        requires={requires}
        value={{ deviceId: 2, cap: 'temperature-sensor', path: 'humidity' }}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByText('Stazione meteo › Humidity · 41 %')).toBeTruthy()
    expect(screen.queryByText(/Kitchen/)).toBeNull()
  })

  it('collapses chips after five with +N', () => {
    const many = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ deviceId: n }))
    render(<DeviceValuePicker multiple value={many} onChange={vi.fn()} />)
    expect(screen.getByText('+2')).toBeTruthy()
  })
})

describe('device-select form field', () => {
  it('round-trips the device id as a string and maps deviceFilter onto the search', () => {
    const onChange = vi.fn()
    render(
      <DeviceSelectFormField
        field={
          {
            key: 'src',
            type: 'device-select',
            label: 'Source',
            deviceFilter: { caps: ['temperature-sensor'] },
          } as never
        }
        value=""
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /select device/i }))
    expect(state.lastQuery).toMatchObject({ requires: { caps: ['temperature-sensor'] } })
    fireEvent.click(screen.getByRole('option', { name: /Stazione meteo/ }))
    expect(onChange).toHaveBeenCalledWith('2')
  })
})
