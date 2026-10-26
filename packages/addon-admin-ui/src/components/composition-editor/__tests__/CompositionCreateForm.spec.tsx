/**
 * The empty create form does not wear Incomplete. Save lands on the new
 * device's Customize tab when the persisted list already names it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'

const navigate = vi.hoisted(() => vi.fn())
const create = vi.hoisted(() => vi.fn(async () => ({ block: { id: 'blk-new' } })))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigate }
})

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  const row = { id: 4700, stableId: 'composed-blk-new', name: 'New sensor' }
  return {
    ...actual,
    useCoreBlocksCreateComposition: () => ({ mutateAsync: create, isPending: false }),
    useDeviceManagerListPersistedByAddon: () => ({
      data: [row],
      refetch: async () => ({ data: [row] }),
    }),
    useDeviceManagerSetName: () => ({ mutateAsync: vi.fn() }),
    useDeviceManagerSetLocation: () => ({ mutateAsync: vi.fn() }),
  }
})

const { CompositionCreateForm } = await import('../CompositionCreateForm')

describe('CompositionCreateForm', () => {
  it('has no Incomplete badge, and a blank save opens the new device', async () => {
    render(<CompositionCreateForm mode="blank" onTitle={() => undefined} />)
    expect(screen.queryByText('Incomplete')).toBeNull()
    expect(screen.queryByLabelText('Room')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/devices/4700?tab=customize', { replace: true }),
    )
  })
})
