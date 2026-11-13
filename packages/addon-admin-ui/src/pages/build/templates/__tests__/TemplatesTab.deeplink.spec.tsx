import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../../../i18n'

const TEMPLATES = [
  {
    id: 'tpl-a',
    kind: 'remote',
    name: 'Alpha',
    payload: { columns: 2, rows: 1, buttons: [] },
    updatedAt: 1,
  },
  {
    id: 'tpl-b',
    kind: 'remote',
    name: 'Bravo',
    payload: { columns: 2, rows: 1, buttons: [] },
    updatedAt: 2,
  },
]

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  const idle = { mutateAsync: vi.fn(), isPending: false }
  return {
    ...actual,
    useTemplateList: () => ({ data: TEMPLATES, status: 'success', refetch: vi.fn() }),
    useTemplateCreate: () => idle,
    useTemplateUpdate: () => idle,
    useTemplateDelete: () => idle,
  }
})

vi.mock('../../../../components/remote/TemplateEditorDialog', () => ({
  TemplateEditorDialog: ({ draft }: { draft: { id: string | null; name: string } | null }) =>
    draft === null ? null : <div data-testid="editor-open">{draft.name}</div>,
}))

import { TemplatesTab } from '../TemplatesTab'

function Where(): React.ReactNode {
  return <span data-testid="search">{useLocation().search}</span>
}

function renderAt(url: string): void {
  render(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={new QueryClient()}>
        <ConfirmDialogProvider>
          <TemplatesTab />
        </ConfirmDialogProvider>
        <Where />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('Templates ?edit= deep link', () => {
  it('opens the editor on that template and clears the param', async () => {
    renderAt('/build?tab=templates&edit=tpl-b')
    await waitFor(() => expect(screen.getByTestId('editor-open').textContent).toBe('Bravo'))
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=templates'))
  })

  it('opens nothing for an unknown id, and still clears the param', async () => {
    renderAt('/build?tab=templates&edit=gone')
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=templates'))
    expect(screen.queryByTestId('editor-open')).toBeNull()
  })
})
