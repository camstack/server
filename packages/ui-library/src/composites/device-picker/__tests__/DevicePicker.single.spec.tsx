/**
 * One source device: radios, no All/Clear, no "N selected", grouped by room.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DevicePicker } from '../DevicePicker'
import type { PickerDevice } from '../device-picker-model'

vi.mock('../../../contexts/system-context.js', () => ({
  useSystem: () => ({
    trpcClient: {
      deviceManager: { listSiteZones: { query: () => new Promise(() => undefined) } },
    },
  }),
}))

const DEVICES: readonly PickerDevice[] = [
  { id: 305, name: 'Porch power meter', type: 'sensor', location: 'Kitchen' },
  { id: 304, name: 'Garage lamp', type: 'light', location: 'Garage' },
]

function Harness({ seen }: { readonly seen: (next: readonly number[]) => void }) {
  const [value, setValue] = useState<readonly number[]>([])
  return (
    <DevicePicker
      devices={DEVICES}
      listState="answered"
      value={value}
      selection="single"
      groupBy="location"
      noun="device"
      showAll
      onChange={(next) => {
        seen(next)
        setValue(next)
      }}
    />
  )
}

describe('DevicePicker selection=single', () => {
  it('picks one device with a radio and groups by location', () => {
    const seen = vi.fn<(next: readonly number[]) => void>()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <Harness seen={seen} />
      </QueryClientProvider>,
    )
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'All' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
    expect(screen.queryByText(/selected/)).toBeNull()
    expect(screen.getByText('Kitchen')).toBeTruthy()
    expect(screen.getByText('Garage')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /Porch power meter/ }))
    expect(seen).toHaveBeenCalledWith([305])
    fireEvent.click(screen.getByRole('radio', { name: /Garage lamp/ }))
    expect(seen).toHaveBeenLastCalledWith([304])
  })
})
