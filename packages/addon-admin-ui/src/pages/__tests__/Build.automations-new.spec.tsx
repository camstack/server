/**
 * "New automation" opens the inline editor and keeps it open. The editor used
 * to close the moment it opened: the tab wrote `?new=1` itself and then asked
 * the Build page to write the URL again from a snapshot that had never seen
 * `new`. The URL state now has ONE writer.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'

const created = vi.fn()

vi.mock('../build/automation/AutomationEditor', () => ({
  AutomationEditor: (props: {
    saveError: string | null
    onSave: (input: { name: string; code: string; enabled: boolean; placement: string }) => void
    onCancel: () => void
  }) => (
    <div data-testid="automation-editor-stub">
      <button
        type="button"
        data-testid="stub-save"
        onClick={() => props.onSave({ name: 'Feed', code: 'x', enabled: true, placement: 'hub' })}
      />
      <button type="button" data-testid="stub-close" onClick={props.onCancel} />
      {props.saveError !== null && <p data-testid="stub-error">{props.saveError}</p>}
    </div>
  ),
}))
vi.mock('../build/actions/ActionsTab', () => ({
  ActionsTab: () => <div data-testid="actions-body" />,
}))
vi.mock('../build/ScriptsTab', () => ({ ScriptsTab: () => <div data-testid="scripts-body" /> }))
vi.mock('../build/CustomDeviceTab', () => ({
  CustomDeviceTab: () => <div data-testid="custom-device-body" />,
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        actions: { list: { query: async () => [] } },
        coreBlocks: {
          list: { query: async () => ({ blocks: [] }) },
          create: { mutate: (input: unknown) => created(input) },
          listCompositions: { query: async () => ({ state: 'loaded' as const, views: [] }) },
        },
      },
    }),
    useUiText: () => (key: string, fallback?: string) => fallback ?? key,
  }
})

import { ConfirmDialogProvider } from '@camstack/ui-library'
import { subscribeToasts, type LocalToast } from '../../components/ui/toast-bus'
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

/** Let every effect and router write settle before looking. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

describe('Build → Automations → New automation', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/build?tab=automations')
  })

  it('the header button opens the editor and it stays open', async () => {
    renderBuild('/build?tab=automations')
    fireEvent.click(await screen.findByTestId('build-new'))
    await settle()
    expect(screen.getByTestId('automation-editor-panel')).toBeTruthy()
    expect(window.location.search).toContain('new=1')
    expect(window.location.search).not.toContain('create=')
  })

  it('the empty-state button opens the editor and it stays open', async () => {
    renderBuild('/build?tab=automations')
    fireEvent.click(await screen.findByTestId('automation-empty-new'))
    await settle()
    expect(screen.getByTestId('automation-editor-panel')).toBeTruthy()
    expect(window.location.search).toContain('new=1')
  })

  it('Close returns to the list', async () => {
    renderBuild('/build?tab=automations&new=1')
    fireEvent.click(await screen.findByTestId('stub-close'))
    await waitFor(() => expect(screen.queryByTestId('automation-editor-panel')).toBeNull())
    expect(window.location.search).not.toContain('new=')
  })

  it('a successful save closes the editor and shows a toast', async () => {
    const toasts: LocalToast[] = []
    const stop = subscribeToasts((toast) => toasts.push(toast))
    created.mockResolvedValueOnce({ block: { id: 'blk-1', name: 'Feed' } })
    renderBuild('/build?tab=automations&new=1')
    fireEvent.click(await screen.findByTestId('stub-save'))
    await waitFor(() => expect(screen.queryByTestId('automation-editor-panel')).toBeNull())
    stop()
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.message).toBe('Feed')
    expect(window.location.search).not.toContain('new=')
  })

  it('a failed save keeps the editor open and shows the error', async () => {
    const toasts: LocalToast[] = []
    const stop = subscribeToasts((toast) => toasts.push(toast))
    created.mockRejectedValueOnce(new Error('name already used'))
    renderBuild('/build?tab=automations&new=1')
    fireEvent.click(await screen.findByTestId('stub-save'))
    expect((await screen.findByTestId('stub-error')).textContent).toBe('name already used')
    stop()
    expect(screen.getByTestId('automation-editor-panel')).toBeTruthy()
    expect(toasts).toHaveLength(0)
  })
})
