/**
 * A fixed row opens the provider's cluster settings with the panel's own Save / Discard bar:
 * nothing is written while the operator types, one Save writes once, closing writes nothing,
 * and a failed save keeps the edits and says so. Only the tRPC transport is stubbed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ConfigUISchemaWithValues } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const CLUSTER_FORM: ConfigUISchemaWithValues = {
  sections: [
    {
      id: 'main',
      title: 'Main',
      fields: [{ type: 'text', key: 'lokiUrl', label: 'Loki URL', value: 'http://loki' }],
    },
  ],
}
const NODE_FORM: ConfigUISchemaWithValues = {
  sections: [
    {
      id: 'node',
      title: 'Node',
      fields: [{ type: 'text', key: 'btmPath', label: 'btm path', value: '/usr/bin/btm' }],
    },
  ],
}
/** The provider serves a cluster form and a node form of one capability. */
const DECLARATIONS = [
  { cap: 'log-destination', scope: 'cluster' as const, sectionIds: ['main'] },
  { cap: 'log-destination', scope: 'node' as const, sectionIds: ['node'] },
]

const h = vi.hoisted(() => ({ update: vi.fn() }))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const noop = () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false })
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        addonSettings: {
          listScopedSettings: { query: async () => DECLARATIONS },
          getScopedSettings: {
            query: async (input: { scope: string }) =>
              input.scope === 'node' ? NODE_FORM : CLUSTER_FORM,
          },
        },
        addons: { custom: { mutate: vi.fn() } },
      },
    }),
    useAddonsList: () => ({ data: [{ manifest: { id: 'loki-logging', name: 'Loki' } }] }),
    useAddonSettingsUpdateGlobalSettings: noop,
    useAddonSettingsUpdateScopedSettings: () => ({
      mutateAsync: h.update,
      mutate: h.update,
      isPending: false,
    }),
    useAddonSettingsUpdateDeviceSettings: noop,
    useDecoderReprobeHwaccel: noop,
    useAudioAnalyzerReprobeAudioEngine: noop,
  }
})

import { FixedRowSettingsDialog } from '../FixedRowSettingsDialog'

function renderDialog(onClose: () => void = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <FixedRowSettingsDialog addonId="loki-logging" title="Loki" onClose={onClose} />
    </QueryClientProvider>,
  )
}

async function typeUrl(value: string): Promise<void> {
  const input = await screen.findByDisplayValue('http://loki')
  fireEvent.change(input, { target: { value } })
}

beforeEach(() => {
  h.update.mockReset()
  h.update.mockResolvedValue({})
})

describe('FixedRowSettingsDialog', () => {
  it('shows the cluster field and not the per-node one', async () => {
    renderDialog()
    expect(await screen.findByDisplayValue('http://loki')).toBeTruthy()
    expect(screen.queryByDisplayValue('/usr/bin/btm')).toBeNull()
  })

  it('writes nothing while typing, and exactly once on Save', async () => {
    renderDialog()
    const input = await screen.findByDisplayValue('http://loki')
    fireEvent.change(input, { target: { value: 'http://loki:31' } })
    fireEvent.change(input, { target: { value: 'http://loki:3100' } })
    expect(h.update).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.update).toHaveBeenCalledTimes(1))
    expect(h.update.mock.calls[0]?.[0]).toMatchObject({
      addonId: 'loki-logging',
      cap: 'log-destination',
      scope: 'cluster',
      patch: { lokiUrl: 'http://loki:3100' },
    })
  })

  it('writes nothing when the dialog is closed with unsaved edits', async () => {
    const onClose = vi.fn()
    renderDialog(onClose)
    await typeUrl('http://elsewhere')
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(h.update).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('keeps the edits and shows the error when the save fails', async () => {
    h.update.mockRejectedValue(new Error('provider refused'))
    renderDialog()
    await typeUrl('http://bad')
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/provider refused/)).toBeTruthy()
    expect(screen.getByDisplayValue('http://bad')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })
})
