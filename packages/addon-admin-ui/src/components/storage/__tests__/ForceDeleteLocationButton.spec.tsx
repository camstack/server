import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstanceRow } from '../../instances/instances-model'

const confirm = vi.fn()
const custom = vi.fn()

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    IconButton: actual.IconButton,
    useConfirm: () => confirm,
    useAddonsCustom: () => ({ mutateAsync: custom, isPending: false }),
  }
})

import { FORCE_DELETE_ACTION, ForceDeleteLocationButton } from '../ForceDeleteLocationButton'

const ROW: InstanceRow = {
  kind: 'instance',
  key: 'storage-orchestrator:recordings:old',
  addonId: 'storage-orchestrator',
  providerName: 'Storage Orchestrator',
  id: 'recordings:old',
  name: 'Old disk',
  configured: true,
  enabled: true,
  status: undefined,
  canTest: true,
}

function renderButton() {
  const client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <ForceDeleteLocationButton row={ROW} />
    </QueryClientProvider>,
  )
}

describe('ForceDeleteLocationButton', () => {
  beforeEach(() => {
    confirm.mockReset()
    custom.mockReset()
  })

  it('runs the forceDeleteLocation action on the row once the operator confirmed', async () => {
    confirm.mockResolvedValue(true)
    custom.mockResolvedValue({ ok: true })
    renderButton()
    fireEvent.click(screen.getByRole('button', { name: 'Force delete Old disk' }))
    await waitFor(() => expect(custom).toHaveBeenCalledTimes(1))
    expect(custom).toHaveBeenCalledWith({
      addonId: 'storage-orchestrator',
      action: FORCE_DELETE_ACTION,
      input: { id: 'recordings:old' },
    })
  })

  it('does nothing when the confirmation is refused', async () => {
    confirm.mockResolvedValue(false)
    renderButton()
    fireEvent.click(screen.getByRole('button', { name: 'Force delete Old disk' }))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(custom).not.toHaveBeenCalled()
  })
})
