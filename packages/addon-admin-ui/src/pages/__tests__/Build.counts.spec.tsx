/**
 * Build tab labels and the Code list.
 *  - An automation is a code block too, but it lives on the Automations tab:
 *    it is neither listed under Code nor counted there.
 *  - The Templates label carries the count of the list the tab shows; an
 *    unanswered or failed list shows no number, never 0.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'

const AUTOMATION_CODE = 'const AUTOMATION_RECIPE = {}\nexport default 1\n'
let templates: { data: unknown[] | undefined; status: string } = { data: [], status: 'success' }

vi.mock('../build/BlockEditor', () => ({ BlockEditor: () => <div /> }))
vi.mock('../build/actions/ActionsTab', () => ({ ActionsTab: () => <div /> }))
vi.mock('../build/AutomationsTab', () => ({ AutomationsTab: () => <div /> }))
vi.mock('../build/CustomDeviceTab', () => ({ CustomDeviceTab: () => <div /> }))
vi.mock('../build/templates/TemplatesTab', () => ({ TemplatesTab: () => <div /> }))

vi.mock('@dominevo/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dominevo/ui-library')>()
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        actions: { list: { query: async () => [] } },
        schedulers: { list: { query: async () => [] } },
        coreBlocks: {
          list: {
            query: async () => ({
              blocks: [
                { id: 'a', name: 'Plain', code: 'export default 1', enabled: true },
                { id: 'b', name: 'Auto', code: AUTOMATION_CODE, enabled: true },
              ],
            }),
          },
          getTypeDefs: { query: async () => ({ libs: [] }) },
          listCompositions: { query: async () => ({ state: 'loaded' as const, views: [] }) },
        },
      },
    }),
    useTemplateList: () => ({ ...templates, refetch: vi.fn() }),
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

describe('Build counts', () => {
  beforeEach(() => {
    templates = { data: [], status: 'success' }
  })

  it('Code counts and lists plain scripts only, not automations', async () => {
    renderBuild('/build?tab=scripts')
    await waitFor(() => expect(screen.getAllByText(/^Code \(1\)$/).length).toBeGreaterThan(0))
    expect(await screen.findByText('Plain')).toBeTruthy()
    expect(screen.queryByText('Auto')).toBeNull()
  })

  it('Templates shows the count of the list', async () => {
    templates = { data: [{ id: 't1' }, { id: 't2' }, { id: 't3' }], status: 'success' }
    renderBuild('/build')
    await waitFor(() => expect(screen.getAllByText(/^Templates \(3\)$/).length).toBeGreaterThan(0))
  })

  it('Templates shows no number while unanswered or failed', async () => {
    templates = { data: undefined, status: 'error' }
    renderBuild('/build')
    await waitFor(() => expect(screen.getAllByText(/^Code \(1\)$/).length).toBeGreaterThan(0))
    expect(screen.queryByText(/^Templates \(/)).toBeNull()
    expect(screen.getAllByText('Templates').length).toBeGreaterThan(0)
  })
})
