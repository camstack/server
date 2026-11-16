/// <reference types="@testing-library/jest-dom" />

import { selectOption } from '@camstack/ui-library/testing'
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

const confirm = vi.fn<() => Promise<boolean>>()
const prune = vi.fn()

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useConfirm: () => confirm,
  usePipelineAnalyticsPruneEvents: () => ({ isPending: false, mutate: prune }),
}))
vi.mock('../../recordings/CleanupSection', () => ({ CleanupSection: () => <div /> }))
vi.mock('../../recordings/DiskReconcileSection', () => ({ DiskReconcileSection: () => <div /> }))
vi.mock('../../recordings/migration/StorageMigrationSection', () => ({
  StorageMigrationSection: () => <div />,
}))
vi.mock('../../recordings/ExportsSection', () => ({
  ExportsSection: () => <div data-testid="all-exports-list" />,
}))

import { ArchiveTools } from '../ArchiveTools'

function renderTools(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ArchiveTools openOnMount />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ArchiveTools', () => {
  it('lists every export without a camera filter', () => {
    renderTools()
    expect(screen.getByTestId('all-exports-list')).toBeInTheDocument()
  })

  it('prune by age calls nothing when the confirm is declined', async () => {
    confirm.mockResolvedValue(false)
    renderTools()
    fireEvent.click(screen.getByRole('button', { name: 'Prune now' }))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(prune).not.toHaveBeenCalled()
  })

  it('prune by age sends the cutoff for the picked age once confirmed', async () => {
    confirm.mockResolvedValue(true)
    renderTools()
    selectOption(screen.getByLabelText('Prune events older than'), '7')
    const before = Date.now()
    fireEvent.click(screen.getByRole('button', { name: 'Prune now' }))
    await waitFor(() => expect(prune).toHaveBeenCalledTimes(1))
    const arg = prune.mock.calls[0]?.[0] as { olderThanMs: number; reason: string }
    expect(arg.reason).toBe('retention')
    expect(Math.abs(arg.olderThanMs - (before - 7 * 86_400_000))).toBeLessThan(5_000)
  })
})
