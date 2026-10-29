/**
 * `<DeviceExportPanel>` with actions and notification targets (D968): the SAME
 * table, extra rows, and only for the kinds the exporter answered.
 *
 * Pinned here:
 *  1. Action and notifier rows appear beside the devices, with the same
 *     Expose / Exposed toggle, which goes through `exposeEntity` /
 *     `unexposeEntity` (never the device mutations).
 *  2. The type filter gains "Action" / "Notifier" only for a supported kind.
 *  3. An UNANSWERED kinds list is unknown, not "supports nothing": devices
 *     only, no extra filter entry, and the action / target lists are not even
 *     asked.
 *  4. A refused expose is named on screen, with the entity (not a device id).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface EntityMutationInput {
  readonly entity: { readonly kind: string; readonly actionId?: string; readonly targetId?: string }
  readonly nodeId: string
  readonly addonId: string
}

const exposeEntityCalls: EntityMutationInput[] = []
const unexposeEntityCalls: EntityMutationInput[] = []
const deviceExposeCalls: unknown[] = []
const actionsListEnabled: boolean[] = []
const targetsListEnabled: boolean[] = []
let entityKinds: readonly string[] | undefined = ['device', 'action', 'notifier']
let exposedEntities: readonly unknown[] = []
let exposeEntityFailure: string | null = null

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
]

vi.mock('../../generated/system-hooks', () => ({
  useDeviceExportGetStatus: () => ({
    data: { linkState: 'linked', exposedDeviceCount: 0 },
    isLoading: false,
  }),
  useDeviceExportListExposedDevices: () => ({ data: [], isLoading: false }),
  useDeviceExportListSupportedDeviceKinds: () => ({ data: ['camera'], isLoading: false }),
  useDeviceExportListSupportedEntityKinds: () => ({ data: entityKinds, isLoading: false }),
  useDeviceExportListExposedEntities: () => ({ data: exposedEntities, isLoading: false }),
  useDeviceManagerListAll: () => ({ data: DEVICES, isLoading: false }),
  useActionsList: (_input: unknown, options?: { enabled?: boolean }) => {
    actionsListEnabled.push(options?.enabled !== false)
    return {
      data: options?.enabled === false ? undefined : [{ id: 'internal:a', name: 'Open gate' }],
      isLoading: false,
    }
  },
  useNotificationOutputListTargets: (_input: unknown, options?: { enabled?: boolean }) => {
    targetsListEnabled.push(options?.enabled !== false)
    return {
      data: options?.enabled === false ? undefined : [{ id: 'tg:1', name: 'Phone' }],
      isLoading: false,
    }
  },
  useDeviceExportExposeDevice: () => ({
    mutateAsync: (input: unknown) => {
      deviceExposeCalls.push(input)
      return Promise.resolve(null)
    },
    isPending: false,
  }),
  useDeviceExportUnexposeDevice: () => ({
    mutateAsync: () => Promise.resolve(null),
    isPending: false,
  }),
  useDeviceExportExposeEntity: () => ({
    mutateAsync: (input: EntityMutationInput) => {
      exposeEntityCalls.push(input)
      return exposeEntityFailure === null
        ? Promise.resolve(null)
        : Promise.reject(new Error(exposeEntityFailure))
    },
    isPending: false,
  }),
  useDeviceExportUnexposeEntity: () => ({
    mutateAsync: (input: EntityMutationInput) => {
      unexposeEntityCalls.push(input)
      return Promise.resolve(null)
    },
    isPending: false,
  }),
}))

const { DeviceExportPanel } = await import('../device-export-panel')

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <DeviceExportPanel addonId="export-hap" />
    </QueryClientProvider>,
  )
}

/** The labels the Type filter offers. */
function typeFilterLabels(): string[] {
  const trigger = screen
    .getAllByRole('button')
    .find(
      (b) =>
        b.getAttribute('aria-haspopup') === 'listbox' && (b.textContent ?? '').startsWith('Type'),
    )
  if (trigger === undefined) throw new Error('no Type filter on screen')
  fireEvent.click(trigger)
  const labels = within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .map((o) => o.textContent?.trim() ?? '')
  fireEvent.click(trigger)
  return labels
}

beforeEach(() => {
  exposeEntityCalls.length = 0
  unexposeEntityCalls.length = 0
  deviceExposeCalls.length = 0
  actionsListEnabled.length = 0
  targetsListEnabled.length = 0
  entityKinds = ['device', 'action', 'notifier']
  exposedEntities = []
  exposeEntityFailure = null
})

describe('actions and notification targets in the export table', () => {
  it('shows an action and a notifier beside the devices, in the same table', () => {
    renderPanel()
    expect(screen.getByText('Garden cam')).toBeTruthy()
    expect(screen.getByText('Open gate')).toBeTruthy()
    expect(screen.getByText('Phone')).toBeTruthy()
    expect(screen.getAllByRole('table')).toHaveLength(1)
  })

  it('exposes an action through exposeEntity, never through the device mutation', async () => {
    renderPanel()
    fireEvent.click(screen.getByLabelText('Expose Open gate'))
    await waitFor(() => expect(exposeEntityCalls).toHaveLength(1))
    expect(exposeEntityCalls[0]).toEqual({
      entity: { kind: 'action', actionId: 'internal:a' },
      nodeId: 'hub',
      addonId: 'export-hap',
    })
    expect(deviceExposeCalls).toHaveLength(0)
  })

  it('exposes a notification target through exposeEntity', async () => {
    renderPanel()
    fireEvent.click(screen.getByLabelText('Expose Phone'))
    await waitFor(() => expect(exposeEntityCalls).toHaveLength(1))
    expect(exposeEntityCalls[0]?.entity).toEqual({ kind: 'notifier', targetId: 'tg:1' })
  })

  it('an exposed action shows Unexpose and flips through unexposeEntity', async () => {
    exposedEntities = [
      { entity: { kind: 'action', actionId: 'internal:a' }, exposedAs: 'Open gate' },
    ]
    renderPanel()
    fireEvent.click(screen.getByLabelText('Unexpose Open gate'))
    await waitFor(() => expect(unexposeEntityCalls).toHaveLength(1))
    expect(unexposeEntityCalls[0]?.entity).toEqual({ kind: 'action', actionId: 'internal:a' })
  })

  it('names a refused entity on screen', async () => {
    exposeEntityFailure = 'export-hap: action does not exist'
    renderPanel()
    fireEvent.click(screen.getByLabelText('Expose Open gate'))
    await waitFor(() => expect(screen.getByText(/Failed: Open gate/)).toBeTruthy())
    expect(screen.getByText(/action does not exist/)).toBeTruthy()
  })

  it('offers Action and Notifier in the type filter for the supported kinds', () => {
    renderPanel()
    expect(typeFilterLabels()).toEqual(['Camera', 'Action', 'Notifier'])
  })
})

describe('only the kinds the exporter answered', () => {
  it('an exporter that supports actions but not notifiers shows no notifier row or filter', () => {
    entityKinds = ['device', 'action']
    renderPanel()
    expect(screen.getByText('Open gate')).toBeTruthy()
    expect(screen.queryByText('Phone')).toBeNull()
    expect(typeFilterLabels()).toEqual(['Camera', 'Action'])
    expect(targetsListEnabled.every((enabled) => !enabled)).toBe(true)
  })

  it('an UNANSWERED kinds list is unknown: devices only, nothing asked, no extra filter', () => {
    entityKinds = undefined
    renderPanel()
    expect(screen.getByText('Garden cam')).toBeTruthy()
    expect(screen.queryByText('Open gate')).toBeNull()
    expect(screen.queryByText('Phone')).toBeNull()
    expect(typeFilterLabels()).toEqual(['Camera'])
    expect(actionsListEnabled.every((enabled) => !enabled)).toBe(true)
    expect(targetsListEnabled.every((enabled) => !enabled)).toBe(true)
  })
})
