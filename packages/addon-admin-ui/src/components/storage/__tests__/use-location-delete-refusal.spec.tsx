import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstanceRow } from '../../instances/instances-model'

const confirm = vi.fn()
const custom = vi.fn()

vi.mock('@dominevo/ui-library', () => ({
  useConfirm: () => confirm,
  useAddonsCustom: () => ({ mutateAsync: custom, isPending: false }),
}))

import { FORCE_DELETE_ACTION, useLocationDeleteRefusal } from '../use-location-delete-refusal'

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
const HOLDS = new Error('Storage location "recordings:old" still holds data — drain it first (x)')

function setup() {
  const client = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(() => useLocationDeleteRefusal(), { wrapper }).result.current
}

describe('useLocationDeleteRefusal', () => {
  beforeEach(() => {
    confirm.mockReset()
    custom.mockReset()
    custom.mockResolvedValue({ ok: true })
  })

  it('an unrelated error is not handled and offers no Force', async () => {
    const run = setup()
    expect(await run(ROW, new Error('network down'))).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(custom).not.toHaveBeenCalled()
  })

  it('an occupancy refusal shows the blocked state with Force delete, then a second confirm', async () => {
    confirm.mockResolvedValue(true)
    const run = setup()
    expect(await run(ROW, HOLDS)).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      confirmLabel: 'Force delete',
      variant: 'danger',
      message: expect.stringContaining('still holds data'),
    })
    expect(confirm.mock.calls[1]?.[0].message).toMatch(/stranded/)
  })

  it('only the second confirm sends force', async () => {
    confirm.mockResolvedValue(true)
    const run = setup()
    await run(ROW, HOLDS)
    expect(custom).toHaveBeenCalledTimes(1)
    expect(custom).toHaveBeenCalledWith({
      addonId: 'storage-orchestrator',
      action: FORCE_DELETE_ACTION,
      input: { id: 'recordings:old' },
    })
  })

  it('cancelling the blocked dialog sends nothing and asks no second time', async () => {
    confirm.mockResolvedValueOnce(false)
    const run = setup()
    expect(await run(ROW, HOLDS)).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(custom).not.toHaveBeenCalled()
  })

  it('cancelling the second confirm sends nothing', async () => {
    confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const run = setup()
    expect(await run(ROW, HOLDS)).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(custom).not.toHaveBeenCalled()
  })
})
