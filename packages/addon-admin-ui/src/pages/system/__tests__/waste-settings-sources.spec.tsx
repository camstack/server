// @vitest-environment jsdom
/**
 * Waste Settings — Country → Service picker; id derived from label (no id field).
 */
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ROWS = [
  {
    id: 'home-zew',
    label: 'Home ZEW',
    module: 'abfallnavi_de',
    enabled: true,
    serviceId: 'abfallnavi_de--zew2',
    countryId: 'germany',
    formValues: { label: 'Home ZEW', enabled: true, ort: 'Düren', strasse: '' },
  },
] as const

const customMutate = vi.fn(async (args: { action: string; input: Record<string, unknown> }) => {
  if (args.action === 'listSources') return ROWS
  if (args.action === 'listCountries') {
    return [
      { id: 'germany', label: 'Germany' },
      { id: 'italy', label: 'Italy' },
    ]
  }
  if (args.action === 'listServices') {
    return [
      {
        id: 'abfallnavi_de--zew2',
        label: 'AWA Entsorgungs GmbH (zew2)',
        title: 'AWA Entsorgungs GmbH',
        module: 'abfallnavi_de',
      },
      {
        id: 'junker_app--roma',
        label: 'Roma',
        title: 'Roma',
        module: 'junker_app',
      },
    ]
  }
  if (args.action === 'serviceFormSchema') {
    return {
      sections: [
        {
          id: 'identity',
          title: 'Calendar',
          columns: 2,
          fields: [
            { type: 'text', key: 'label', label: 'Label', default: 'AWA' },
            { type: 'boolean', key: 'enabled', label: 'Enabled', default: true },
          ],
        },
        {
          id: 'args',
          title: 'AWA',
          columns: 2,
          fields: [{ type: 'text', key: 'ort', label: 'ort', default: '' }],
        },
      ],
    }
  }
  if (args.action === 'createSource') return { id: 'awa-entsorgungs-gmbh' }
  if (args.action === 'updateSource') return { ok: true as const }
  if (args.action === 'deleteSource') return { ok: true as const }
  return {}
})

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useSystem: () => ({
      trpcClient: {
        addons: { custom: { mutate: customMutate } },
        capabilities: {
          getGlobalSettings: { query: async () => null },
        },
      },
    }),
  }
})

vi.mock('../../../components/settings/NodeAddonsSettingsPanel.js', () => ({
  NodeAddonsSettingsPanel: () => <div data-testid="waste-refresh-settings" />,
}))

import { WasteSettingsSources } from '../WasteSettingsSources.js'

afterEach(() => {
  cleanup()
  customMutate.mockClear()
})

beforeEach(() => {
  customMutate.mockImplementation(
    async (args: { action: string; input: Record<string, unknown> }) => {
      if (args.action === 'listSources') return ROWS
      if (args.action === 'listCountries') {
        return [
          { id: 'germany', label: 'Germany' },
          { id: 'italy', label: 'Italy' },
        ]
      }
      if (args.action === 'listServices') {
        return [
          {
            id: 'abfallnavi_de--zew2',
            label: 'AWA Entsorgungs GmbH (zew2)',
            title: 'AWA Entsorgungs GmbH',
            module: 'abfallnavi_de',
          },
        ]
      }
      if (args.action === 'serviceFormSchema') {
        return {
          sections: [
            {
              id: 'identity',
              title: 'Calendar',
              columns: 2,
              fields: [
                { type: 'text', key: 'label', label: 'Label', default: 'AWA' },
                { type: 'boolean', key: 'enabled', label: 'Enabled', default: true },
              ],
            },
            {
              id: 'args',
              title: 'AWA',
              columns: 2,
              fields: [{ type: 'text', key: 'ort', label: 'ort', default: '' }],
            },
          ],
        }
      }
      if (args.action === 'createSource') return { id: 'awa-entsorgungs-gmbh' }
      if (args.action === 'updateSource') return { ok: true as const }
      if (args.action === 'deleteSource') return { ok: true as const }
      return {}
    },
  )
})

function renderPanel(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <ConfirmDialogProvider>
        <WasteSettingsSources addonId="waste-collections" capName="calendar-source" />
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  )
}

describe('WasteSettingsSources', () => {
  it('lists by label (no id column) and Add has no source-id field', async () => {
    renderPanel()
    expect(await screen.findByTestId('waste-settings-sources')).toBeTruthy()
    expect(await screen.findByText('Home ZEW')).toBeTruthy()
    expect(screen.queryByRole('columnheader', { name: /^Id$/i })).toBeNull()
    expect(screen.getByRole('columnheader', { name: /^Label$/i })).toBeTruthy()

    fireEvent.click(screen.getByTestId('waste-sources-add'))
    const dialog = await screen.findByTestId('waste-source-editor')
    expect(within(dialog).queryByLabelText(/Source id/i)).toBeNull()
    expect(within(dialog).getByLabelText(/Country/i)).toBeTruthy()
    expect(within(dialog).getByLabelText(/Service/i)).toBeTruthy()
    expect(within(dialog).queryByText(/Args \(JSON/i)).toBeNull()
  })

  it('Save create omits id — server derives it from label', async () => {
    renderPanel()
    fireEvent.click(await screen.findByTestId('waste-sources-add'))
    const dialog = await screen.findByTestId('waste-source-editor')
    fireEvent.change(within(dialog).getByLabelText(/Country/i), {
      target: { value: 'germany' },
    })
    await waitFor(() => {
      expect(customMutate).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'listServices', input: { countryId: 'germany' } }),
      )
    })
    await waitFor(() => {
      const serviceSelect = within(dialog).getByLabelText(/Service/i) as HTMLSelectElement
      expect([...serviceSelect.options].some((o) => o.value === 'abfallnavi_de--zew2')).toBe(true)
    })
    fireEvent.change(within(dialog).getByLabelText(/Service/i), {
      target: { value: 'abfallnavi_de--zew2' },
    })
    await waitFor(() => {
      expect(customMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'serviceFormSchema',
          input: { serviceId: 'abfallnavi_de--zew2' },
        }),
      )
    })
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Save' })).not.toBeDisabled()
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(customMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'createSource',
          input: expect.objectContaining({
            serviceId: 'abfallnavi_de--zew2',
            label: expect.any(String),
          }),
        }),
      )
      const createCall = customMutate.mock.calls.find((c) => c[0]?.action === 'createSource')?.[0]
      expect(createCall?.input).not.toHaveProperty('id')
    })
  })
})
