/**
 * Renaming a node refreshes the topology the Cluster page reads: the mutation's
 * success invalidates `nodes.topology`, so the new name is fetched instead of
 * the old one staying on screen until a reload.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface RenameOptions {
  readonly onSuccess?: () => void
}

const invalidateQueries = vi.fn()
let renameOptions: RenameOptions | undefined
const mutateAsync = vi.fn()

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    Button: actual.Button,
    Input: actual.Input,
    Select: actual.Select,
    FileInput: actual.FileInput,
    Textarea: actual.Textarea,
    Checkbox: actual.Checkbox,
    Slider: actual.Slider,
    Radio: actual.Radio,
    useNodesRenameNode: (options: RenameOptions) => {
      renameOptions = options
      return { mutateAsync, isPending: false }
    },
  }
})

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query')
  return { ...actual, useQueryClient: () => ({ invalidateQueries }) }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}))

import { NodeInfoTab } from '../tabs/NodeInfoTab'

describe('NodeInfoTab rename', () => {
  beforeEach(() => {
    invalidateQueries.mockClear()
    mutateAsync.mockReset()
    mutateAsync.mockImplementation(async () => {
      // tRPC runs the hook's onSuccess when the mutation resolves.
      renameOptions?.onSuccess?.()
      return { nodeId: 'agent-1', name: 'Garage' }
    })
  })

  it('invalidates nodes.topology once the rename succeeds, and not before', async () => {
    render(
      <NodeInfoTab
        nodeId="agent-1"
        name="Old name"
        hostname="host"
        platform="linux"
        arch="x64"
        cpuCores={4}
        memoryMB={8192}
        engines={[]}
        isHub={false}
      />,
    )
    fireEvent.click(screen.getByTitle('Rename'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Garage' } })
    expect(invalidateQueries).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({ nodeId: 'agent-1', name: 'Garage' }),
    )
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: [['nodes', 'topology']] })
  })
})
