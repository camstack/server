/**
 * The node's launch settings card (ADR 0970): reads `getLaunchOverrides` and
 * writes `setLaunchOverrides` through the node-routed server-management cap.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const setSpy = vi.fn().mockResolvedValue({ heapMb: 4096, rssBudgetMb: 6144, restartRequired: true })
const queryHolder = vi.hoisted(() => ({
  current: { heapMb: 3072, rssBudgetMb: null } as {
    heapMb: number | null
    rssBudgetMb: number | null
  },
  lastInput: undefined as unknown,
  lastEnabled: undefined as unknown,
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    Button: actual.Button,
    Input: actual.Input,
    SettingRow: actual.SettingRow,
    useServerManagementGetLaunchOverrides: (
      input: unknown,
      options: { enabled?: boolean } | undefined,
    ) => {
      queryHolder.lastInput = input
      queryHolder.lastEnabled = options?.enabled
      return { data: queryHolder.current, isLoading: false, isError: false }
    },
    useServerManagementSetLaunchOverrides: () => ({ mutateAsync: setSpy, isPending: false }),
  }
})

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query')
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }
})

import { NodeLaunchSettingsCard } from '../NodeLaunchSettingsCard'

const HUB = { id: 'hub', isHub: true, isOnline: true }
const AGENT = { id: 'agent-1', isHub: false, isOnline: true }

describe('NodeLaunchSettingsCard', () => {
  beforeEach(() => {
    setSpy.mockClear()
    queryHolder.current = { heapMb: 3072, rssBudgetMb: null }
  })

  it('shows the stored heap ceiling and the restart note', () => {
    render(<NodeLaunchSettingsCard node={HUB} />)
    expect((screen.getByLabelText('Heap ceiling (MB)') as HTMLInputElement).value).toBe('3072')
    expect((screen.getByLabelText('RSS budget (MB)') as HTMLInputElement).value).toBe('')
    expect(screen.getByText(/takes effect on restart/i)).toBeTruthy()
  })

  it('saves both values to the hub unpinned, and a cleared field as null', async () => {
    render(<NodeLaunchSettingsCard node={HUB} />)
    fireEvent.change(screen.getByLabelText('Heap ceiling (MB)'), { target: { value: '4096' } })
    fireEvent.change(screen.getByLabelText('RSS budget (MB)'), { target: { value: '6144' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(setSpy).toHaveBeenCalledWith({ heapMb: 4096, rssBudgetMb: 6144 })

    fireEvent.change(screen.getByLabelText('Heap ceiling (MB)'), { target: { value: '' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(setSpy).toHaveBeenLastCalledWith({ heapMb: null, rssBudgetMb: 6144 })
  })

  it('an agent is nodeId-pinned for the read and the write, and has no RSS budget field', async () => {
    render(<NodeLaunchSettingsCard node={AGENT} />)
    expect(queryHolder.lastInput).toEqual({ nodeId: 'agent-1' })
    expect(screen.queryByLabelText('RSS budget (MB)')).toBeNull()
    fireEvent.change(screen.getByLabelText('Heap ceiling (MB)'), { target: { value: '2048' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(setSpy).toHaveBeenCalledWith({ nodeId: 'agent-1', heapMb: 2048 })
  })

  it('refuses an out-of-range value instead of sending it', async () => {
    render(<NodeLaunchSettingsCard node={HUB} />)
    fireEvent.change(screen.getByLabelText('Heap ceiling (MB)'), { target: { value: '100' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(setSpy).not.toHaveBeenCalled()
    expect(screen.getByText(/between 512 and 65536/i)).toBeTruthy()
  })

  it('does not query an offline node', () => {
    render(<NodeLaunchSettingsCard node={{ ...AGENT, isOnline: false }} />)
    expect(queryHolder.lastEnabled).toBe(false)
  })
})
