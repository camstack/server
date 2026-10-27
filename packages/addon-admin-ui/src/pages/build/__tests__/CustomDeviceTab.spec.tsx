/**
 * `/build` → Custom Device, as a surface.
 *
 * The rules (`composition-rows.spec.ts`) say what a row means; this says the
 * page does not throw them away: an answered list reaches the screen split into
 * its two lists with a link to each device, a FAILED composition carries its
 * reason, and "nothing answered yet" never renders as "none" (D315). The old
 * tab said "Composed devices are not built yet" while two were running — that
 * sentence must be gone.
 */

import {
  type CompositionListRead,
  type CompositionView,
  type CoreBlock,
  DeviceType,
} from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface QueryState<T> {
  readonly data: T | undefined
  readonly error: Error | null
  readonly refetch: () => Promise<unknown>
}

let compositionsQuery: QueryState<CompositionListRead>
let devicesQuery: QueryState<readonly DeviceRow[]>
const deleteMutate = vi.fn()

interface DeviceRow {
  readonly id: number
  readonly addonId: string
  readonly stableId: string
  readonly name: string
  readonly type: string
}
interface ChildrenProps {
  readonly children?: ReactNode
}
interface ErrorBoxProps {
  readonly title?: string
  readonly message: ReactNode
}
interface MockColumn<T> {
  readonly key: string
  readonly header?: string
  readonly render: (row: T, index: number) => ReactNode
}
interface MockTableProps<T> {
  readonly columns: readonly MockColumn<T>[]
  readonly rows: readonly T[]
  readonly emptyMessage?: string
}

function MockDataTable<T>({ columns, rows, emptyMessage }: MockTableProps<T>) {
  if (rows.length === 0) return <p>{emptyMessage}</p>
  return (
    <table>
      <tbody>
        {rows.map((row, index) => (
          <tr key={String(index)} data-testid="composition-row">
            {columns.map((column) => (
              <td key={column.key}>{column.render(row, index)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useCoreBlocksListCompositions: () => compositionsQuery,
    useCoreBlocksDelete: () => ({
      mutate: deleteMutate,
      isPending: false,
      error: null,
    }),
    useCoreBlocksCreateComposition: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
    useCoreBlocksUpdateComposition: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
    useCoreBlocksGetComposition: () => ({
      status: 'pending',
      data: undefined,
      error: null,
      refetch,
    }),
    Card: ({ children }: ChildrenProps) => <div>{children}</div>,
    Badge: ({ children }: ChildrenProps) => <span data-testid="state-badge">{children}</span>,
    ErrorBox: ({ title, message }: ErrorBoxProps) => (
      <div data-testid="error-box">
        <span>{title}</span>
        <span>{message}</span>
      </div>
    ),
    DataTable: MockDataTable,
    TABLE_SCROLL_MAX_H: 'max-h-[60vh]',
  }
})

vi.mock('../../../hooks/useDevice', () => ({
  useDeviceList: () => devicesQuery,
}))

vi.mock('../../../components/composition-editor/CompositionCreateForm', () => ({
  CompositionCreateForm: () => <div data-testid="composition-create-form" />,
}))
vi.mock('../../../components/composition-editor/CompositionBlockEditor', () => ({
  CompositionBlockEditor: () => <div data-testid="composition-block-editor" />,
}))

import { CustomDeviceTab } from '../CustomDeviceTab'

const refetch = (): Promise<unknown> => Promise.resolve(undefined)

function answered<T>(data: T): QueryState<T> {
  return { data, error: null, refetch }
}
function pending<T>(): QueryState<T> {
  return { data: undefined, error: null, refetch }
}

const FLEET: readonly DeviceRow[] = [
  {
    id: 101,
    addonId: 'provider-hikvision',
    stableId: 'mac-40acbf7be9f7',
    name: 'Camera front door',
    type: 'camera',
  },
  {
    id: 1031,
    addonId: 'provider-homeassistant',
    stableId: 'bell',
    name: 'Doorbell switch',
    type: 'switch',
  },
  {
    id: 4603,
    addonId: 'composer',
    stableId: 'composed-porch',
    name: 'Porch (composto)',
    type: 'sensor',
  },
  {
    id: 700,
    addonId: 'provider-homeassistant',
    stableId: 'porch-temp',
    name: 'Porch temperature',
    type: 'sensor',
  },
  {
    id: 2201,
    addonId: 'provider-homematic',
    stableId: 'hm:1',
    name: 'Garage door',
    type: 'binary',
  },
]

function block(over: Partial<CoreBlock>): CoreBlock {
  return {
    id: 'b',
    name: 'Block',
    code: '',
    enabled: true,
    placement: 'hub',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'u',
    status: 'running',
    lastChangedAt: 1,
    ...over,
  }
}

const COMPOSED: CompositionView = {
  block: block({
    id: 'porch',
    name: 'Porch (composto)',
    source: {
      kind: 'composition',
      composition: {
        target: { kind: 'new', type: DeviceType.Sensor },
        features: [
          {
            kind: 'fields',
            cap: 'temperature-sensor',
            fields: {
              celsius: {
                kind: 'from',
                source: {
                  addonId: 'provider-homeassistant',
                  stableId: 'porch-temp',
                },
                cap: 'temperature-sensor',
                fieldPath: 'celsius',
              },
            },
          },
          {
            kind: 'fields',
            cap: 'binary',
            fields: {
              on: {
                kind: 'from',
                source: {
                  addonId: 'provider-homeassistant',
                  stableId: 'gone-contact',
                },
                cap: 'binary',
                fieldPath: 'on',
              },
            },
          },
        ],
      },
    },
  }),
  state: {
    kind: 'answered',
    state: {
      blockId: 'porch',
      deviceId: 4603,
      status: 'failed',
      reason: 'source provider-homeassistant/gone-contact is gone',
      fields: [],
    },
  },
}

const CUSTOMIZATION: CompositionView = {
  block: block({
    id: 'doorbell',
    name: 'customize:provider-hikvision/mac-40acbf7be9f7',
    source: {
      kind: 'composition',
      composition: {
        target: {
          kind: 'existing',
          device: {
            addonId: 'provider-hikvision',
            stableId: 'mac-40acbf7be9f7',
          },
        },
        features: [
          {
            kind: 'fields',
            cap: 'doorbell',
            fields: {
              lastPressedAt: {
                kind: 'from',
                source: { addonId: 'provider-homeassistant', stableId: 'bell' },
                cap: 'switch',
                fieldPath: 'lastChangedAt',
              },
            },
          },
        ],
      },
    },
  }),
  state: {
    kind: 'answered',
    state: {
      blockId: 'doorbell',
      deviceId: 101,
      status: 'running',
      fields: [],
    },
  },
}

/** A customization the composer has not reported yet (D315): its target device
 *  IS in the fleet, but the row must still say so and carry no link — a link
 *  built from a fleet lookup rather than the composer's own answer is a guess. */
const CUSTOMIZATION_UNREPORTED: CompositionView = {
  block: block({
    id: 'garage-door',
    name: 'customize:provider-homematic/hm:1',
    source: {
      kind: 'composition',
      composition: {
        target: {
          kind: 'existing',
          device: { addonId: 'provider-homematic', stableId: 'hm:1' },
        },
        features: [
          {
            kind: 'fields',
            cap: 'binary',
            fields: {
              on: {
                kind: 'from',
                source: { addonId: 'provider-homeassistant', stableId: 'bell' },
                cap: 'switch',
                fieldPath: 'on',
              },
            },
          },
        ],
      },
    },
  }),
  state: { kind: 'unreachable', error: 'composer restarting' },
}

function renderTab() {
  return render(
    <MemoryRouter>
      <CustomDeviceTab />
    </MemoryRouter>,
  )
}

describe('CustomDeviceTab', () => {
  beforeEach(() => {
    compositionsQuery = answered<CompositionListRead>({
      state: 'loaded',
      views: [COMPOSED, CUSTOMIZATION],
    })
    devicesQuery = answered(FLEET)
  })

  it('delete asks first, calls the mutation once, and the row is gone after the refetch', () => {
    const refetchList = vi.fn(() => {
      compositionsQuery = {
        ...compositionsQuery,
        data: { state: 'loaded', views: [CUSTOMIZATION] },
      }
      return Promise.resolve(undefined)
    })
    compositionsQuery = { ...compositionsQuery, refetch: refetchList }
    deleteMutate.mockReset()
    deleteMutate.mockImplementation((_input: unknown, opts?: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    )
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    // Asking is not deleting.
    expect(deleteMutate).not.toHaveBeenCalled()
    expect(screen.getByText('Delete this composed device?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(deleteMutate).toHaveBeenCalledTimes(1)
    expect(deleteMutate.mock.calls[0]?.[0]).toEqual({ blockId: 'porch' })
    expect(refetchList).toHaveBeenCalled()
    expect(screen.queryByText('Porch (composto)')).toBeNull()
    expect(screen.getByText('No composed devices.')).toBeTruthy()
  })

  it('cancelling the delete confirmation calls nothing', () => {
    deleteMutate.mockReset()
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(deleteMutate).not.toHaveBeenCalled()
    expect(screen.getByText('Porch (composto)')).toBeTruthy()
  })

  it('lists a composed device with Edit, and a customization links to its device page (D676)', () => {
    renderTab()
    expect(screen.queryByText(/not built yet/i)).toBeNull()

    const composed = screen.getByRole('region', { name: 'Composed devices' })
    const customizations = screen.getByRole('region', {
      name: 'Customizations',
    })

    expect(composed.textContent).toContain('Porch (composto)')
    expect(screen.getByRole('link', { name: 'Porch (composto)' }).getAttribute('href')).toBe(
      '/devices/4603',
    )
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()

    // A customization's name opens the device it changes, on the Customize tab.
    const camera = screen.getByRole('link', { name: 'Camera front door' })
    expect(customizations.contains(camera)).toBe(true)
    expect(camera.getAttribute('href')).toBe('/devices/101?tab=customize')
    // A customization is named after the device it changes, never its block name.
    expect(screen.queryByText(/customize:/)).toBeNull()
    // …and its source is resolved to a name, linked to the plain device page.
    expect(screen.getByRole('link', { name: 'Doorbell switch' }).getAttribute('href')).toBe(
      '/devices/1031',
    )
  })

  it('a customization the composer has not reported yet has no link, and never guesses one from the fleet (D315)', () => {
    compositionsQuery = answered<CompositionListRead>({
      state: 'loaded',
      views: [COMPOSED, CUSTOMIZATION, CUSTOMIZATION_UNREPORTED],
    })
    renderTab()
    const customizations = screen.getByRole('region', {
      name: 'Customizations',
    })
    expect(customizations.textContent).toContain('device not reported yet')
    expect(screen.queryByRole('link', { name: 'Garage door' })).toBeNull()
    // The composer-answered customization is unaffected.
    expect(screen.getByRole('link', { name: 'Camera front door' }).getAttribute('href')).toBe(
      '/devices/101?tab=customize',
    )
  })

  it('opens the create dialog when createRequested is set, without rewriting the URL', async () => {
    const consumed = vi.fn()
    render(
      <MemoryRouter>
        <CustomDeviceTab createRequested onCreateConsumed={consumed} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('composed-device-editor')).toBeTruthy()
    expect(screen.getByTestId('composition-create-form')).toBeTruthy()
    expect(consumed).not.toHaveBeenCalled()
    expect(window.location.search).not.toContain('new=')
  })

  it('a failed composition shows its reason, and a source that is gone is marked missing', () => {
    renderTab()
    const composed = screen.getByRole('region', { name: 'Composed devices' })
    expect(composed.textContent).toContain('Failed')
    expect(composed.textContent).toContain('source provider-homeassistant/gone-contact is gone')
    expect(composed.textContent).toContain('provider-homeassistant/gone-contact')
    expect(composed.textContent).toContain('missing')
  })

  it('a pending read is loading, never "none"', () => {
    compositionsQuery = pending()
    renderTab()
    expect(screen.getByText(/Loading compositions/)).toBeTruthy()
    expect(screen.queryByText('No composed devices.')).toBeNull()
    expect(screen.queryByText('No customizations.')).toBeNull()
  })

  it('a store not yet read is said so, never "none"', () => {
    compositionsQuery = answered<CompositionListRead>({
      state: 'not-loaded',
      reason: 'core_blocks not read',
    })
    renderTab()
    expect(screen.getByText(/has not been read yet/)).toBeTruthy()
    expect(screen.queryByText('No composed devices.')).toBeNull()
  })

  it('an answered, empty store says "none" for each list', () => {
    compositionsQuery = answered<CompositionListRead>({
      state: 'loaded',
      views: [],
    })
    renderTab()
    expect(screen.getByText('No composed devices.')).toBeTruthy()
    expect(screen.getByText('No customizations.')).toBeTruthy()
  })

  it('a failed read shows the error, not an empty list', () => {
    compositionsQuery = {
      data: undefined,
      error: new Error('core-blocks unreachable'),
      refetch,
    }
    renderTab()
    expect(screen.getByTestId('error-box').textContent).toContain('core-blocks unreachable')
    expect(screen.queryByText('No composed devices.')).toBeNull()
  })

  it('a failed background refresh keeps the last answer on screen and says so', () => {
    compositionsQuery = {
      data: { state: 'loaded', views: [COMPOSED, CUSTOMIZATION] },
      error: new Error('poll timed out'),
      refetch,
    }
    renderTab()
    expect(screen.queryByTestId('error-box')).toBeNull()
    expect(screen.getByText('Porch (composto)')).toBeTruthy()
    expect(screen.getByText(/latest refresh failed: poll timed out/)).toBeTruthy()
  })

  it('no source is called missing while the device list has not answered', () => {
    devicesQuery = pending()
    renderTab()
    expect(screen.getByText(/has not answered yet/)).toBeTruthy()
    const composed = screen.getByRole('region', { name: 'Composed devices' })
    expect(composed.textContent).toContain('provider-homeassistant/gone-contact')
    expect(composed.textContent).not.toContain('missing')
  })
})
