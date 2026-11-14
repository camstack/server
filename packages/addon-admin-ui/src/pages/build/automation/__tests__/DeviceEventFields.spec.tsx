/**
 * The "device event" trigger offers the events the vocabulary declares for the
 * selected device: an explicit empty state when it declares none, never the
 * global category list, and a stored automation loads unchanged.
 */
import type { AutomationLeaf } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../../i18n'

type Caps =
  | { status: 'success'; data: readonly string[] }
  | { status: 'pending' }
  | { status: 'error' }

const answers = new Map<number, Caps>()

vi.mock('../../../../components/device-do-action/use-device-bound-caps', () => ({
  useDeviceBoundCaps: (deviceId: number) => answers.get(deviceId) ?? { status: 'pending' },
}))

vi.mock('../../../../../../ui-library/src/contexts/system-context.js', () => ({
  useSystem: () => ({
    trpcClient: {
      deviceManager: { listSiteZones: { query: () => new Promise(() => undefined) } },
    },
  }),
}))

import { DeviceSearchTrpc, SEARCH_HUB_FLEET } from '../../../../test-setup/device-search-hub'
import type { AutomationDevice } from '../automation-data'
import { fleetEventOptions } from '../event-trigger-options'
import { DeviceEventFields } from '../EventFields'

type DeviceEventLeaf = Extract<AutomationLeaf, { kind: 'device-event' }>

const DEVICES: readonly AutomationDevice[] = [
  { id: 401, name: 'Front doorbell', stableId: 'doorbell.front', type: 'doorbell' },
  { id: 402, name: 'Hall lamp', stableId: 'light.hall', type: 'light' },
]

function mount(leaf: DeviceEventLeaf, onChange: (next: DeviceEventLeaf) => void = () => {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DeviceSearchTrpc fleet={SEARCH_HUB_FLEET}>
        <DeviceEventFields leaf={leaf} devices={DEVICES} onChange={onChange} />
      </DeviceSearchTrpc>
    </QueryClientProvider>,
  )
}

/** Opens the select and returns the labels of its options. */
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

describe('DeviceEventFields — events come from the vocabulary', () => {
  it('a device with declared events offers those, not every EventCategory', () => {
    answers.set(401, { status: 'success', data: ['doorbell', 'battery'] })
    mount({ kind: 'device-event', category: '', deviceId: 401 })
    const labels = optionLabels()
    expect(labels).toContain(labelOf('doorbell.onPressed'))
    expect(labels).not.toContain(labelOf('running.started'))
    expect(labels.length).toBeLessThan(Object.values(EventCategory).length)
  })

  it('a device that declares no event shows an explicit empty state, never the global list', () => {
    answers.set(402, { status: 'success', data: ['switch'] })
    mount({ kind: 'device-event', category: '', deviceId: 402 })
    expect(screen.getByTestId('trigger-event-none')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('says so while the device’s caps are not answered, and when they failed', () => {
    mount({ kind: 'device-event', category: '', deviceId: 401 })
    expect(screen.getByTestId('trigger-event-loading')).toBeTruthy()
    expect(screen.queryByTestId('trigger-event-none')).toBeNull()
    cleanup()
    answers.set(401, { status: 'error' })
    mount({ kind: 'device-event', category: '', deviceId: 401 })
    expect(screen.getByTestId('trigger-event-failed')).toBeTruthy()
  })

  it('with no device picked it offers the vocabulary’s events, still not the enum', () => {
    mount({ kind: 'device-event', category: '' })
    const labels = optionLabels()
    expect(labels).toContain(labelOf('doorbell.onPressed'))
    expect(labels.length).toBeLessThan(Object.values(EventCategory).length)
  })
})

describe('DeviceEventFields — stored automations load unchanged', () => {
  it('a stored category the device declares is selected as it was saved', () => {
    answers.set(401, { status: 'success', data: ['doorbell'] })
    const stored: DeviceEventLeaf = {
      kind: 'device-event',
      category: 'doorbell.onPressed',
      deviceId: 401,
    }
    const seen: DeviceEventLeaf[] = []
    mount(stored, (next) => seen.push(next))
    expect(screen.getByRole('combobox').textContent).toContain(labelOf('doorbell.onPressed'))
    expect(seen).toEqual([])
  })

  it('a stored category with no device stays selected', () => {
    mount({ kind: 'device-event', category: 'doorbell.onPressed' })
    expect(screen.getByRole('combobox').textContent).toContain(labelOf('doorbell.onPressed'))
  })

  it('a stored category the device no longer declares stays visible, flagged', () => {
    answers.set(401, { status: 'success', data: ['doorbell'] })
    mount({ kind: 'device-event', category: 'motion.on-motion-changed', deviceId: 401 })
    const text = screen.getByRole('combobox').textContent ?? ''
    expect(text).toContain('motion.on-motion-changed')
    expect(text).toMatch(/not declared/i)
  })
})
