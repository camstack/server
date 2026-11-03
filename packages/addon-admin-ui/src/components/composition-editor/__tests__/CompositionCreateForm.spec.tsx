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

vi.mock('../../device/customize/source-selector/SourceSelector', () => ({
  SourceSelector: (props: { readonly onMembersChange: (members: readonly unknown[]) => void }) => (
    <button
      type="button"
      onClick={() =>
        props.onMembersChange([
          {
            source: { addonId: 'provider-homeassistant', stableId: 'switch.plug' },
            cap: 'switch',
            fieldPath: 'on',
          },
        ])
      }
    >
      pick-plug
    </button>
  ),
}))

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

  it('creates a sensor naked: no feature in the composition', async () => {
    create.mockClear()
    render(<CompositionCreateForm mode="blank" onTitle={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledWith({
      block: {
        enabled: true,
        composition: { target: { kind: 'new', type: 'sensor' }, features: [] },
      },
    })
  })

  it('a heater needs its plug before it can be saved, then forwards on/off to it', async () => {
    create.mockClear()
    render(<CompositionCreateForm mode="blank" onTitle={() => undefined} />)
    fireEvent.change(screen.getByRole('combobox', { name: /type/i }), {
      target: { value: 'heater' },
    })
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('pick-plug'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const calls = create.mock.calls as unknown as ReadonlyArray<
      readonly [{ block: { composition: { features: ReadonlyArray<{ cap: string }> } } }]
    >
    expect(calls[0]?.[0].block.composition.features.map((f) => f.cap)).toEqual(['switch'])
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
