/**
 * The empty create form does not wear Incomplete. Save lands on the new
 * device's Customize tab when the persisted list already names it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'

const navigate = vi.hoisted(() => vi.fn())
const fleetReads = vi.hoisted(() => ({ emptyReads: 0 }))
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
      refetch: async () => {
        if (fleetReads.emptyReads > 0) {
          fleetReads.emptyReads -= 1
          return { data: [] }
        }
        return { data: [row] }
      },
    }),
    useDeviceManagerSetName: () => ({ mutateAsync: vi.fn() }),
    useDeviceManagerSetLocation: () => ({ mutateAsync: vi.fn() }),
  }
})

const { CompositionCreateForm, awaitDeviceIdForBlock } = await import('../CompositionCreateForm')

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

  it('finds the new device when the persisted list has not refreshed yet', async () => {
    const rows: { id: number; stableId: string }[][] = [
      [],
      [],
      [{ id: 4700, stableId: 'composed-blk-x' }],
    ]
    let reads = 0
    const id = await awaitDeviceIdForBlock('blk-x', async () => rows[Math.min(reads++, 2)], 0)
    expect(id).toBe(4700)
    expect(reads).toBe(3)
  })

  it('gives up after a bounded number of reads', async () => {
    let reads = 0
    const id = await awaitDeviceIdForBlock('blk-none', async () => (reads++, []), 0)
    expect(id).toBeNull()
    expect(reads).toBe(10)
  })
})
