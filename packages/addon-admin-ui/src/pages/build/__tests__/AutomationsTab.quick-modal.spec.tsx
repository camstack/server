/**
 * Automations tab: a row click opens the quick modal, and only its Open button
 * goes to the editor.
 */
import type { CoreBlock } from '@camstack/types'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'

const BLOCK: CoreBlock = {
  id: 'feed',
  name: 'Feed the dog',
  code: 'const AUTOMATION_RECIPE = {}\nexport default 1\n',
  enabled: true,
  placement: 'hub',
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'u',
  status: 'running',
  lastChangedAt: 1,
}

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useSystem: () => ({
    trpcClient: {
      coreBlocks: {
        list: { query: () => Promise.resolve({ blocks: [BLOCK] }) },
        update: { mutate: vi.fn() },
        create: { mutate: vi.fn() },
        setEnabled: { mutate: vi.fn() },
        delete: { mutate: vi.fn() },
      },
    },
  }),
  useTemplateCreate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCoreBlocksSetEnabled: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useCoreBlocksGetTraces: () => ({ data: { traces: [], lastError: null }, error: null }),
}))
vi.mock('../automation/AutomationEditor', () => ({
  AutomationEditor: () => <div data-testid="automation-editor" />,
}))

vi.mock('../templates/NewAutomationChooser', () => ({ NewAutomationChooser: () => null }))

import { AutomationsTab } from '../AutomationsTab'

function renderTab(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/build?tab=automations']}>
        <ConfirmDialogProvider>
          <AutomationsTab onOpenScripts={vi.fn()} />
        </ConfirmDialogProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('AutomationsTab row click', () => {
  it('opens the quick modal, not the editor; Open goes to the editor', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Feed the dog')).toBeTruthy())
    fireEvent.click(screen.getByText('Feed the dog'))
    expect(screen.getByTestId('build-quick-modal')).toBeTruthy()
    expect(screen.queryByTestId('automation-editor')).toBeNull()
    fireEvent.click(screen.getByTestId('quick-modal-open'))
    await waitFor(() => expect(screen.getByTestId('automation-editor')).toBeTruthy())
  })
})
