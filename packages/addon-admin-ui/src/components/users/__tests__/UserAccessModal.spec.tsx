/**
 * The role modal (D921) as an operator meets it:
 *
 *  - two roles only: Admin or Viewer, and Admin hides every viewer control;
 *  - a new non-admin opens as "All devices except…" with nothing picked;
 *  - "Only these devices…" with nothing picked refuses Save until one is picked;
 *  - switching mode keeps the picked ids;
 *  - the shared DevicePicker lists parents, not a camera's children;
 *  - no legacy-access copy anywhere;
 *  - the operator cannot demote themself from here.
 *
 * What Save writes is pinned in `user-role-model.spec.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SafeUser, UserScope } from '@camstack/types'

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useDeviceManagerListAll: () => ({
      data: [
        { id: 1, name: 'Front door', type: 'camera', location: 'Garden', parentDeviceId: null },
        { id: 2, name: 'Garage', type: 'camera', location: 'Garage', parentDeviceId: null },
        { id: 11, name: 'Siren', type: 'siren', location: 'Garden', parentDeviceId: 1 },
      ],
      isError: false,
    }),
  }
})

vi.mock('../../../pages/system/DevicePicker', () => ({
  DevicePicker: ({
    devices,
    value,
    onChange,
    listState,
  }: {
    readonly devices: readonly { readonly id: number }[]
    readonly value: readonly number[]
    readonly onChange: (next: number[]) => void
    readonly listState: string
  }) => (
    <button
      type="button"
      data-testid="viewer-device-picker"
      data-value={value.join(',')}
      data-devices={devices.map((device) => device.id).join(',')}
      data-list-state={listState}
      onClick={() => onChange([...value, 2])}
    >
      pick
    </button>
  ),
}))

vi.mock('../RolePreview', () => ({
  RolePreview: ({ invalidReason }: { readonly invalidReason: string | null }) => (
    <div data-testid="role-preview">{invalidReason ?? 'resolved'}</div>
  ),
}))

const { UserAccessModal } = await import('../UserAccessModal')

function makeUser(scopes: readonly UserScope[], isAdmin = false): SafeUser {
  return {
    id: 'u-1',
    username: 'alice',
    isAdmin,
    allowedProviders: '*',
    allowedDevices: {},
    scopes: [...scopes],
    totpEnabled: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

function renderModal(user: SafeUser, opts: { readonly isSelf?: boolean } = {}) {
  const onSubmit = vi.fn()
  render(
    <UserAccessModal
      user={user}
      isSelf={opts.isSelf ?? false}
      onClose={() => undefined}
      onSubmit={onSubmit}
      submitting={false}
      error={null}
    />,
  )
  return { onSubmit }
}

const save = (): HTMLButtonElement => screen.getByRole('button', { name: 'Save access' })

afterEach(() => {
  cleanup()
})

describe('UserAccessModal', () => {
  it('offers exactly two roles', () => {
    renderModal(makeUser([]))
    const roles = screen.getByRole('radiogroup', { name: 'Role' })
    const radios = [...roles.querySelectorAll('input[type="radio"]')]
    expect(radios.map((radio) => (radio as HTMLInputElement).value)).toEqual(['admin', 'viewer'])
  })

  it('opens a new non-admin as except-everything and says it has no access yet', () => {
    const { onSubmit } = renderModal(makeUser([]))
    expect(screen.getByText('No access yet')).toBeDefined()
    expect((screen.getByRole('radio', { name: /^Viewer/ }) as HTMLInputElement).checked).toBe(true)
    expect(
      screen.getByRole('radio', { name: 'All devices except…' }).getAttribute('aria-checked'),
    ).toBe('true')
    expect(screen.getByTestId('viewer-device-picker').getAttribute('data-devices')).toBe('1,2')
    fireEvent.click(save())
    expect(onSubmit).toHaveBeenCalledWith({
      isAdmin: false,
      scopes: [{ type: 'viewer', allow: '*', block: [], features: [] }],
    })
  })

  it('switching to Admin hides the device list and features and saves isAdmin', () => {
    const { onSubmit } = renderModal(
      makeUser([{ type: 'viewer', allow: '*', block: [], features: ['scenes'] }]),
    )
    expect(screen.getByText('Features')).toBeDefined()
    fireEvent.click(screen.getByRole('radio', { name: /^Admin/ }))
    expect(screen.queryByText('Features')).toBeNull()
    expect(screen.queryByTestId('viewer-device-picker')).toBeNull()
    fireEvent.click(save())
    expect(onSubmit).toHaveBeenCalledWith({ isAdmin: true, scopes: [] })
  })

  it('"only" with nothing picked refuses Save until a device is picked', () => {
    const { onSubmit } = renderModal(
      makeUser([{ type: 'viewer', allow: '*', block: [], features: [] }]),
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Only these devices…' }))
    expect(save().disabled).toBe(true)
    expect(screen.getByTestId('role-preview').textContent).toBe(
      'Pick at least one allowed device, or turn on All devices.',
    )
    fireEvent.click(screen.getByTestId('viewer-device-picker'))
    expect(save().disabled).toBe(false)
    fireEvent.click(save())
    expect(onSubmit).toHaveBeenCalledWith({
      isAdmin: false,
      scopes: [{ type: 'viewer', allow: [2], block: [], features: [] }],
    })
  })

  it('keeps the picked ids when the mode changes, and saves them as the block or the allow list', () => {
    const { onSubmit } = renderModal(
      makeUser([{ type: 'viewer', allow: '*', block: [1], features: [] }]),
    )
    expect(screen.getByTestId('viewer-device-picker').getAttribute('data-value')).toBe('1')
    fireEvent.click(screen.getByRole('radio', { name: 'Only these devices…' }))
    expect(screen.getByTestId('viewer-device-picker').getAttribute('data-value')).toBe('1')
    fireEvent.click(save())
    expect(onSubmit).toHaveBeenCalledWith({
      isAdmin: false,
      scopes: [{ type: 'viewer', allow: [1], block: [], features: [] }],
    })
  })

  it('saves the ticked features beside an except list', () => {
    const { onSubmit } = renderModal(
      makeUser([{ type: 'viewer', allow: '*', block: [1], features: [] }]),
    )
    fireEvent.click(screen.getByRole('checkbox', { name: /^Faces/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /^Scenes/ }))
    fireEvent.click(save())
    expect(onSubmit).toHaveBeenCalledWith({
      isAdmin: false,
      scopes: [{ type: 'viewer', allow: '*', block: [1], features: ['face-assignment', 'scenes'] }],
    })
  })

  it('shows no legacy copy for a stored grant set that is not a viewer row', () => {
    renderModal(
      makeUser([
        { type: 'device', selector: { kind: 'ids', ids: [1, 11] }, access: ['view'] },
        { type: 'category', target: 'system', access: ['view'] },
      ]),
    )
    expect(screen.queryByText(/legacy/i)).toBeNull()
    expect(screen.queryByText(/convert/i)).toBeNull()
    expect(screen.getByText('No access yet')).toBeDefined()
  })

  it('does not let the operator demote themself', () => {
    renderModal(makeUser([], true), { isSelf: true })
    expect((screen.getByRole('radio', { name: /^Viewer/ }) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText('You cannot remove your own admin role.')).toBeDefined()
  })
})
