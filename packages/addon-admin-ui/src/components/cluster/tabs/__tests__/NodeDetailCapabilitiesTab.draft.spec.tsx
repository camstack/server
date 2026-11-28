/**
 * Provider bindings of a node are one draft with one Save (planning#675). The draft is compared
 * with the STORED binding, never with the displayed default: choosing the default provider while
 * nothing is bound still writes the explicit binding.
 */
import { selectOption } from '@dominevo/ui-library/testing'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  bindings: {} as Record<string, string>,
  setBinding: vi.fn(),
}))

vi.mock('@dominevo/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dominevo/ui-library')>()),
  usePipelineOrchestratorGetCapabilityBindings: () => ({
    data: state.bindings,
    isLoading: false,
  }),
  usePipelineOrchestratorSetCapabilityBinding: () => ({
    mutateAsync: state.setBinding,
    isPending: false,
  }),
}))

import { NodeDetailCapabilitiesTab } from '../NodeDetailCapabilitiesTab'

const ADDONS = [
  { id: 'det-a', capabilities: ['detector'], status: 'running' },
  { id: 'det-b', capabilities: ['detector'], status: 'running' },
]

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <NodeDetailCapabilitiesTab nodeId="hub" addons={ADDONS} />
    </QueryClientProvider>,
  )
}

const picker = () => screen.getByRole('combobox') as HTMLButtonElement
const hasSave = () => screen.queryByRole('button', { name: 'Save' }) !== null

describe('NodeDetailCapabilitiesTab draft', () => {
  beforeEach(() => {
    state.bindings = {}
    state.setBinding.mockReset()
    state.setBinding.mockResolvedValue({})
  })

  it('picking another provider writes only on Save', () => {
    mount()
    selectOption(picker(), 'det-b')
    expect(state.setBinding).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(state.setBinding).toHaveBeenCalledWith({
      nodeId: 'hub',
      capName: 'detector',
      addonId: 'det-b',
    })
  })

  it('choosing the default provider while nothing is bound still writes the explicit binding', () => {
    mount()
    selectOption(picker(), 'det-b')
    selectOption(picker(), 'det-a')
    expect(hasSave()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(state.setBinding).toHaveBeenCalledWith({
      nodeId: 'hub',
      capName: 'detector',
      addonId: 'det-a',
    })
  })

  it('going back to the stored explicit binding leaves nothing to save', () => {
    state.bindings = { detector: 'det-b' }
    mount()
    selectOption(picker(), 'det-a')
    expect(hasSave()).toBe(true)
    selectOption(picker(), 'det-b')
    expect(hasSave()).toBe(false)
  })
})
