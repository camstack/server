/**
 * `<DeviceExportPanel>` — what ONE entry shows, and the multi-select export.
 *
 * The operator asked for three things on a device row here and nothing else:
 * device TYPE, NAME, EXPORT — plus the ability to export several at once by
 * selecting them.
 *
 * What this file pins, and why each half matters:
 *
 *  1. The row carries exactly those columns. Everything the old row also
 *     rendered (Hardware, Features, the merged Preview cell with its live
 *     control / battery pills / snapshot eye / reboot / status dot) is
 *     reachable on `/devices` and on the device's own page — none of it was
 *     only here. The Expose toggle IS only-here-ish, so it stays.
 *  2. A bulk run that half-fails names the devices on BOTH sides. A generic
 *     "export failed" would leave the operator re-running the whole set to
 *     find out which ones actually landed.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'

interface MutationInput {
  readonly deviceId: string
  readonly nodeId: string
  readonly addonId: string
}

const exposeCalls: MutationInput[] = []
const unexposeCalls: MutationInput[] = []
/** deviceId → rejection message. Anything absent resolves. */
let exposeFailures: ReadonlyMap<string, string> = new Map()

const DEVICES = [
  {
    id: 1,
    stableId: 'reolink:aaa',
    addonId: 'provider-reolink',
    type: 'camera',
    name: 'Garden cam',
    online: true,
    disabled: false,
    parentDeviceId: null,
  },
  {
    id: 2,
    stableId: 'reolink:bbb',
    addonId: 'provider-reolink',
    type: 'camera',
    name: 'Gate cam',
    online: true,
    disabled: false,
    parentDeviceId: null,
  },
  {
    id: 3,
    stableId: 'tuya:ccc',
    addonId: 'provider-tuya',
    type: 'light',
    name: 'Hall light',
    online: true,
    disabled: false,
    parentDeviceId: null,
  },
]

vi.mock('../../generated/system-hooks', () => ({
  useDeviceExportGetStatus: () => ({
    data: { linkState: 'linked', exposedDeviceCount: 0 },
    isLoading: false,
  }),
  useDeviceExportListExposedDevices: () => ({ data: [], isLoading: false }),
  useDeviceExportListSupportedDeviceKinds: () => ({
    data: ['camera', 'light'],
    isLoading: false,
  }),
  // An exporter that does not answer what else it can expose: devices only.
  useDeviceExportListSupportedEntityKinds: () => ({ data: undefined, isLoading: false }),
  useDeviceExportListExposedEntities: () => ({ data: undefined, isLoading: false }),
  useDeviceExportExposeEntity: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeviceExportUnexposeEntity: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useActionsList: () => ({ data: undefined, isLoading: false }),
  useNotificationOutputListTargets: () => ({ data: undefined, isLoading: false }),
  useDeviceManagerListAll: () => ({ data: DEVICES, isLoading: false }),
  useDeviceExportExposeDevice: () => ({
    mutateAsync: (input: MutationInput) => {
      exposeCalls.push(input)
      const failure = exposeFailures.get(input.deviceId)
      return failure === undefined ? Promise.resolve(null) : Promise.reject(new Error(failure))
    },
    isPending: false,
  }),
  useDeviceExportUnexposeDevice: () => ({
    mutateAsync: (input: MutationInput) => {
      unexposeCalls.push(input)
      return Promise.resolve(null)
    },
    isPending: false,
  }),
}))

const { DeviceExportPanel } = await import('../device-export-panel')

function renderPanel(onOpenDevice?: (deviceId: string) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <DeviceExportPanel addonId="export-hap" onOpenDevice={onOpenDevice} />
    </QueryClientProvider>,
  )
}

function selectRow(name: string): void {
  fireEvent.click(screen.getByLabelText(`Select ${name}`))
}

beforeEach(() => {
  exposeCalls.length = 0
  unexposeCalls.length = 0
  exposeFailures = new Map()
})

describe('one entry shows device type, Name and export — and nothing else', () => {
  it('renders exactly the selection, Type, Name and Export columns', () => {
    renderPanel()

    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent?.trim() ?? '')
    expect(headers).toEqual(['', 'Type', 'Name', 'Export'])
  })

  it('drops the Hardware / Features / Preview columns the device table carries', () => {
    renderPanel()

    for (const dropped of ['Hardware', 'Features', 'Preview']) {
      expect(
        screen.queryByRole('columnheader', { name: dropped }),
        `${dropped} is reachable on /devices — it must not survive here`,
      ).toBeNull()
    }
  })

  it('still opens the device page from the row', () => {
    const onOpenDevice = vi.fn()
    renderPanel(onOpenDevice)

    fireEvent.click(screen.getByText('Garden cam'))
    expect(onOpenDevice).toHaveBeenCalledWith('1')
  })
})

describe('exporting several entries at once', () => {
  it('says nothing about a selection until there is one', () => {
    renderPanel()
    expect(screen.queryByTestId('export-selection-count')).toBeNull()
  })

  it('says WHAT is selected and HOW MANY the export covers', () => {
    renderPanel()

    selectRow('Garden cam')
    selectRow('Hall light')

    expect(screen.getByTestId('export-selection-count').textContent).toContain('2 selected')
    expect(screen.getByRole('button', { name: 'Expose 2' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unexpose 2' })).toBeTruthy()
  })

  it('exposes every selected device, once each, scoped to this addon', async () => {
    renderPanel()

    selectRow('Garden cam')
    selectRow('Gate cam')
    fireEvent.click(screen.getByRole('button', { name: 'Expose 2' }))

    await waitFor(() => expect(exposeCalls.length).toBe(2))
    expect(exposeCalls.map((c) => c.deviceId).toSorted()).toEqual(['1', '2'])
    for (const call of exposeCalls) {
      expect(call.addonId).toBe('export-hap')
      expect(call.nodeId).toBe('hub')
    }
  })

  it('clears the selection once the run has reported', async () => {
    renderPanel()

    selectRow('Garden cam')
    fireEvent.click(screen.getByRole('button', { name: 'Expose 1' }))

    await waitFor(() => expect(screen.queryByTestId('export-selection-count')).toBeNull())
  })

  it('unexposes every selected device', async () => {
    renderPanel()

    selectRow('Hall light')
    fireEvent.click(screen.getByRole('button', { name: 'Unexpose 1' }))

    await waitFor(() => expect(unexposeCalls.length).toBe(1))
    expect(unexposeCalls[0]?.deviceId).toBe('3')
  })
})

describe('bulk selection by filter (D875)', () => {
  it('offers a Role and a Provider filter, and hides nothing until one is used', () => {
    renderPanel()
    expect(screen.getByRole('button', { name: /^Role/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Provider/ })).toBeTruthy()
    expect(screen.getByText('Garden cam')).toBeTruthy()
    expect(screen.getByText('Hall light')).toBeTruthy()
  })

  it('"Select N shown" selects every row the filters leave, then exposes them', async () => {
    renderPanel()
    // 3 rows are shown by default.
    fireEvent.click(screen.getByRole('button', { name: 'Select 3 shown' }))
    expect(screen.getByTestId('export-selection-count').textContent).toContain('3 selected')

    fireEvent.click(screen.getByRole('button', { name: 'Deselect shown' }))
    expect(screen.queryByTestId('export-selection-count')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Select 3 shown' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expose 3' }))
    await waitFor(() => expect(exposeCalls.length).toBe(3))
  })

  it('a provider filter narrows what "Select shown" acts on', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /^Provider/ }))
    fireEvent.click(screen.getByText('provider-tuya'))

    fireEvent.click(screen.getByRole('button', { name: 'Select 1 shown' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expose 1' }))
    await waitFor(() => expect(exposeCalls.length).toBe(1))
    expect(exposeCalls[0]?.deviceId).toBe('3')
  })
})

describe('a half-failed export names both sides — never a generic failure', () => {
  it('reports which devices landed and which did not, by name', async () => {
    exposeFailures = new Map([['2', 'bridge refused the accessory']])
    renderPanel()

    selectRow('Garden cam')
    selectRow('Gate cam')
    fireEvent.click(screen.getByRole('button', { name: 'Expose 2' }))

    const summary = await screen.findByTestId('export-bulk-summary')
    expect(summary.textContent).toContain('Exposed 1 of 2')
    expect(summary.textContent).toContain('Garden cam')
    expect(summary.textContent).toContain('Gate cam')
    expect(summary.textContent).toContain('bridge refused the accessory')
  })

  it('reports a clean run too, so silence never means "probably worked"', async () => {
    renderPanel()

    selectRow('Garden cam')
    fireEvent.click(screen.getByRole('button', { name: 'Expose 1' }))

    const summary = await screen.findByTestId('export-bulk-summary')
    expect(summary.textContent).toContain('Exposed 1 of 1')
  })

  it('reports a single-row toggle failure instead of swallowing it', async () => {
    exposeFailures = new Map([['1', 'no bridge']])
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Expose Garden cam' }))

    const summary = await screen.findByTestId('export-bulk-summary')
    expect(summary.textContent).toContain('Garden cam')
    expect(summary.textContent).toContain('no bridge')
  })
})

describe('the exposed-devices table picks its own page size', () => {
  it('opens at 25 per page and offers 10 / 25 / 50 / 100 / All', () => {
    localStorage.clear()
    renderPanel()
    const select = screen.getByRole('combobox', { name: 'Rows per page' })
    expect((select as HTMLSelectElement).value).toBe('25')
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.textContent)).toEqual([
      '10',
      '25',
      '50',
      '100',
      'All',
    ])
  })

  it('remembers the choice per viewer, under a key of its own', () => {
    localStorage.clear()
    renderPanel()
    fireEvent.change(screen.getByRole('combobox', { name: 'Rows per page' }), {
      target: { value: '50' },
    })
    expect(localStorage.getItem('camstack.device-export.pageSize')).toBe('50')
    // The Devices page's global choice is a different key, left alone.
    expect(localStorage.getItem('camstack.device-list.pageSize')).toBeNull()
  })
})
