/**
 * Automations tab: an automation a group owns reads "Managed by <group>", links
 * to the group, offers no edit or delete, and a row click goes to the group.
 */
import {
  type AutomationRecipe,
  AutomationRecipeSchema,
  type CoreBlock,
  generateAutomationBlock,
} from '@camstack/types'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'

const RECIPE: AutomationRecipe = AutomationRecipeSchema.parse({
  when: { kind: 'device-fired', id: 't1', deviceId: 5656 },
  actions: [
    {
      kind: 'command',
      target: { kind: 'devices', ids: [5767] },
      actionId: 'switch.on',
    },
  ],
  ownedBy: { kind: 'group', blockId: 'grp1' },
})

function block(id: string, name: string, code: string): CoreBlock {
  return {
    id,
    name,
    code,
    enabled: true,
    placement: 'hub',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'u',
    status: 'running',
    lastChangedAt: 1,
  }
}

const OWNED = block(
  'own1',
  'Lamp — triggers',
  generateAutomationBlock({ name: 'x', recipe: RECIPE }),
)
const GROUP = block('grp1', 'Lamp', '')

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useSystem: () => ({
    trpcClient: {
      coreBlocks: {
        list: { query: () => Promise.resolve({ blocks: [GROUP, OWNED] }) },
        update: { mutate: vi.fn() },
        create: { mutate: vi.fn() },
        setEnabled: { mutate: vi.fn() },
        delete: { mutate: vi.fn() },
      },
    },
  }),
  useTemplateCreate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCoreBlocksSetEnabled: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
  useCoreBlocksGetTraces: () => ({
    data: { traces: [], lastError: null },
    error: null,
  }),
}))
vi.mock('../automation/AutomationEditor', () => ({
  AutomationEditor: () => null,
}))
vi.mock('../templates/NewAutomationChooser', () => ({
  NewAutomationChooser: () => null,
}))

import { AutomationsTab } from '../AutomationsTab'

function renderTab(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/build?tab=automations']}>
        <ConfirmDialogProvider>
          <Routes>
            <Route path="/build" element={<AutomationsTab onOpenScripts={vi.fn()} />} />
            <Route path="/build/compositions/:blockId" element={<div data-testid="group-page" />} />
          </Routes>
        </ConfirmDialogProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('an automation a group owns, in the list', () => {
  it('says which group manages it and links there', async () => {
    renderTab()
    const link = await screen.findByTestId('automation-managed-by-own1')
    expect(link.textContent).toBe('Managed by Lamp')
    expect(link.getAttribute('href')).toBe('/build/compositions/grp1')
  })

  it('a row click goes to the group, not to the quick modal', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Lamp — triggers')).toBeTruthy())
    fireEvent.click(screen.getByText('Lamp — triggers'))
    expect(await screen.findByTestId('group-page')).toBeTruthy()
    expect(screen.queryByTestId('build-quick-modal')).toBeNull()
  })
})
