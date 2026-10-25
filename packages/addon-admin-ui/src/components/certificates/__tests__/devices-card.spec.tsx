// @vitest-environment jsdom
/**
 * Identity → Certificates → Devices and My access → My devices follow the
 * Tokens & sessions table (D819): a checkbox column, a bulk bar with the typed
 * confirmation, one per-device revoke per selected row with a summary of the
 * ones that failed, a Revoke button per row behind the shared confirm, and
 * delete offered on revoked rows only.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Device {
  id: string
  userId: string
  username: string | null
  deviceName: string
  fingerprint: string
  platform: 'ios' | 'android' | 'web' | 'other'
  enrolledVia: 'qr' | 'self'
  issuedAt: number
  expiresAt: number
  lastUsedAt: number | null
  lastUsedFrom: string | null
  status: 'active' | 'expired' | 'revoked'
}

const NOW = Date.now()
const h = vi.hoisted(() => ({
  revokeCalls: [] as string[],
  failIds: new Set<string>(),
  removeMutate: vi.fn(),
  ownRevokeMutate: vi.fn(),
  confirmSpy: vi.fn(),
  flags: {
    promptAnswer: null as string | null,
    devices: [] as unknown[],
    own: [] as unknown[],
  },
}))

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useConfirm: () => async (opts: unknown) => {
    h.confirmSpy(opts)
    return true
  },
  usePrompt: () => async () => h.flags.promptAnswer,
  useUserManagementListUsers: () => ({ data: [] }),
  trpc: {
    useUtils: () => ({
      deviceCredentials: {
        listDeviceCredentials: { invalidate: vi.fn() },
        getDeviceCertificateSettings: { invalidate: vi.fn() },
      },
      auth: { listOwnDeviceCredentials: { invalidate: vi.fn() } },
    }),
    deviceCredentials: {
      listDeviceCredentials: {
        useQuery: () => ({
          data: h.flags.devices,
          isPending: false,
          error: null,
        }),
      },
      getDeviceCertificateSettings: {
        useQuery: () => ({
          data: { selfEnrollment: false },
          isPending: false,
          error: null,
          refetch: vi.fn(),
        }),
      },
      setDeviceCertificateSettings: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      revokeDeviceCredential: {
        useMutation: () => ({
          mutate: vi.fn(),
          mutateAsync: async (input: { id: string }) => {
            h.revokeCalls.push(input.id)
            if (h.failIds.has(input.id)) throw new Error('hub said no')
            return { revoked: true }
          },
          isPending: false,
        }),
      },
      deleteDeviceCredential: {
        useMutation: () => ({ mutate: h.removeMutate, isPending: false }),
      },
      startEnrollment: {
        useMutation: () => ({
          mutate: vi.fn(),
          isPending: false,
          data: undefined,
          reset: vi.fn(),
        }),
      },
      renameDeviceCredential: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
    auth: {
      listOwnDeviceCredentials: {
        useQuery: () => ({ data: h.flags.own, isPending: false, error: null }),
      },
      revokeOwnDeviceCredential: {
        useMutation: () => ({
          mutate: h.ownRevokeMutate,
          isPending: false,
          variables: undefined,
        }),
      },
    },
  },
}))

import { DevicesCard } from '../DevicesCard'
import { MyDevicesSection } from '../MyDevicesSection'

function device(over: Partial<Device> & { id: string }): Device {
  return {
    userId: 'u1',
    username: 'alice',
    deviceName: `Phone ${over.id}`,
    fingerprint: 'AA:BB:CC:DD:EE:FF:00',
    platform: 'ios',
    enrolledVia: 'qr',
    issuedAt: NOW - 86_400_000,
    expiresAt: NOW + 86_400_000 * 300,
    lastUsedAt: null,
    lastUsedFrom: null,
    status: 'active',
    ...over,
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  h.revokeCalls.length = 0
  h.failIds.clear()
  h.removeMutate.mockReset()
  h.ownRevokeMutate.mockReset()
  h.confirmSpy.mockReset()
  h.flags.promptAnswer = null
  h.flags.devices = []
  h.flags.own = []
})

describe('DevicesCard', () => {
  it('lists active devices with a checkbox and a Revoke button, revoked ones hidden by default', () => {
    h.flags.devices = [device({ id: 'a' }), device({ id: 'z', status: 'revoked' })]
    render(<DevicesCard pairOpen={false} onPairClose={() => {}} />)
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(1)
    const [row] = rows
    if (row === undefined) throw new Error('row missing')
    expect(within(row).getByRole('checkbox')).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Revoke Phone a' })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Rename Phone a' })).toBeTruthy()
    expect(within(row).queryByRole('button', { name: /^Delete/ })).toBeNull()
  })

  it('revokes one device after the shared danger confirm', async () => {
    h.flags.devices = [device({ id: 'a' })]
    render(<DevicesCard pairOpen={false} onPairClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Phone a' }))
    await waitFor(() => expect(h.confirmSpy).toHaveBeenCalledTimes(1))
    const opts = h.confirmSpy.mock.calls[0]?.[0] as {
      title: string
      variant: string
    }
    expect(opts.title).toBe('Revoke "Phone a"?')
    expect(opts.variant).toBe('danger')
  })

  it('bulk revoke needs the typed count, then revokes each selected device once', async () => {
    h.flags.devices = [device({ id: 'a' }), device({ id: 'b' })]
    render(<DevicesCard pairOpen={false} onPairClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Select all 2 shown' }))
    h.flags.promptAnswer = '1'
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke 2 devices…' }))
    })
    expect(h.revokeCalls).toEqual([])
    h.flags.promptAnswer = '2'
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke 2 devices…' }))
    })
    expect(h.revokeCalls.toSorted()).toEqual(['a', 'b'])
    expect((await screen.findByRole('status')).textContent).toContain('Revoked 2 devices')
  })

  it('bulk revoke continues past a failure and reports it', async () => {
    h.flags.devices = [device({ id: 'a' }), device({ id: 'b' })]
    h.failIds.add('a')
    render(<DevicesCard pairOpen={false} onPairClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Select all 2 shown' }))
    h.flags.promptAnswer = '2'
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke 2 devices…' }))
    })
    expect(h.revokeCalls.toSorted()).toEqual(['a', 'b'])
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Revoked 1 device; 1 failed')
    expect(alert.textContent).toContain('Phone a: hub said no')
  })

  it('offers Delete on a revoked device, never on a live one', async () => {
    h.flags.devices = [device({ id: 'a' }), device({ id: 'z', status: 'revoked' })]
    render(<DevicesCard pairOpen={false} onPairClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Revoked 1' }))
    const revokedRow = screen.getByText('Phone z').closest('tr')
    if (revokedRow === null) throw new Error('revoked row missing')
    expect(within(revokedRow).queryByRole('checkbox')).toBeNull()
    expect(within(revokedRow).queryByRole('button', { name: /^Revoke/ })).toBeNull()
    fireEvent.click(within(revokedRow).getByRole('button', { name: 'Delete Phone z' }))
    await waitFor(() => expect(h.removeMutate).toHaveBeenCalledWith({ id: 'z' }))
  })
})

describe('MyDevicesSection', () => {
  it('shows the caller devices in the shared table without an owner column or bulk bar', async () => {
    h.flags.own = [
      {
        id: 'm1',
        deviceName: 'My phone',
        platform: 'android',
        issuedAt: NOW - 1000,
        expiresAt: NOW + 86_400_000,
        lastUsedAt: null,
        status: 'active',
      },
    ]
    render(<MyDevicesSection />)
    expect(screen.queryByText('Owner')).toBeNull()
    expect(screen.queryByTestId('bulk-bar')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke My phone' }))
    await waitFor(() => expect(h.ownRevokeMutate).toHaveBeenCalledWith({ id: 'm1' }))
    const asked = h.confirmSpy.mock.calls[0]?.[0] as { title: string } | undefined
    expect(asked?.title).toBe('Revoke "My phone"?')
  })
})
