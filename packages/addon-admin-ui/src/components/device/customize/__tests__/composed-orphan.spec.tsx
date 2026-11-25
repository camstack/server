/**
 * #704: a composed device whose composition block is gone has no editable
 * Customize tab. It must offer the way out — deleting the device — instead of
 * a dead-end line.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DeviceInfo } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../../../i18n'

const removeMutate = vi.hoisted(() => vi.fn(async () => ({ success: true })))
const confirmAction = vi.hoisted(() =>
  vi.fn(async (opts: { readonly action?: () => Promise<unknown> }) => {
    await opts.action?.()
    return true
  }),
)

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useCoreBlocksGetComposition: () => ({
      status: 'success',
      data: { state: 'loaded', view: null },
      refetch: async () => undefined,
    }),
    useCoreBlocksUpdateComposition: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeviceManagerRemove: () => ({ mutateAsync: removeMutate, isPending: false }),
    useConfirm: () => confirmAction,
    useDeviceManagerGetBindings: () => ({ status: 'pending', data: undefined }),
    useDeviceManagerListAll: () => ({ status: 'success', data: [] }),
    useDeviceManagerGetLinkedDevicesBatch: () => ({ status: 'pending', data: undefined }),
    useCoreBlocksListComposableCaps: () => ({ status: 'pending' }),
    useCapabilityPresence: () => 'present',
  }
})

// The facts hooks read the hub; the orphan branch needs none of them.
vi.mock('../use-customize-facts', () => ({
  useCustomizeFacts: () => ({ composable: [], nativeCaps: [], wireable: [] }),
}))
vi.mock('../use-camera-sensors-presence', () => ({ useCameraSensors: () => 'absent' }))
vi.mock('../use-default-consumables', () => ({ useDefaultConsumables: () => [] }))

const { ComposedCustomizeBody } = await import('../ComposedCustomizeBody')

const ORPHAN = {
  id: 32,
  name: 'nt-sw',
  stableId: 'composed-9cee9f69',
  addonId: 'composer',
  type: 'switch',
} as unknown as DeviceInfo

describe('a composed device whose block is gone', () => {
  it('offers to delete the device, and the click removes it by id', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ComposedCustomizeBody device={ORPHAN} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.click(await screen.findByTestId('composed-orphan-delete'))
    await waitFor(() => expect(removeMutate).toHaveBeenCalledWith({ deviceId: 32 }))
  })
})
