/**
 * The event source selector, category host: the events the vocabulary declares
 * for the selected device. An explicit empty state when it declares none, the
 * fleet-wide vocabulary when no device is picked, and a stored category the
 * device does not declare stays selected, flagged.
 */
import { EventCategory } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'

type Caps =
  | { status: 'success'; data: readonly string[] }
  | { status: 'pending' }
  | { status: 'error' }

const answers = new Map<number, Caps>()

vi.mock('../../../../device-do-action/use-device-bound-caps', () => ({
  useDeviceBoundCaps: (deviceId: number) => answers.get(deviceId) ?? { status: 'pending' },
}))

vi.mock('../../../../../../../ui-library/src/contexts/system-context.js', () => ({
  useSystem: () => ({
    trpcClient: {
      deviceManager: { listSiteZones: { query: () => new Promise(() => undefined) } },
    },
  }),
}))

import { DeviceSearchTrpc, SEARCH_HUB_FLEET } from '../../../../../test-setup/device-search-hub'
import { fleetEventOptions } from '../event-category-options'
import { SourceSelector } from '../SourceSelector'

const KNOWN = [
  { id: 401, name: 'Front doorbell', type: 'doorbell' },
  { id: 402, name: 'Hall lamp', type: 'light' },
]

function mount(
  deviceId: number | null,
  category: string,
  onCategoryChange: (category: string) => void = () => undefined,
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DeviceSearchTrpc fleet={SEARCH_HUB_FLEET}>
        <SourceSelector
          kind="event"
          shape="category"
          devicePickerTestId="trigger-event-device"
          deviceId={deviceId}
          category={category}
          knownDevices={KNOWN}
          onDeviceChange={() => undefined}
          onCategoryChange={onCategoryChange}
        />
      </DeviceSearchTrpc>
    </QueryClientProvider>,
  )
}

function optionLabels(): readonly string[] {
  fireEvent.click(screen.getByRole('combobox'))
  return screen.getAllByRole('option').map((o) => o.textContent ?? '')
}

const labelOf = (category: string): string => {
  const found = fleetEventOptions('en').find((o) => o.value === category)
  if (found === undefined) throw new Error(`no declared event ${category}`)
  return found.label
}

afterEach(() => {
  cleanup()
  answers.clear()
})

describe('event category source — events come from the vocabulary', () => {
  it('a device with declared events offers those, not every EventCategory', () => {
    answers.set(401, { status: 'success', data: ['doorbell', 'battery'] })
    mount(401, '')
    const labels = optionLabels()
    expect(labels).toContain(labelOf('doorbell.onPressed'))
    expect(labels).not.toContain(labelOf('running.started'))
    expect(labels.length).toBeLessThan(Object.values(EventCategory).length)
  })

  it('a device that declares no event shows an explicit empty state, never the global list', () => {
    answers.set(402, { status: 'success', data: ['switch'] })
    mount(402, '')
    expect(screen.getByTestId('trigger-event-none')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('says so while the device’s caps are not answered, and when they failed', () => {
    mount(401, '')
    expect(screen.getByTestId('trigger-event-loading')).toBeTruthy()
    expect(screen.queryByTestId('trigger-event-none')).toBeNull()
    cleanup()
    answers.set(401, { status: 'error' })
    mount(401, '')
    expect(screen.getByTestId('trigger-event-failed')).toBeTruthy()
  })

  it('with no device picked it offers the vocabulary’s events, still not the enum', () => {
    mount(null, '')
    const labels = optionLabels()
    expect(labels).toContain(labelOf('doorbell.onPressed'))
    expect(labels.length).toBeLessThan(Object.values(EventCategory).length)
  })
})

describe('event category source — a stored category stays', () => {
  it('a stored category the device declares is selected as it was saved', () => {
    answers.set(401, { status: 'success', data: ['doorbell'] })
    const seen: string[] = []
    mount(401, 'doorbell.onPressed', (next) => seen.push(next))
    expect(screen.getByRole('combobox').textContent).toContain(labelOf('doorbell.onPressed'))
    expect(seen).toEqual([])
  })

  it('a stored category with no device stays selected', () => {
    mount(null, 'doorbell.onPressed')
    expect(screen.getByRole('combobox').textContent).toContain(labelOf('doorbell.onPressed'))
  })

  it('a stored category the device no longer declares stays visible, flagged', () => {
    answers.set(401, { status: 'success', data: ['doorbell'] })
    mount(401, 'motion.on-motion-changed')
    const text = screen.getByRole('combobox').textContent ?? ''
    expect(text).toContain('motion.on-motion-changed')
    expect(text).toMatch(/not declared/i)
  })
})
