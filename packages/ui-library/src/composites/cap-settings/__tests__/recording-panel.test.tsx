// @vitest-environment jsdom
/**
 * RecordingPanel wiring: Settings is always visible (not a collapsed
 * Advanced drawer), and profile toggles come from assigned broker slots.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ProfileSlot, RecordingConfig } from '@camstack/types'

const ALWAYS_CONTINUOUS = {
  days: [0, 1, 2, 3, 4, 5, 6],
  start: '00:00',
  end: '23:59',
  mode: 'continuous' as const,
}

const CONFIG: RecordingConfig = { enabled: true, bands: [{ ...ALWAYS_CONTINUOUS }] }

function slot(profile: ProfileSlot['profile'], source: string | null): ProfileSlot {
  return {
    deviceId: 7,
    profile,
    brokerId: `7/${profile}`,
    sourceCamStreamId: source,
    status: 'streaming',
  }
}

let slots: readonly ProfileSlot[] = []

// D625: `getAvailability` answers `read: 'read' | 'unreadable'`. A fake that
// omits `read` falls through BOTH production branches and pins nothing — this
// one is driven per test instead.
type AvailabilityAnswer =
  | { read: 'read'; ranges: readonly { startMs: number; endMs: number }[] }
  | { read: 'unreadable' }

let availability: AvailabilityAnswer = { read: 'read', ranges: [] }

vi.mock('../../../generated/system-hooks', () => ({
  // The camera row the sensor picker suggests by location; the fleet it picks from.
  useDeviceManagerGetDevice: () => ({
    data: { id: 7, location: 'Front door' },
    isLoading: false,
    error: null,
  }),
  useDeviceManagerListAll: () => ({ data: [], isLoading: false, error: null }),
  // The camera's own bindings, for the `deviceSignal` control: answered, no signal.
  useDeviceManagerGetBindings: () => ({
    status: 'success',
    data: { deviceId: 7, entries: [] },
    isLoading: false,
    error: null,
  }),
  useRecordingArchiveGetStatus: () => ({
    data: { deviceId: 7, enabled: true, activeMode: 'continuous', nodeId: 'hub', storageBytes: 0 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useRecordingArchiveGetDeviceConfig: () => ({ data: CONFIG, refetch: vi.fn() }),
  useRecordingArchiveSetDeviceConfig: () => ({ mutate: vi.fn(), isPending: false }),
  useRecordingArchiveRescanStorage: () => ({ mutate: vi.fn(), isPending: false }),
  useRecordingGetAvailability: () => ({ data: availability, isLoading: false }),
  useStreamBrokerListAllProfileSlots: () => ({ data: slots }),
}))

vi.mock('../RecordingTimeline', () => ({
  RecordingTimeline: () => <div data-testid="recording-timeline" />,
}))

const { RecordingPanel } = await import('../RecordingPanel')

function renderPanel(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RecordingPanel deviceId={7} />
    </QueryClientProvider>,
  )
}

const profileButton = (label: string): HTMLElement | undefined =>
  screen.getAllByRole('button').find((b) => b.textContent === label)

const isOn = (btn: HTMLElement): boolean => btn.className.includes('bg-primary')

describe('RecordingPanel — settings always visible', () => {
  it('shows the flat form without a collapsed Settings toggle', () => {
    slots = [slot('high', 'native:main'), slot('low', 'native:sub')]
    renderPanel()
    expect(screen.getByRole('button', { name: 'Mode Continuous' })).toBeDefined()
    expect(screen.getByText('Add band')).toBeDefined()
    expect(screen.queryByRole('button', { name: /settings/i })).toBeNull()
  })

  it('shows only assigned broker slots, defaulting high+low ON and mid OFF', () => {
    slots = [slot('high', 'native:main'), slot('mid', 'native:slot-3'), slot('low', 'native:sub')]
    renderPanel()
    expect(isOn(profileButton('high')!)).toBe(true)
    expect(isOn(profileButton('mid')!)).toBe(false)
    expect(isOn(profileButton('low')!)).toBe(true)
  })

  it('hides a profile the broker has not assigned', () => {
    slots = [slot('high', 'native:main'), slot('mid', null), slot('low', 'native:sub')]
    renderPanel()
    expect(profileButton('high')).toBeDefined()
    expect(profileButton('low')).toBeDefined()
    expect(profileButton('mid')).toBeUndefined()
  })
})

describe('RecordingPanel — a read that FAILED is not zero (D393, D625)', () => {
  it('sums the ranges it was READ and counts them', () => {
    slots = [slot('high', 'native:main')]
    availability = {
      read: 'read',
      ranges: [
        { startMs: 1_000, endMs: 61_000 },
        { startMs: 100_000, endMs: 130_000 },
      ],
    }
    renderPanel()
    // 60 s + 30 s recorded, over two ranges — both stated.
    expect(screen.getByText('1m 30s')).toBeDefined()
    expect(screen.getByText('2 segment ranges')).toBeDefined()
  })

  it('says nobody could look instead of drawing an empty 0s bar', () => {
    slots = [slot('high', 'native:main')]
    availability = { read: 'unreadable' }
    renderPanel()
    expect(screen.getByText('nobody could look')).toBeDefined()
    expect(screen.getByText('\u2014')).toBeDefined()
    // The failure must NOT be indistinguishable from a camera with recording off.
    expect(screen.queryByText('0s')).toBeNull()
    expect(screen.queryByText(/segment range/)).toBeNull()
  })
})
