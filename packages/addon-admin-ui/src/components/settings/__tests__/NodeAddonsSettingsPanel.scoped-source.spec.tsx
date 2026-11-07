/**
 * The generic settings panel reads its addon through the SCOPED source (D986 §7):
 * `listScopedSettings` names what the addon serves, `getScopedSettings` reads each
 * (cap, scope), and a Save lands on the (cap, scope) that declared each key.
 *
 * Only the tRPC transport is stubbed; the selection, the merge, the dedupe, the save bar and
 * the empty/unavailable states are shipping code.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigUISchemaWithValues } from '@camstack/types'

function form(
  sectionId: string,
  key: string,
  label: string,
  value: string,
): ConfigUISchemaWithValues['sections'][number] {
  return { id: sectionId, title: sectionId, fields: [{ type: 'text', key, label, value }] }
}

/** cap-a and cap-b both answer a `shared` section; each also has one of its own. */
const FORMS: Readonly<Record<string, ConfigUISchemaWithValues>> = {
  'cap-a:cluster': {
    sections: [
      form('shared', 'sharedKey', 'Shared from A', 'a-value'),
      form('only-a', 'aKey', 'Only A', 'a1'),
    ],
  },
  'cap-b:cluster': {
    sections: [
      form('shared', 'sharedKey', 'Shared from B', 'b-value'),
      form('only-b', 'bKey', 'Only B', 'b1'),
    ],
  },
  'cap-b:node': { sections: [form('node-b', 'nodeKey', 'Node B', 'n1')] },
}

const TWO_CAP_ADDON = [
  { cap: 'cap-a', scope: 'cluster' as const, sectionIds: ['shared', 'only-a'] },
  { cap: 'cap-b', scope: 'cluster' as const, sectionIds: ['shared', 'only-b'] },
  { cap: 'cap-b', scope: 'node' as const, sectionIds: ['node-b'] },
]

let listed: ReadonlyArray<(typeof TWO_CAP_ADDON)[number]> | null = TWO_CAP_ADDON
const listScopedSettings = vi.fn(async () => listed)
const getScopedSettings = vi.fn(async (input: { cap: string; scope: string }) => {
  return FORMS[`${input.cap}:${input.scope}`] ?? null
})
const updateScopedSettings = vi.fn(async (_input: unknown) => ({ success: true }))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const noop = () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false })
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        addonSettings: {
          listScopedSettings: { query: listScopedSettings },
          getScopedSettings: { query: getScopedSettings },
        },
        addons: { custom: { mutate: vi.fn() } },
      },
    }),
    useAddonsList: () => ({ data: [{ manifest: { id: 'multi', name: 'Multi' } }] }),
    useAddonSettingsUpdateGlobalSettings: noop,
    useAddonSettingsUpdateScopedSettings: () => ({
      mutateAsync: updateScopedSettings,
      mutate: updateScopedSettings,
      isPending: false,
    }),
    useAddonSettingsUpdateDeviceSettings: noop,
    useDecoderReprobeHwaccel: noop,
    useAudioAnalyzerReprobeAudioEngine: noop,
  }
})

import { NodeAddonsSettingsPanel } from '../NodeAddonsSettingsPanel'

function renderPanel(props: Partial<React.ComponentProps<typeof NodeAddonsSettingsPanel>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <NodeAddonsSettingsPanel
        nodeId="hub"
        addonIds={['multi']}
        level="global"
        emptyMessage="nothing here"
        {...props}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  listed = TWO_CAP_ADDON
})

describe('a section two (cap, scope) pairs both serve', () => {
  it('is shown once, from the first pair in declaration order', async () => {
    renderPanel()
    expect(await screen.findByText('Shared from A')).toBeTruthy()
    expect(screen.getByText('Only A')).toBeTruthy()
    expect(screen.getByText('Only B')).toBeTruthy()
    expect(screen.getByText('Node B')).toBeTruthy()
    expect(screen.queryByText('Shared from B')).toBeNull()
    expect(screen.getAllByText('Shared from A')).toHaveLength(1)
  })
})

describe('omitSectionIds', () => {
  it('hides the section and never fetches a pair left with nothing to show', async () => {
    renderPanel({ omitSectionIds: ['only-b', 'shared', 'only-a'] })
    await screen.findByText('Node B')
    expect(screen.queryByText('Only B')).toBeNull()
    expect(screen.queryByText('Shared from A')).toBeNull()
    expect(getScopedSettings).toHaveBeenCalledTimes(1)
    expect(getScopedSettings).toHaveBeenCalledWith(
      expect.objectContaining({ cap: 'cap-b', scope: 'node' }),
    )
  })
})

describe('fieldScope perNode under a node', () => {
  it('reads the node scope for THAT node and nothing else', async () => {
    renderPanel({ nodeId: 'agent-a', fieldScope: 'perNode' })
    expect(await screen.findByText('Node B')).toBeTruthy()
    expect(getScopedSettings).toHaveBeenCalledTimes(1)
    expect(getScopedSettings).toHaveBeenCalledWith({
      addonId: 'multi',
      cap: 'cap-b',
      scope: 'node',
      nodeId: 'agent-a',
    })
    expect(screen.queryByText('Only A')).toBeNull()
  })
})

describe('an addon that could not be asked', () => {
  it('says "not available" for a null listing, never the empty message', async () => {
    listed = null
    renderPanel()
    expect(await screen.findByText('Multi not available.')).toBeTruthy()
    expect(screen.queryByText('nothing here')).toBeNull()
  })

  it('says the empty message for an addon that serves nothing', async () => {
    listed = []
    renderPanel()
    expect(await screen.findByText('nothing here')).toBeTruthy()
    expect(screen.queryByText(/not available/)).toBeNull()
  })
})

describe('the Save bar', () => {
  it('writes a pending patch to updateScopedSettings, split per owning (cap, scope)', async () => {
    renderPanel({ nodeId: 'agent-a' })
    fireEvent.change(await screen.findByDisplayValue('a-value'), { target: { value: 'a2' } })
    fireEvent.change(screen.getByDisplayValue('b1'), { target: { value: 'b2' } })
    fireEvent.change(screen.getByDisplayValue('n1'), { target: { value: 'n2' } })
    expect(updateScopedSettings).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateScopedSettings).toHaveBeenCalledTimes(3))
    const sent = updateScopedSettings.mock.calls.map(([input]) => input)
    expect(sent).toContainEqual({
      addonId: 'multi',
      cap: 'cap-a',
      scope: 'cluster',
      patch: { sharedKey: 'a2' },
    })
    expect(sent).toContainEqual({
      addonId: 'multi',
      cap: 'cap-b',
      scope: 'cluster',
      patch: { bKey: 'b2' },
    })
    expect(sent).toContainEqual({
      addonId: 'multi',
      cap: 'cap-b',
      scope: 'node',
      nodeId: 'agent-a',
      patch: { nodeKey: 'n2' },
    })
  })
})
