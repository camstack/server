/**
 * `fillHeight`: the panel stretches to a flex parent and the ROWS scroll
 * inside it, instead of a fixed cap or a content-height box.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DevicePicker } from '../DevicePicker'
import type { PickerDevice } from '../device-picker-model'

vi.mock('../../../contexts/system-context.js', () => ({
  useSystem: () => ({
    trpcClient: {
      deviceManager: {
        listSiteZones: { query: () => new Promise(() => undefined) },
      },
    },
  }),
}))

const DEVICES: readonly PickerDevice[] = [
  { id: 1, name: 'Porch power meter', type: 'sensor', location: 'Kitchen' },
]

function renderPicker(fillHeight: boolean): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <DevicePicker
        devices={DEVICES}
        listState="answered"
        value={[]}
        selection="single"
        noun="device"
        showAll
        fillHeight={fillHeight}
        onChange={() => undefined}
      />
    </QueryClientProvider>,
  )
}

describe('DevicePicker fillHeight', () => {
  it('stretches the panel and scrolls the rows inside it', () => {
    renderPicker(true)
    expect(screen.getByTestId('device-picker-panel').className).toContain('flex-1')
    const rows = screen.getByTestId('device-picker-rows')
    expect(rows.className).toContain('overflow-y-auto')
    expect(rows.className).toContain('min-h-0')
  })

  it('keeps the content-height list without it', () => {
    renderPicker(false)
    expect(screen.getByTestId('device-picker-panel').className).not.toContain('flex-1')
    expect(screen.getByTestId('device-picker-rows').className).not.toContain('overflow-y-auto')
  })
})
