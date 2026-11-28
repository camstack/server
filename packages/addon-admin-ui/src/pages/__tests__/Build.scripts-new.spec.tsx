/**
 * "New script" opens the inline editor and keeps it open. The Code tab wrote
 * `?new=1` itself and then reported the (cleared) block id to the Build page,
 * which rewrote the URL from a router snapshot that had never seen `new` — so
 * the editor closed the moment it opened. The URL state has ONE writer.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'

vi.mock('../build/BlockEditor', () => ({
  BlockEditor: () => <div data-testid="block-editor-stub" />,
}))
vi.mock('../build/actions/ActionsTab', () => ({
  ActionsTab: () => <div data-testid="actions-body" />,
}))
vi.mock('../build/AutomationsTab', () => ({
  AutomationsTab: () => <div data-testid="automations-body" />,
}))
vi.mock('../build/CustomDeviceTab', () => ({
  CustomDeviceTab: () => <div data-testid="custom-device-body" />,
}))

vi.mock('@dominevo/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dominevo/ui-library')>()
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        actions: { list: { query: async () => [] } },
        schedulers: { list: { query: async () => [] } },
        coreBlocks: {
          list: { query: async () => ({ blocks: [] }) },
          getTypeDefs: { query: async () => ({ libs: [] }) },
          listCompositions: { query: async () => ({ state: 'loaded' as const, views: [] }) },
        },
      },
    }),
    useTemplateList: () => ({ data: [], status: 'success', refetch: vi.fn() }),
    useTemplateCreate: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useUiText: () => (key: string, fallback?: string) => fallback ?? key,
  }
})

import { ConfirmDialogProvider } from '@dominevo/ui-library'
import { BuildPage } from '../Build'

function renderBuild(path: string): void {
  window.history.replaceState(null, '', path)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ConfirmDialogProvider>
        <BrowserRouter>
          <BuildPage />
        </BrowserRouter>
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  )
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

describe('Build → Code → New script', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/build?tab=scripts')
  })

  it('the header button opens the editor and it stays open', async () => {
    renderBuild('/build?tab=scripts')
    fireEvent.click(await screen.findByTestId('build-new'))
    await settle()
    expect(screen.getByTestId('block-editor-stub')).toBeTruthy()
    expect(window.location.search).toContain('new=1')
    expect(window.location.search).not.toContain('create=')
  })
})
