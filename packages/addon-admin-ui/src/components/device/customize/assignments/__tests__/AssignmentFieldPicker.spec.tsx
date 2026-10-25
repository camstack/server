import type { System } from '@camstack/sdk'
import { SystemProvider } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import { installDialogPolyfill } from './dialog-polyfill'

const FEEDER = {
  id: 4127,
  name: 'Mangiatoia PetKit',
  addonId: 'provider-homeassistant',
  stableId: 'ha:feeder',
  type: 'pet-feeder',
  location: 'Kitchen',
  role: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: false,
  config: {},
}
const fleetReads = vi.hoisted(() => ({ count: 0 }))
vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDeviceManagerListAll: () => {
      fleetReads.count += 1
      return { status: 'success', data: [FEEDER] }
    },
    useDeviceManagerGetWireableFields: () => ({
      status: 'success',
      data: {
        caps: [
          {
            cap: 'numeric-sensor',
            fields: [
              { path: 'value', kind: 'number' },
              { path: 'stale', kind: 'boolean' },
            ],
          },
        ],
      },
    }),
    useDeviceStateGetSnapshot: () => ({
      status: 'success',
      data: { 'numeric-sensor': { value: 18, stale: false } },
    }),
  }
})
const { AssignmentFieldPicker } = await import('../AssignmentFieldPicker')
beforeAll(installDialogPolyfill)

function mockSystem(): System {
  return {
    trpcClient: {
      deviceManager: {
        listSiteZones: { query: () => Promise.resolve([]) },
      },
    },
  } as unknown as System
}

function wrap(node: ReactNode): ReactElement {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SystemProvider system={mockSystem()}>{node}</SystemProvider>
    </QueryClientProvider>
  )
}

describe('AssignmentFieldPicker — device, then field, then (optional) details', () => {
  it('offers only fields of the target kind, with their values; confirm waits for a field and for the extra step', () => {
    const onConfirm = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const system = mockSystem()
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <SystemProvider system={system}>
          <AssignmentFieldPicker
            open
            title="Add consumable"
            targetKind="number"
            excludeDeviceIds={[]}
            confirmLabel="Add"
            extraComplete={false}
            extra={<span>name+unit</span>}
            onConfirm={onConfirm}
            onClose={vi.fn()}
          />
        </SystemProvider>
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: /Mangiatoia PetKit/ }))
    expect(screen.getByRole('option', { name: /numeric-sensor\.value/ })).toBeTruthy()
    // a boolean cannot fill a number (a string could: `number(x)`, D663)
    expect(screen.queryByRole('option', { name: /numeric-sensor\.stale/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add' }).hasAttribute('disabled')).toBe(true)
    expect(
      screen.getByRole('option', { name: /numeric-sensor\.value/ }).getAttribute('aria-selected'),
    ).toBe('false')
    fireEvent.click(screen.getByRole('option', { name: /numeric-sensor\.value/ }))
    // the picked field is marked (review L3)
    expect(
      screen.getByRole('option', { name: /numeric-sensor\.value/ }).getAttribute('aria-selected'),
    ).toBe('true')
    expect(screen.getByRole('button', { name: 'Add' }).hasAttribute('disabled')).toBe(true)
    rerender(
      <QueryClientProvider client={client}>
        <SystemProvider system={system}>
          <AssignmentFieldPicker
            open
            title="Add consumable"
            targetKind="number"
            excludeDeviceIds={[]}
            confirmLabel="Add"
            extraComplete
            extra={<span>name+unit</span>}
            onConfirm={onConfirm}
            onClose={vi.fn()}
          />
        </SystemProvider>
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ cap: 'numeric-sensor', path: 'value', value: 18 }),
    )
  })
  it('a closed picker does not list the fleet (review M2)', () => {
    fleetReads.count = 0
    render(
      wrap(
        <AssignmentFieldPicker
          open={false}
          title="Add consumable"
          targetKind="number"
          excludeDeviceIds={[]}
          confirmLabel="Add"
          onConfirm={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    )
    expect(fleetReads.count).toBe(0)
  })
})
