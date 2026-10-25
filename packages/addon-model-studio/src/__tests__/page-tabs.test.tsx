// @vitest-environment jsdom
/**
 * Model Studio page ARIA tabs — Catalog | Installed | Import | Logs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmDialogProvider, type AddonPageProps } from '@camstack/ui-library'
import ModelStudioPage from '../page.js'

vi.mock('../components/NodeSelector.js', () => ({
  NodeSelector: ({ selectedNodeId }: { selectedNodeId: string }) => (
    <div data-testid="node-selector">{selectedNodeId}</div>
  ),
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useClusterNodes: () => ({
      nodes: [{ id: 'hub', name: 'Hub', shortName: 'hub', isOnline: true }],
    }),
    LogStream: ({ addonId }: { addonId: string }) => (
      <div data-testid="log-stream" data-addon-id={addonId} />
    ),
  }
})

function pageTrpc(): AddonPageProps['trpc'] {
  const surface = {
    addons: {
      custom: {
        mutate: async (input: { action: string }) => {
          if (input.action === 'listCustomModels') return []
          if (input.action === 'listAvailability') return {}
          if (input.action === 'listPluginCatalogCatalog') return { entries: [], drift: [] }
          if (input.action === 'listPlusCatalogCatalog') return []
          if (input.action === 'plusCatalogPlusStatus')
            return { configured: false, keyFormatValid: false }
          if (input.action === 'tfliteSupport') return { nodes: ['hub'] }
          throw new Error(`unexpected action ${input.action}`)
        },
      },
    },
    pipelineExecutor: {
      getSchema: {
        query: async () => ({
          slots: [
            { addons: [{ id: 'object-detection', name: 'Object detection', slot: 'detector' }] },
          ],
          availableEngines: [],
          selectedEngine: {},
        }),
      },
    },
  }
  return surface as unknown as AddonPageProps['trpc']
}

function renderPage() {
  // The host (admin-ui App) provides the confirm dialog; the page uses it.
  return render(
    <ConfirmDialogProvider>
      <ModelStudioPage trpc={pageTrpc()} theme={{ isDark: true }} navigate={() => undefined} />
    </ConfirmDialogProvider>,
  )
}

function tab(name: string): HTMLElement {
  return screen.getByRole('tab', { name })
}

beforeEach(() => {
  window.history.replaceState(null, '', '/model-studio')
})

afterEach(cleanup)

describe('Model Studio page — ARIA tabs', () => {
  it('wires Catalog / Installed / Import / Logs (no Settings)', async () => {
    renderPage()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((item) => item.textContent)).toEqual(['Catalog', 'Installed', 'Import', 'Logs'])
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Library' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Convert' })).toBeNull()
    const catalog = tab('Catalog')
    expect(catalog.getAttribute('aria-selected')).toBe('true')
    expect(catalog.tabIndex).toBe(0)
    for (const other of ['Installed', 'Import', 'Logs']) {
      expect(tab(other).tabIndex).toBe(-1)
      expect(tab(other).getAttribute('aria-selected')).toBe('false')
    }
    const panel = await screen.findByRole('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe(catalog.id)
    expect(catalog.getAttribute('aria-controls')).toBe(panel.id)
    expect(await screen.findByTestId('catalog-source')).toBeTruthy()
  })

  it('moves selection with arrows; Import is Custom-only; ?tab=library → Installed; ?tab=settings → Catalog plus catalog', async () => {
    renderPage()
    const tablist = screen.getByRole('tablist', { name: 'Model Studio sections' })
    tab('Catalog').focus()
    fireEvent.keyDown(tablist, { key: 'ArrowRight' })
    await waitFor(() => {
      expect(tab('Installed').getAttribute('aria-selected')).toBe('true')
      expect(document.activeElement).toBe(tab('Installed'))
    })

    fireEvent.keyDown(tablist, { key: 'End' })
    await waitFor(() => expect(tab('Logs').getAttribute('aria-selected')).toBe('true'))
    fireEvent.keyDown(tablist, { key: 'Home' })
    await waitFor(() => expect(tab('Catalog').getAttribute('aria-selected')).toBe('true'))
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' })
    await waitFor(() => expect(tab('Logs').getAttribute('aria-selected')).toBe('true'))

    fireEvent.click(tab('Import'))
    await waitFor(() => {
      expect(tab('Import').getAttribute('aria-selected')).toBe('true')
      expect(screen.getByTestId('import-tab')).toBeTruthy()
      expect(screen.getByTestId('custom-tab')).toBeTruthy()
    })
    expect(screen.queryByTestId('import-kind')).toBeNull()
    expect(screen.queryByTestId('plugin-catalog-tab')).toBeNull()

    fireEvent.click(tab('Logs'))
    await waitFor(() => {
      expect(screen.getByTestId('logs-tab')).toBeTruthy()
      expect(screen.getByTestId('log-stream').getAttribute('data-addon-id')).toBe('model-studio')
    })

    cleanup()
    window.history.replaceState(null, '', '/model-studio?tab=convert')
    renderPage()
    await waitFor(() => expect(tab('Catalog').getAttribute('aria-selected')).toBe('true'))

    cleanup()
    window.history.replaceState(null, '', '/model-studio?tab=library')
    renderPage()
    await waitFor(() => expect(tab('Installed').getAttribute('aria-selected')).toBe('true'))

    cleanup()
    window.history.replaceState(null, '', '/model-studio?tab=settings')
    renderPage()
    await waitFor(() => {
      expect(tab('Catalog').getAttribute('aria-selected')).toBe('true')
      expect(screen.getByTestId('catalog-source').getAttribute('data-source')).toBe('frigate')
    })
  })

  it('honors Catalog ?source=plugin catalog deeplink (acquisition moved off Import)', async () => {
    window.history.replaceState(null, '', '/model-studio?source=scrypted')
    renderPage()
    await waitFor(() => {
      expect(tab('Catalog').getAttribute('aria-selected')).toBe('true')
      expect(screen.getByTestId('plugin-catalog-tab')).toBeTruthy()
    })
  })
})
