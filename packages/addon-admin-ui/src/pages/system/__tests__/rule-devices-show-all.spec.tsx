/**
 * R15 (D690): the rule's Devices tab lists EVERY device — always open, no
 * "Add…" to reveal it, no "Show N more", no "+N more" chip, and a big group
 * open like every other.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useSystem: () => ({
      trpcClient: { deviceManager: { listSiteZones: { query: () => Promise.resolve([]) } } },
    }),
  }
})

import { SystemProvider } from '@camstack/ui-library'
import { PICKER_PAGE_SIZE } from '../device-picker-model'
import { NotificationRuleDevices } from '../NotificationRuleDevices'
import { pickerSystem } from './picker-system'

/** More sensors of ONE type in ONE room than a page holds. */
const MANY = Array.from({ length: PICKER_PAGE_SIZE + 15 }, (_, i) => ({
  id: i + 1,
  name: `Sensore ${String(i + 1).padStart(3, '0')}`,
  type: 'sensor',
  location: 'Cantina',
}))

function mount(value: readonly number[]): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SystemProvider system={pickerSystem()}>
        <NotificationRuleDevices
          devices={MANY}
          value={value}
          onChange={() => {}}
          listState="answered"
          savedHadDevices={false}
        />
      </SystemProvider>
    </QueryClientProvider>,
  )
}

describe('the rule Devices tab shows every device (R15)', () => {
  it('draws every row, open, with no reveal or paging control', () => {
    mount([])
    expect(screen.getByTestId('device-picker-panel')).toBeTruthy()
    for (const device of MANY) expect(screen.getByText(device.name)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Add devices/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).toBeNull()
  })

  it('draws every selected chip — no "+N more"', () => {
    mount(MANY.slice(0, 10).map((d) => d.id))
    expect(screen.queryByRole('button', { name: /\+\d+ more/ })).toBeNull()
    for (const device of MANY.slice(0, 10)) {
      expect(screen.getByTestId(`picker-chip-${String(device.id)}`)).toBeTruthy()
    }
  })
})
