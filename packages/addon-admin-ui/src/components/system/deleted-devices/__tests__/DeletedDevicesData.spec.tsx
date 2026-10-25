/**
 * Data → Deleted devices: scanning is a dry run; deleting asks first and shows
 * the counts; a skipped scan offers nothing to delete (D865).
 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mutateAsync, confirm } = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDeviceManagerCleanupDeletedDevicesData: () => ({ mutateAsync, isPending: false }),
    useConfirm: () => confirm,
  }
})

import { DeletedDevicesData } from '../DeletedDevicesData'

const DRY = {
  status: 'dry-run',
  reason: null,
  devices: [{ deviceId: 4483, stores: { 'recorder:footage': 12, 'audio-analyzer': 1 } }],
  unreachable: [],
}

beforeEach(() => {
  mutateAsync.mockReset()
  confirm.mockReset()
})
afterEach(cleanup)

describe('DeletedDevicesData', () => {
  it('scan is a dry run: it asks for confirm=false and offers the delete button with the count', async () => {
    mutateAsync.mockResolvedValue(DRY)
    render(<DeletedDevicesData />)

    fireEvent.click(screen.getByTestId('deleted-devices-scan'))

    await waitFor(() => expect(screen.getByTestId('deleted-devices-delete')).toBeTruthy())
    expect(mutateAsync).toHaveBeenCalledWith({ confirm: false })
    expect(screen.getByText('#4483')).toBeTruthy()
  })

  it('delete asks first with the counts, and only a yes sends confirm=true', async () => {
    mutateAsync.mockResolvedValueOnce(DRY)
    confirm.mockResolvedValueOnce(false)
    render(<DeletedDevicesData />)
    fireEvent.click(screen.getByTestId('deleted-devices-scan'))
    await waitFor(() => screen.getByTestId('deleted-devices-delete'))

    fireEvent.click(screen.getByTestId('deleted-devices-delete'))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringContaining('recorder:footage 12'),
    })
    expect(mutateAsync).toHaveBeenCalledTimes(1)

    mutateAsync.mockResolvedValueOnce({ ...DRY, status: 'cleaned' })
    confirm.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByTestId('deleted-devices-delete'))
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ confirm: true }))
  })

  it('a skipped scan says why and offers nothing to delete', async () => {
    mutateAsync.mockResolvedValue({
      status: 'skipped',
      reason: 'device list read 1 answered empty',
      devices: [],
      unreachable: [],
    })
    render(<DeletedDevicesData />)

    fireEvent.click(screen.getByTestId('deleted-devices-scan'))

    await waitFor(() => expect(screen.getByTestId('deleted-devices-skipped')).toBeTruthy())
    expect(screen.queryByTestId('deleted-devices-delete')).toBeNull()
  })
})
