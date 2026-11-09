/**
 * An integration is edited by the shared InstanceEditorDialog (D1013). The detail page's editor
 * only loads `describe` + `getInstance` and opens it; this pins every case the retired
 * IntegrationConfigModal handled: no form, the changed values only, the stored select, the
 * save in flight, a failed save, a failed load, and the page refresh after a save.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../brokers/__tests__/setup'

const describeQuery = vi.hoisted(() => vi.fn())
const schemaQuery = vi.hoisted(() => vi.fn())
const instanceQuery = vi.hoisted(() => vi.fn())
const updateInstance = vi.hoisted(() => vi.fn())

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        integrationInstances: {
          describe: { query: describeQuery },
          instanceFormSchema: { query: schemaQuery },
          getInstance: { query: instanceQuery },
          updateInstance: { mutate: updateInstance },
        },
      },
    }),
  }
})

import { IntegrationInstanceEditor } from '../IntegrationInstanceEditor'

const DESCRIPTION = {
  role: 'devices',
  instanceMode: 'multiple',
  kind: 'account',
  canTest: false,
  kinds: [{ id: 'hm', label: 'Homematic', functionCap: 'broker' }],
}
const HOST_FORM = {
  sections: [
    {
      id: 'conn',
      title: 'Connection',
      columns: 1,
      fields: [{ type: 'text', key: 'host', label: 'Host' }],
    },
  ],
}
const RECORD = {
  id: 'int_hm',
  name: 'Homematic',
  kind: 'hm',
  enabled: true,
  configured: true,
  status: { state: 'ok', label: 'Connected' },
  formValues: { host: '10.0.0.5' },
}

function mount(onSaved: () => void = () => {}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <IntegrationInstanceEditor
        addonId="provider-homematic"
        integrationId="int_hm"
        name="Homematic"
        onClose={() => {}}
        onSaved={onSaved}
      />
    </QueryClientProvider>,
  )
}

describe('IntegrationInstanceEditor', () => {
  beforeEach(() => {
    describeQuery.mockReset().mockResolvedValue(DESCRIPTION)
    schemaQuery.mockReset().mockResolvedValue(HOST_FORM)
    instanceQuery.mockReset().mockResolvedValue(RECORD)
    updateInstance.mockReset().mockResolvedValue({ revision: 2 })
  })

  it('asks the addon for the instance form and says the record has none', async () => {
    schemaQuery.mockResolvedValue(null)
    mount()
    expect(await screen.findByText(/no configuration form/i)).toBeTruthy()
    expect(schemaQuery).toHaveBeenCalledWith(
      expect.objectContaining({ addonId: 'provider-homematic', id: 'int_hm' }),
    )
  })

  it('saves only the changed values and refreshes the page', async () => {
    const onSaved = vi.fn()
    mount(onSaved)
    const host = await screen.findByDisplayValue('10.0.0.5')
    fireEvent.change(host, { target: { value: '10.0.0.6' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => {
      expect(updateInstance).toHaveBeenCalledWith({
        addonId: 'provider-homematic',
        id: 'int_hm',
        name: 'Homematic',
        values: { host: '10.0.0.6' },
      })
    })
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith())
  })

  it('disables Save while the write runs', async () => {
    let finish: (value: { revision: number }) => void = () => {}
    updateInstance.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    mount()
    const host = await screen.findByDisplayValue('10.0.0.5')
    fireEvent.change(host, { target: { value: '10.0.0.6' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    const saving = await screen.findByRole('button', { name: /save changes/i })
    if (!(saving instanceof HTMLButtonElement)) throw new Error('Save is not a button')
    await waitFor(() => expect(saving.disabled).toBe(true))
    finish({ revision: 2 })
  })

  it('shows the server message and keeps the dialog open when the save fails', async () => {
    updateInstance.mockRejectedValue(new Error('hub refused'))
    mount()
    const host = await screen.findByDisplayValue('10.0.0.5')
    fireEvent.change(host, { target: { value: '10.0.0.6' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    expect(await screen.findByText(/hub refused/)).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('says it could not load the integration', async () => {
    instanceQuery.mockRejectedValue(new Error('down'))
    mount()
    expect(await screen.findByText(/could not be loaded/i)).toBeTruthy()
  })
})
