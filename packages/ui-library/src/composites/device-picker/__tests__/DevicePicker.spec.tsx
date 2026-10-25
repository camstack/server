/**
 * The admin smart picker, mounted at the size it must survive: 500 devices of
 * ONE type (D636). What only a mount can say — how many rows the DOM holds,
 * that the debounced search narrows it, that select-all acts on one group,
 * and that the chips stop at the limit.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The device picker's "Group by: Zone" reads the site zones once its list is
// open. This suite is about size, not zones: the read never answers, so Zone
// mode groups by location — the five rooms below.
vi.mock('../../../contexts/system-context.js', () => ({
  useSystem: () => ({
    trpcClient: {
      deviceManager: { listSiteZones: { query: () => new Promise(() => undefined) } },
    },
  }),
}))

import { DevicePicker } from '../DevicePicker'
import {
  PICKER_CHIP_LIMIT,
  PICKER_PAGE_SIZE,
  PICKER_SEARCH_DEBOUNCE_MS,
  type PickerDevice,
} from '../device-picker-model'

const ROOMS = ['Hall', 'Kitchen', 'Camera', 'Bathroom', 'Studio']
const SENSORS: readonly PickerDevice[] = Array.from({ length: 500 }, (_, i) => ({
  id: 1000 + i,
  name: `Temperatura ${String(i)}`,
  type: 'sensor',
  location: ROOMS[i % ROOMS.length] ?? null,
}))

interface HarnessProps {
  readonly initial: readonly number[]
  readonly seen: (next: readonly number[]) => void
}

function Harness({ initial, seen }: HarnessProps) {
  const [value, setValue] = useState<readonly number[]>(initial)
  return (
    <DevicePicker
      devices={SENSORS}
      listState="answered"
      value={value}
      noun="device"
      emptyMeansAll
      onChange={(next) => {
        seen(next)
        setValue(next)
      }}
    />
  )
}

function mount(initial: readonly number[] = []) {
  const seen = vi.fn<(next: readonly number[]) => void>()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Harness initial={initial} seen={seen} />
    </QueryClientProvider>,
  )
  return seen
}

function openPanel(): HTMLElement {
  const toggle = screen.getByRole('button', { name: /add devices|edit/i })
  fireEvent.click(toggle)
  return screen.getByTestId('device-picker-panel')
}

function renderedRows(panel: HTMLElement): number {
  return within(panel).queryAllByTestId('device-picker-row').length
}

describe('DevicePicker — 500 devices of one type', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('closed: the selection is chips, and no list is rendered at all', () => {
    mount()
    expect(screen.getByText('Every device — no restriction')).toBeTruthy()
    expect(screen.queryByTestId('device-picker-panel')).toBeNull()
    expect(screen.queryAllByTestId('device-picker-row')).toHaveLength(0)
  })

  it('open: five collapsed group headers and ZERO device rows at rest', () => {
    mount()
    const panel = openPanel()
    expect(within(panel).getAllByTestId('device-picker-group')).toHaveLength(5)
    expect(renderedRows(panel)).toBe(0)
  })

  it('a search expands its matches, bounded by one page, with "show more"', () => {
    mount()
    const panel = openPanel()
    fireEvent.change(within(panel).getByLabelText('Search devices'), {
      target: { value: 'temperatura' },
    })
    // Debounced: nothing moved before the timer.
    expect(renderedRows(panel)).toBe(0)
    act(() => {
      vi.advanceTimersByTime(PICKER_SEARCH_DEBOUNCE_MS)
    })
    // 500 matches, 5 headers — and the DOM holds ONE page of rows.
    const rows = renderedRows(panel)
    expect(rows).toBeGreaterThan(0)
    expect(rows).toBeLessThanOrEqual(PICKER_PAGE_SIZE)
    fireEvent.click(within(panel).getByRole('button', { name: /show .* more/i }))
    expect(renderedRows(panel)).toBeLessThanOrEqual(2 * PICKER_PAGE_SIZE)
  })

  it('a narrow search finds one device among 500', () => {
    mount()
    const panel = openPanel()
    fireEvent.change(within(panel).getByLabelText('Search devices'), {
      target: { value: 'temperatura 437' },
    })
    act(() => {
      vi.advanceTimersByTime(PICKER_SEARCH_DEBOUNCE_MS)
    })
    expect(renderedRows(panel)).toBe(1)
    expect(within(panel).getByText('Temperatura 437')).toBeTruthy()
  })

  it('"All" on a collapsed group selects its 100 devices, and only them', () => {
    const seen = mount([7])
    const panel = openPanel()
    const hall = within(panel)
      .getAllByTestId('device-picker-group')
      .find((header) => header.textContent?.includes('Hall'))
    expect(hall).toBeDefined()
    if (hall === undefined) return
    fireEvent.click(within(hall).getByRole('button', { name: 'All' }))
    const picked = seen.mock.lastCall?.[0] ?? []
    expect(picked).toHaveLength(101)
    expect(picked[0]).toBe(7)
    expect(picked.slice(1).every((id) => (id - 1000) % 5 === 0)).toBe(true)
    // The chips stop at the limit and count the rest.
    expect(screen.getAllByTestId(/^picker-chip-/)).toHaveLength(PICKER_CHIP_LIMIT)
    expect(
      screen.getByRole('button', { name: `+${String(101 - PICKER_CHIP_LIMIT)} more` }),
    ).toBeTruthy()
    // "Clear" on the same group leaves the rest.
    fireEvent.click(within(hall).getByRole('button', { name: 'Clear' }))
    expect(seen.mock.lastCall?.[0]).toEqual([7])
  })
})

describe('DevicePicker<string> — the system family scope pickers (D637)', () => {
  it('a stored node an answered directory lacks is a removable "unknown" chip', () => {
    const spy = vi.fn<(next: string[]) => void>()
    render(
      <DevicePicker<string>
        noun="node"
        devices={[]}
        listState="answered"
        fleet={{ state: 'answered', devices: [] }}
        value={['agent-gone']}
        onChange={spy}
      />,
    )
    const chip = screen.getByTestId('picker-chip-agent-gone')
    expect(chip.textContent).toBe('Node agent-gone — unknown to the hub')
    fireEvent.click(within(chip).getByRole('button', { name: /remove/i }))
    expect(spy).toHaveBeenCalledWith([])
  })

  it('a directory that cannot vouch (failed / incomplete) names the id and claims nothing', () => {
    const spy = vi.fn<(next: string[]) => void>()
    render(
      <DevicePicker<string>
        noun="node"
        devices={[]}
        listState="answered"
        fleet={{ state: 'failed', devices: undefined }}
        value={['agent-gone']}
        onChange={spy}
      />,
    )
    const chip = screen.getByTestId('picker-chip-agent-gone')
    expect(chip.textContent).toBe('Node agent-gone')
    expect(chip.textContent).not.toMatch(/unknown|removed/)
    fireEvent.click(within(chip).getByRole('button', { name: /remove/i }))
    expect(spy).toHaveBeenCalledWith([])
  })

  it('a stored package the answered list lacks reads "not installed"; groups use the caller title', () => {
    render(
      <DevicePicker<string>
        noun="package"
        devices={[
          { id: '@camstack/server', name: '@camstack/server', type: 'server', location: null },
        ]}
        listState="answered"
        value={['@camstack/addon-gone']}
        onChange={vi.fn()}
        groupTitle={(group) => (group.type === 'server' ? 'Server' : 'Addons')}
      />,
    )
    expect(screen.getByTestId('picker-chip-@camstack/addon-gone').textContent).toBe(
      '@camstack/addon-gone — not installed',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit…' }))
    const header = screen.getByTestId('device-picker-group')
    expect(header.textContent).toContain('Server')
    expect(header.textContent).not.toContain('No room')
  })
})

describe('DevicePicker — type, zone and location filters and reset (D697)', () => {
  const FILTERED: readonly PickerDevice[] = [
    { id: 1, name: 'Porch', type: 'sensor', location: 'Sala' },
    { id: 2, name: 'Garage', type: 'cover', location: 'Garage' },
    { id: 3, name: 'Porta', type: 'lock', location: 'Sala' },
  ]

  function mountFiltered(value: readonly number[] = [], devices = FILTERED): void {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <DevicePicker
          devices={devices}
          listState="answered"
          value={value}
          onChange={vi.fn()}
          noun="device"
        />
      </QueryClientProvider>,
    )
  }

  function rowIds(panel: HTMLElement): readonly string[] {
    return within(panel)
      .queryAllByTestId('device-picker-row')
      .map((row) => row.querySelector('input')?.getAttribute('data-device-id') ?? '')
      .sort()
  }

  function searchBox(panel: HTMLElement): HTMLInputElement {
    const box = within(panel).getByLabelText('Search devices')
    if (!(box instanceof HTMLInputElement)) throw new Error('the search box is not an input')
    return box
  }

  function tick(panel: HTMLElement, facet: 'type' | 'location', label: string): void {
    const dropdown = within(panel).getByTestId(`picker-filter-${facet}`)
    fireEvent.click(within(dropdown).getByRole('button'))
    // PopoverContent portals outside the facet wrapper. Prefer the filter
    // option's aria-label — a device can share the same name (Garage).
    const option = document.querySelector(`input[aria-label="${label}"]`)
    if (option === null) throw new Error(`no filter option labelled ${label}`)
    fireEvent.click(option)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    globalThis.localStorage?.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ticking a Type leaves only its rows', () => {
    mountFiltered()
    const panel = openPanel()
    expect(rowIds(panel)).toEqual(['1', '2', '3'])
    tick(panel, 'type', 'Lock')
    expect(rowIds(panel)).toEqual(['3'])
  })

  it('ticking a Location leaves only its rows', () => {
    mountFiltered()
    const panel = openPanel()
    tick(panel, 'location', 'Garage')
    expect(rowIds(panel)).toEqual(['2'])
  })

  it('a selected device the filter hides is still a chip and is counted', () => {
    mountFiltered([1])
    const panel = openPanel()
    expect(screen.queryByTestId('picker-hidden-selected')).toBeNull()
    tick(panel, 'type', 'Lock')
    expect(screen.getByTestId('picker-chip-1')).toBeTruthy()
    expect(screen.getByTestId('picker-hidden-selected').textContent).toBe(
      '1 selected hidden by filters',
    )
  })

  it('a selected id the list does not hold at all is not "hidden by filters"', () => {
    mountFiltered([1, 99])
    openPanel()
    expect(screen.queryByTestId('picker-hidden-selected')).toBeNull()
  })

  it('Reset is absent with no filter; after a search it restores every row and the box, and keeps Group by', () => {
    mountFiltered()
    const panel = openPanel()
    expect(within(panel).queryByTestId('picker-reset-filters')).toBeNull()
    fireEvent.click(within(panel).getByRole('radio', { name: 'Location' }))
    const box = searchBox(panel)
    fireEvent.change(box, { target: { value: 'porta' } })
    act(() => {
      vi.advanceTimersByTime(PICKER_SEARCH_DEBOUNCE_MS)
    })
    expect(rowIds(panel)).toEqual(['3'])
    fireEvent.click(within(panel).getByTestId('picker-reset-filters'))
    expect(rowIds(panel)).toEqual(['1', '2', '3'])
    expect(searchBox(panel).value).toBe('')
    expect(within(panel).queryByTestId('picker-reset-filters')).toBeNull()
    expect(
      within(panel).getByRole('radio', { name: 'Location' }).getAttribute('aria-checked'),
    ).toBe('true')
  })

  it('Reset also clears a ticked Type', () => {
    mountFiltered()
    const panel = openPanel()
    tick(panel, 'type', 'Lock')
    fireEvent.click(within(panel).getByTestId('picker-reset-filters'))
    expect(rowIds(panel)).toEqual(['1', '2', '3'])
  })

  it('with the zones read pending the Zone trigger is disabled and says so', () => {
    mountFiltered()
    const panel = openPanel()
    const trigger = within(within(panel).getByTestId('picker-filter-zone')).getByRole('button')
    expect(trigger.hasAttribute('disabled')).toBe(true)
    expect(trigger.textContent).toMatch(/loading zones/)
  })

  it('a single type draws no Type dropdown', () => {
    mountFiltered(
      [],
      FILTERED.filter((d) => d.id !== 2).map((d) => ({ ...d, type: 'sensor' })),
    )
    const panel = openPanel()
    expect(within(panel).queryByTestId('picker-filter-type')).toBeNull()
  })
})
