/**
 * The empty create form does not wear Incomplete. Save lands on the new
 * device's Customize tab when the persisted list already names it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'

interface StubProps {
  readonly children?: ReactNode
  readonly onClick?: () => void
  readonly disabled?: boolean
}

const navigate = vi.hoisted(() => vi.fn())
const create = vi.hoisted(() => vi.fn(async () => ({ block: { id: 'blk-new' } })))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigate }
})

vi.mock('@camstack/ui-library', () => {
  const row = { id: 4700, stableId: 'composed-blk-new', name: 'New sensor' }
  return {
    Button: ({ children, onClick, disabled }: StubProps) => (
      <button type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    Select: () => null,
    useUiText: () => (key: string, fallback?: string) => fallback ?? key,
    deviceTypeMetaOf: () => ({ label: 'Sensor' }),
    deviceRoleMetaOf: () => ({ label: 'Temperature' }),
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
  it('has no Incomplete badge, and Save opens the new device Customize tab', async () => {
    render(<CompositionCreateForm />)
    expect(screen.queryByText('Incomplete')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Blank composition' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/devices/4700?tab=customize', { replace: true }),
    )
  })
})
