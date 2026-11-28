/**
 * #704: a composed device whose composition block is gone has no editable
 * Customize tab. It must offer the way out — deleting the device — instead of
 * a dead-end line.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type DeviceInfo, DeviceType } from '@dominevo/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../../../i18n'
import { integrationDetailUrl } from '../../../../lib/integration-instance-selection'

const navigateTo = vi.hoisted(() => vi.fn())
const removeOptions = vi.hoisted(() => ({ onSuccess: undefined as undefined | (() => void) }))
const removeMutate = vi.hoisted(() =>
  vi.fn(async () => {
    removeOptions.onSuccess?.()
    return { success: true }
  }),
)
const confirmAction = vi.hoisted(() =>
  vi.fn(async (opts: { readonly action?: () => Promise<unknown> }) => {
    await opts.action?.()
    return true
  }),
)

vi.mock('@dominevo/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dominevo/ui-library')>()
  return {
    ...actual,
    useCoreBlocksGetComposition: () => ({
      status: 'success',
      data: { state: 'loaded', view: null },
      refetch: async () => undefined,
    }),
    useCoreBlocksUpdateComposition: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeviceManagerRemove: (options?: { readonly onSuccess?: () => void }) => {
      removeOptions.onSuccess = options?.onSuccess
      return { mutateAsync: removeMutate, isPending: false }
    },
    useIntegrationsList: () => ({
      data: [{ id: 'int_blocks', addonId: 'core-blocks', name: 'Blocks' }],
    }),
    useConfirm: () => confirmAction,
    useDeviceManagerGetBindings: () => ({ status: 'pending', data: undefined }),
    useDeviceManagerListAll: () => ({ status: 'success', data: [] }),
    useDeviceManagerGetLinkedDevicesBatch: () => ({ status: 'pending', data: undefined }),
    useCoreBlocksListComposableCaps: () => ({ status: 'pending' }),
    useCapabilityPresence: () => 'present',
  }
})

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigateTo,
}))

// The facts hooks read the hub; the orphan branch needs none of them.
vi.mock('../use-customize-facts', () => ({
  useCustomizeFacts: () => ({ composable: [], nativeCaps: [], wireable: [] }),
}))
vi.mock('../use-camera-sensors-presence', () => ({ useCameraSensors: () => 'absent' }))
vi.mock('../use-default-consumables', () => ({ useDefaultConsumables: () => [] }))

const { ComposedCustomizeBody } = await import('../ComposedCustomizeBody')

const ORPHAN: DeviceInfo = {
  id: 32,
  name: 'nt-sw',
  stableId: 'composed-9cee9f69',
  addonId: 'composer',
  type: DeviceType.Switch,
  location: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: false,
  config: {},
  integrationId: 'int_blocks',
}

describe('a composed device whose block is gone', () => {
  it('offers to delete the device, and the click removes it by id', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ComposedCustomizeBody device={ORPHAN} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const panel = await screen.findByTestId('composed-orphan')
    expect(panel.textContent).toContain('Composition block not found.')
    expect(panel.textContent).toContain('Delete the device to clear what is left of it.')
    fireEvent.click(await screen.findByTestId('composed-orphan-delete'))
    await waitFor(() => expect(removeMutate).toHaveBeenCalledWith({ deviceId: 32 }))
    // leaves for the device's integration, as the device page's own Delete does
    expect(navigateTo).toHaveBeenCalledWith(integrationDetailUrl('core-blocks', 'int_blocks'))
  })
})
